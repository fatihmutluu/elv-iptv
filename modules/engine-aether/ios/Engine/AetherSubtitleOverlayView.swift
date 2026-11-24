import AetherEngine
import AVFoundation
import UIKit

private final class SlotPillView: UIView {
  let label = UILabel(frame: .zero)

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = UIColor.black.withAlphaComponent(0.74)
    layer.cornerRadius = 8
    layer.masksToBounds = true
    isHidden = true
    isUserInteractionEnabled = false
    isAccessibilityElement = false

    label.numberOfLines = 0
    label.textColor = .white
    label.backgroundColor = .clear
    label.isUserInteractionEnabled = false
    label.isAccessibilityElement = false
    addSubview(label)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var canBecomeFocused: Bool { false }
}

/// Unfocusable, non-interactive overlay rendering 9-slot ASS/external text (`SRT`, `ASS`/`SSA`, `TTML`,
/// `mov_text`, `WebVTT`), simultaneous top-center secondary subtitles (`#402`), and bitmap (`PGS`, `DVB`, `DVD`)
/// cues inside the visible video stage on iOS, iPadOS, and tvOS (`#285`, `#32`, `#402`).
final class AetherSubtitleOverlayView: UIView {
  private let bitmapContainer = UIView(frame: .zero)
  private var bitmapViews: [UIImageView] = []
  private var slotViews: [SubtitleSlot: SlotPillView] = [:]
  private var presentation: SubtitlePresentation = .empty
  private var bottomInset: CGFloat = 0
  private let captionAppearanceSource = SystemCaptionAppearanceSource()
  private var systemCaptionStyle: CaptionAppearanceStyle
  private var userSubtitleStyle: UserSubtitleStyleOverride?
  private var captionStyle: CaptionAppearanceStyle
  private var subtitleFontFamily: String?
  private var captionObserver: SystemCaptionAppearanceObserver?
  private var voiceOverDeduper = VoiceOverAnnouncementDeduper()

  override init(frame: CGRect) {
    let initialSystemStyle = resolveCaptionAppearance(source: captionAppearanceSource)
    self.systemCaptionStyle = initialSystemStyle
    self.captionStyle = initialSystemStyle
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = true
    isUserInteractionEnabled = false
    isAccessibilityElement = false

    bitmapContainer.backgroundColor = .clear
    bitmapContainer.isUserInteractionEnabled = false
    bitmapContainer.isAccessibilityElement = false
    addSubview(bitmapContainer)

    captionObserver = SystemCaptionAppearanceObserver { [weak self] in
      self?.refreshCaptionStyle()
    }
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var canBecomeFocused: Bool { false }

  override func layoutSubviews() {
    super.layoutSubviews()
    bitmapContainer.frame = bounds
    layoutPresentation()
  }

  func apply(_ next: SubtitlePresentation) {
    guard next != presentation else { return }
    presentation = next
    announceVoiceOverIfNeeded(for: next)
    rebuildBitmaps()
    setNeedsLayout()
  }

  func updateGravity(_ gravity: AVLayerVideoGravity) {
    guard presentation.gravity != gravity else { return }
    presentation.gravity = gravity
    setNeedsLayout()
  }

  func updateBottomInset(_ inset: CGFloat) {
    let clean: CGFloat = (inset.isFinite && inset > 0) ? inset : 0
    guard clean != bottomInset else { return }
    bottomInset = clean
    setNeedsLayout()
  }

  func updateSubtitleFontFamily(_ family: String?) {
    subtitleFontFamily = family
    applyResolvedCaptionStyle()
  }

  /// Updates user subtitle appearance live without restarting playback (`#32`).
  func updateSubtitleStyle(_ style: UserSubtitleStyleOverride?) {
    guard style != userSubtitleStyle else { return }
    userSubtitleStyle = style
    applyResolvedCaptionStyle()
  }

  func clear() {
    voiceOverDeduper.reset()
    apply(.empty)
  }

  private func refreshCaptionStyle() {
    systemCaptionStyle = resolveCaptionAppearance(source: captionAppearanceSource)
    applyResolvedCaptionStyle()
  }

  private func applyResolvedCaptionStyle() {
    let withUser = applyingUserSubtitleStyle(systemCaptionStyle, override: userSubtitleStyle)
    let updated = applyingSubtitleFontOverride(withUser, family: subtitleFontFamily)
    guard updated != captionStyle else { return }
    captionStyle = updated
    let pillBg = (updated.window ?? updated.background).uiColor
    for pill in slotViews.values {
      pill.backgroundColor = pillBg
    }
    setNeedsLayout()
  }

  private func announceVoiceOverIfNeeded(for next: SubtitlePresentation) {
    let filterSdh = next.filterSdhSubtitles
    var lines: [String] = []
    collectPlainLines(from: next.cues, filterSdh: filterSdh, into: &lines)
    for ext in next.externalPrimaryCues {
      let text = filterSdh ? SubtitlePresentation.stripSdhAnnotations(ext.text) : ext.text
      if !text.isEmpty { lines.append(text) }
    }
    if lines.isEmpty {
      collectPlainLines(from: next.secondaryCues, filterSdh: filterSdh, into: &lines)
      for ext in next.externalSecondaryCues {
        let text = filterSdh ? SubtitlePresentation.stripSdhAnnotations(ext.text) : ext.text
        if !text.isEmpty { lines.append(text) }
      }
    }
    guard let announcement = voiceOverDeduper.nextAnnouncement(for: lines) else { return }
    if UIAccessibility.isVoiceOverRunning {
      UIAccessibility.post(notification: .announcement, argument: announcement)
    }
  }

  private func collectPlainLines(from cues: [SubtitleCue], filterSdh: Bool, into lines: inout [String]) {
    for cue in cues {
      switch cue.body {
      case let .text(raw):
        let text = filterSdh ? SubtitlePresentation.stripSdhAnnotations(raw) : raw
        if !text.isEmpty { lines.append(text) }
      case let .richText(runs):
        let joined = runs.map(\.text).joined()
        let text = filterSdh ? SubtitlePresentation.stripSdhAnnotations(joined) : joined
        if !text.isEmpty { lines.append(text) }
      case .image:
        break
      }
    }
  }

  private func rebuildBitmaps() {
    if !presentation.hasAnyCues {
      for view in bitmapViews {
        view.image = nil
        view.removeFromSuperview()
      }
      bitmapViews.removeAll()
      hideAllSlots()
      return
    }

    var images: [SubtitleImage] = []
    for cue in presentation.cues {
      if case let .image(img) = cue.body {
        images.append(img)
      }
    }

    while bitmapViews.count < images.count {
      let imageView = UIImageView(frame: .zero)
      imageView.contentMode = .scaleToFill
      imageView.isUserInteractionEnabled = false
      imageView.isAccessibilityElement = false
      bitmapContainer.addSubview(imageView)
      bitmapViews.append(imageView)
    }

    for (idx, view) in bitmapViews.enumerated() {
      if idx < images.count {
        view.image = UIImage(cgImage: images[idx].cgImage)
        view.isHidden = false
      } else {
        view.image = nil
        view.isHidden = true
      }
    }
  }

  private func layoutPresentation() {
    guard bounds.width > 0, bounds.height > 0, presentation.hasAnyCues else {
      hideAllSlots()
      for view in bitmapViews { view.isHidden = true }
      return
    }

    let boundsRect = Self.toLayoutRect(bounds)
    let videoSize = LayoutSize(width: Double(presentation.videoSize.width), height: Double(presentation.videoSize.height))
    let scaleMode: VideoScaleMode
    switch presentation.gravity {
    case .resizeAspectFill:
      scaleMode = .fill
    case .resize:
      scaleMode = .stretch
    default:
      scaleMode = .fit
    }
    let videoRect = SubtitleLayout.computeVideoRect(in: boundsRect, videoSize: videoSize, scaleMode: scaleMode)
    guard videoRect.width > 0, videoRect.height > 0 else {
      hideAllSlots()
      return
    }

    let visibleStage = SubtitleLayout.visibleTextStage(videoRect: videoRect, bounds: boundsRect)
    let rawFontSize = SubtitleLayout.baseFontSize(for: visibleStage) * captionStyle.relativeCharacterSize
    let fontSize = CGFloat(min(max(8, rawFontSize), max(8, visibleStage.height * 0.45)))
    let hasSecondary = !presentation.secondaryCues.isEmpty || !presentation.externalSecondaryCues.isEmpty
    let defaultPrimarySlot: SubtitleSlot =
      (captionStyle.verticalPosition == .top && !hasSecondary) ? .topCenter : .bottomCenter

    var bitmapIdx = 0
    var plainLinesBySlot: [SubtitleSlot: [String]] = [:]
    var richBlocksBySlot: [SubtitleSlot: [NSAttributedString]] = [:]
    var seenRichTextBySlot: [SubtitleSlot: Set<String>] = [:]

    for cue in presentation.cues {
      switch cue.body {
      case let .image(img):
        guard bitmapIdx < bitmapViews.count else { break }
        let canvas = SubtitleLayout.computeCanvasRect(
          canvasSize: LayoutSize(width: Double(img.canvasSize.width), height: Double(img.canvasSize.height)),
          videoSize: videoSize,
          videoRect: videoRect
        )
        bitmapViews[bitmapIdx].frame = CGRect(
          x: CGFloat(canvas.minX) + img.position.minX * CGFloat(canvas.width),
          y: CGFloat(canvas.minY) + img.position.minY * CGFloat(canvas.height),
          width: img.position.width * CGFloat(canvas.width),
          height: img.position.height * CGFloat(canvas.height)
        )
        bitmapViews[bitmapIdx].isHidden = false
        bitmapIdx += 1

      case let .text(raw):
        let cleaned = presentation.filterSdhSubtitles
          ? SubtitlePresentation.stripSdhAnnotations(raw)
          : raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleaned.isEmpty else { break }
        let slot = resolvedPrimarySlot(for: cue.placement?.alignment, defaultSlot: defaultPrimarySlot, reserveTopCenter: hasSecondary)
        plainLinesBySlot[slot, default: []].append(cleaned)

      case let .richText(runs):
        let slot = resolvedPrimarySlot(for: cue.placement?.alignment, defaultSlot: defaultPrimarySlot, reserveTopCenter: hasSecondary)
        let combined = runs.map(\.text).joined()
        if presentation.filterSdhSubtitles {
          let cleaned = SubtitlePresentation.stripSdhAnnotations(combined)
          guard !cleaned.isEmpty else { break }
          if cleaned == combined.trimmingCharacters(in: .whitespacesAndNewlines) {
            if seenRichTextBySlot[slot, default: []].insert(cleaned).inserted,
               let styled = SubtitleTextStyling.makeRichString(runs: runs, fontSize: fontSize, slot: slot, style: captionStyle)
            {
              richBlocksBySlot[slot, default: []].append(styled)
            }
          } else {
            plainLinesBySlot[slot, default: []].append(cleaned)
          }
        } else {
          let key = combined.trimmingCharacters(in: .whitespacesAndNewlines)
          guard !key.isEmpty, seenRichTextBySlot[slot, default: []].insert(key).inserted else { break }
          if let styled = SubtitleTextStyling.makeRichString(runs: runs, fontSize: fontSize, slot: slot, style: captionStyle) {
            richBlocksBySlot[slot, default: []].append(styled)
          }
        }
      }
    }

    // External primary cues render in the primary default slot (never colliding with secondary `.topCenter`).
    for ext in presentation.externalPrimaryCues {
      let cleaned = presentation.filterSdhSubtitles
        ? SubtitlePresentation.stripSdhAnnotations(ext.text)
        : ext.text.trimmingCharacters(in: .whitespacesAndNewlines)
      if !cleaned.isEmpty {
        plainLinesBySlot[defaultPrimarySlot, default: []].append(cleaned)
      }
    }

    // Secondary cues (`#402`) are strictly pinned to `.topCenter`.
    if hasSecondary {
      var secondaryLines: [String] = []
      collectPlainLines(from: presentation.secondaryCues, filterSdh: presentation.filterSdhSubtitles, into: &secondaryLines)
      for ext in presentation.externalSecondaryCues {
        let cleaned = presentation.filterSdhSubtitles
          ? SubtitlePresentation.stripSdhAnnotations(ext.text)
          : ext.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty {
          secondaryLines.append(cleaned)
        }
      }
      if !secondaryLines.isEmpty {
        plainLinesBySlot[.topCenter] = secondaryLines
        richBlocksBySlot[.topCenter] = nil
      }
    }

    guard visibleStage.width > 0, visibleStage.height > 0 else {
      hideAllSlots()
      return
    }

    let pillBackgroundColor = (captionStyle.window ?? captionStyle.background).uiColor
    let raisedLift = captionStyle.verticalPosition == .raised ? visibleStage.height * 0.14 : 0
    let effectiveBottomInset = Double(bottomInset) + raisedLift

    for slot in SubtitleSlot.allCases {
      var blocks: [NSAttributedString] = []
      if let rawLines = plainLinesBySlot[slot], !rawLines.isEmpty {
        let merged = SubtitleBidi.mergeOverlappingLines(rawLines)
        if !merged.isEmpty {
          blocks.append(
            SubtitleTextStyling.makeStyledString(text: merged, fontSize: fontSize, slot: slot, style: captionStyle)
          )
        }
      }
      if let rich = richBlocksBySlot[slot], !rich.isEmpty {
        blocks.append(contentsOf: rich)
      }
      guard !blocks.isEmpty else {
        if let existing = slotViews[slot] {
          existing.isHidden = true
          existing.label.attributedText = nil
        }
        continue
      }

      let pill = ensureSlotView(for: slot)
      pill.backgroundColor = pillBackgroundColor
      let combined = NSMutableAttributedString()
      for (idx, block) in blocks.enumerated() {
        if idx > 0 {
          combined.append(
            SubtitleTextStyling.makeStyledString(text: "\n", fontSize: fontSize, slot: slot, style: captionStyle)
          )
        }
        combined.append(block)
      }
      pill.label.textAlignment = SubtitleTextStyling.textAlignment(for: slot)
      pill.label.attributedText = combined

      let box = SubtitleLayout.measurementBox(slot: slot, visibleStage: visibleStage, fontSize: Double(fontSize))
      let measured = pill.label.sizeThatFits(CGSize(width: box.width, height: box.height))
      let placed = SubtitleLayout.placeSlotPill(
        slot: slot,
        visibleStage: visibleStage,
        measuredTextSize: LayoutSize(width: Double(measured.width), height: Double(measured.height)),
        fontSize: Double(fontSize),
        bottomInset: effectiveBottomInset
      )
      pill.frame = Self.toCGRect(placed.pillFrame)
      pill.label.frame = Self.toCGRect(placed.labelFrame)
      pill.isHidden = false
    }
  }

  private func resolvedPrimarySlot(
    for assAlignment: Int?,
    defaultSlot: SubtitleSlot,
    reserveTopCenter: Bool
  ) -> SubtitleSlot {
    let slot = assAlignment.map { SubtitleSlot.from(assAlignment: $0) } ?? defaultSlot
    if reserveTopCenter && slot == .topCenter {
      return .bottomCenter
    }
    return slot
  }

  private func ensureSlotView(for slot: SubtitleSlot) -> SlotPillView {
    if let existing = slotViews[slot] {
      return existing
    }
    let created = SlotPillView(frame: .zero)
    slotViews[slot] = created
    addSubview(created)
    return created
  }

  private func hideAllSlots() {
    for pill in slotViews.values {
      pill.isHidden = true
      pill.label.attributedText = nil
    }
  }

  private static func toLayoutRect(_ rect: CGRect) -> LayoutRect {
    LayoutRect(x: Double(rect.origin.x), y: Double(rect.origin.y), width: Double(rect.size.width), height: Double(rect.size.height))
  }

  private static func toCGRect(_ rect: LayoutRect) -> CGRect {
    CGRect(x: rect.x, y: rect.y, width: rect.width, height: rect.height)
  }
}

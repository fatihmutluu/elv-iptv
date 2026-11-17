import AetherEngine
import AVFoundation
import UIKit

/// Snapshot of active subtitle cues and picture geometry rendered above `AetherPlayerView` and below `shutterView`.
struct SubtitlePresentation: Equatable {
  static let empty = SubtitlePresentation(cues: [], videoSize: .zero, gravity: .resizeAspect)

  var cues: [SubtitleCue]
  var videoSize: CGSize
  var gravity: AVLayerVideoGravity
}

/// Unfocusable, non-interactive overlay rendering embedded text (`SRT`, `ASS`/`SSA`, `mov_text`, `WebVTT`)
/// and bitmap (`PGS`, `DVB`, `DVD`) `SubtitleCue`s inside the fitted video rectangle on iOS, iPadOS, and tvOS.
final class AetherSubtitleOverlayView: UIView {
  private let textPill = UIView(frame: .zero)
  private let textLabel = UILabel(frame: .zero)
  private var bitmapViews: [UIImageView] = []
  private var presentation: SubtitlePresentation = .empty

  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .clear
    clipsToBounds = true
    isUserInteractionEnabled = false
    isAccessibilityElement = false

    textPill.backgroundColor = UIColor.black.withAlphaComponent(0.74)
    textPill.layer.cornerRadius = 8
    textPill.layer.masksToBounds = true
    textPill.isHidden = true
    textPill.isUserInteractionEnabled = false
    textPill.isAccessibilityElement = false

    textLabel.numberOfLines = 0
    textLabel.textAlignment = .center
    textLabel.textColor = .white
    textLabel.backgroundColor = .clear
    textLabel.isUserInteractionEnabled = false
    textLabel.isAccessibilityElement = false

    textPill.addSubview(textLabel)
    addSubview(textPill)
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var canBecomeFocused: Bool {
    false
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layoutPresentation()
  }

  func apply(_ next: SubtitlePresentation) {
    guard next != presentation else { return }
    presentation = next
    rebuildContent()
    setNeedsLayout()
    layoutIfNeeded()
  }

  func updateGravity(_ gravity: AVLayerVideoGravity) {
    guard presentation.gravity != gravity else { return }
    presentation.gravity = gravity
    setNeedsLayout()
  }

  func clear() {
    apply(.empty)
  }

  private func rebuildContent() {
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
      insertSubview(imageView, belowSubview: textPill)
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

    setNeedsLayout()
  }

  private func layoutPresentation() {
    guard bounds.width > 0, bounds.height > 0, !presentation.cues.isEmpty else {
      textPill.isHidden = true
      for view in bitmapViews { view.isHidden = true }
      return
    }

    let videoRect = Self.computeVideoRect(
      in: bounds,
      videoSize: presentation.videoSize,
      gravity: presentation.gravity
    )
    guard videoRect.width > 0, videoRect.height > 0 else {
      textPill.isHidden = true
      return
    }

    var bitmapIdx = 0
    var textBlocks: [NSAttributedString] = []
    let baseFontSize = min(max(videoRect.height * 0.044, 16), 52)

    for cue in presentation.cues {
      switch cue.body {
      case let .image(img):
        guard bitmapIdx < bitmapViews.count else { break }
        let canvas = Self.computeCanvasRect(
          canvasSize: img.canvasSize,
          videoSize: presentation.videoSize,
          videoRect: videoRect
        )
        bitmapViews[bitmapIdx].frame = CGRect(
          x: canvas.minX + img.position.minX * canvas.width,
          y: canvas.minY + img.position.minY * canvas.height,
          width: img.position.width * canvas.width,
          height: img.position.height * canvas.height
        )
        bitmapViews[bitmapIdx].isHidden = false
        bitmapIdx += 1

      case let .text(raw):
        let cleaned = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty {
          textBlocks.append(Self.makeStyledString(text: cleaned, fontSize: baseFontSize))
        }

      case let .richText(runs):
        let styled = Self.makeRichString(runs: runs, fontSize: baseFontSize)
        if styled.length > 0 {
          textBlocks.append(styled)
        }
      }
    }

    if textBlocks.isEmpty {
      textPill.isHidden = true
      textLabel.attributedText = nil
      return
    }

    let combined = NSMutableAttributedString()
    for (idx, block) in textBlocks.enumerated() {
      if idx > 0 {
        combined.append(Self.makeStyledString(text: "\n", fontSize: baseFontSize))
      }
      combined.append(block)
    }
    textLabel.attributedText = combined

    let padX = max(12, baseFontSize * 0.45)
    let padY = max(6, baseFontSize * 0.24)
    let maxLabelWidth = max(60, (videoRect.width * 0.86) - (padX * 2))
    let measured = textLabel.sizeThatFits(CGSize(width: maxLabelWidth, height: videoRect.height * 0.45))
    let pillWidth = min(videoRect.width * 0.92, ceil(measured.width) + padX * 2)
    let pillHeight = ceil(measured.height) + padY * 2
    let bottomMargin = max(16, videoRect.height * 0.06)

    textPill.frame = CGRect(
      x: videoRect.midX - pillWidth / 2,
      y: max(videoRect.minY + 8, videoRect.maxY - bottomMargin - pillHeight),
      width: pillWidth,
      height: pillHeight
    )
    textLabel.frame = CGRect(
      x: padX,
      y: padY,
      width: pillWidth - padX * 2,
      height: pillHeight - padY * 2
    )
    textPill.isHidden = false
  }

  private static func computeVideoRect(
    in bounds: CGRect,
    videoSize: CGSize,
    gravity: AVLayerVideoGravity
  ) -> CGRect {
    guard videoSize.width > 0, videoSize.height > 0 else { return bounds }
    if gravity == .resizeAspectFill {
      let scale = max(bounds.width / videoSize.width, bounds.height / videoSize.height)
      let width = videoSize.width * scale
      let height = videoSize.height * scale
      return CGRect(
        x: bounds.midX - width / 2,
        y: bounds.midY - height / 2,
        width: width,
        height: height
      )
    }
    return AVMakeRect(aspectRatio: videoSize, insideRect: bounds)
  }

  private static func computeCanvasRect(
    canvasSize: CGSize,
    videoSize: CGSize,
    videoRect: CGRect
  ) -> CGRect {
    guard canvasSize.width > 0, canvasSize.height > 0 else { return videoRect }
    let canvasHeight: CGFloat
    if videoSize.width > 0, videoSize.height > 0 {
      let codedScaledHeight = canvasSize.height * (videoSize.width / canvasSize.width)
      canvasHeight = videoRect.height * (codedScaledHeight / videoSize.height)
    } else {
      canvasHeight = videoRect.width * (canvasSize.height / canvasSize.width)
    }
    return CGRect(
      x: videoRect.minX,
      y: videoRect.midY - canvasHeight / 2,
      width: videoRect.width,
      height: canvasHeight
    )
  }

  private static func makeStyledString(text: String, fontSize: CGFloat) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    paragraph.lineBreakMode = .byWordWrapping
    let attrs: [NSAttributedString.Key: Any] = [
      .font: UIFont.systemFont(ofSize: fontSize, weight: .semibold),
      .foregroundColor: UIColor.white,
      .paragraphStyle: paragraph,
    ]
    return NSAttributedString(string: text, attributes: attrs)
  }

  private static func makeRichString(runs: [SubtitleTextRun], fontSize: CGFloat) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    paragraph.lineBreakMode = .byWordWrapping

    let out = NSMutableAttributedString()
    for run in runs where !run.text.isEmpty {
      var font = UIFont.systemFont(ofSize: fontSize, weight: run.isBold ? .bold : .semibold)
      if run.isItalic, let descriptor = font.fontDescriptor.withSymbolicTraits(
        run.isBold ? [.traitBold, .traitItalic] : [.traitItalic]
      ) {
        font = UIFont(descriptor: descriptor, size: fontSize)
      }
      let color: UIColor
      if let rgb = run.color {
        color = UIColor(
          red: CGFloat(rgb.r) / 255.0,
          green: CGFloat(rgb.g) / 255.0,
          blue: CGFloat(rgb.b) / 255.0,
          alpha: 1.0
        )
      } else {
        color = .white
      }
      var attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color,
        .paragraphStyle: paragraph,
      ]
      if run.isUnderlined {
        attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue
      }
      if run.isStruckThrough {
        attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue
      }
      out.append(NSAttributedString(string: run.text, attributes: attrs))
    }
    return out
  }
}

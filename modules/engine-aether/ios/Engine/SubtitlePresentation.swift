import AetherEngine
import AVFoundation
import UIKit

/// Snapshot of active subtitle cues and picture geometry rendered above `AetherPlayerView` and below `shutterView`.
struct SubtitlePresentation: Equatable {
  static let empty = SubtitlePresentation(cues: [], videoSize: .zero, gravity: .resizeAspect, filterSdhSubtitles: false)

  /// Strips SDH / Hearing-Impaired annotations from plain or joined rich subtitle text (`#310`).
  static func stripSdhAnnotations(_ text: String) -> String {
    SdhSubtitleFilter.stripSdhAnnotations(text)
  }

  var cues: [SubtitleCue]
  var videoSize: CGSize
  var gravity: AVLayerVideoGravity
  var filterSdhSubtitles: Bool = false

  static func == (lhs: SubtitlePresentation, rhs: SubtitlePresentation) -> Bool {
    guard lhs.videoSize == rhs.videoSize,
          lhs.gravity == rhs.gravity,
          lhs.filterSdhSubtitles == rhs.filterSdhSubtitles,
          lhs.cues.count == rhs.cues.count
    else {
      return false
    }
    for (a, b) in zip(lhs.cues, rhs.cues) {
      guard a.id == b.id,
            a.startTime == b.startTime,
            a.endTime == b.endTime,
            a.placement == b.placement,
            sameBody(a.body, b.body)
      else {
        return false
      }
    }
    return true
  }

  private static func sameBody(_ lhs: SubtitleCue.Body, _ rhs: SubtitleCue.Body) -> Bool {
    switch (lhs, rhs) {
    case let (.text(a), .text(b)):
      return a == b
    case let (.richText(a), .richText(b)):
      return a == b
    case let (.image(a), .image(b)):
      return a.cgImage === b.cgImage
        && a.position == b.position
        && a.canvasSize == b.canvasSize
        && a.isForced == b.isForced
    default:
      return false
    }
  }
}

extension CaptionAppearanceColor {
  var uiColor: UIColor {
    UIColor(red: CGFloat(red), green: CGFloat(green), blue: CGFloat(blue), alpha: CGFloat(alpha))
  }
}

/// Attributed-string builders for plain and ASS/teletext rich-text subtitle cues.
enum SubtitleTextStyling {
  static func textAlignment(for slot: SubtitleSlot) -> NSTextAlignment {
    switch slot.horizontal {
    case .left: return .left
    case .center: return .center
    case .right: return .right
    }
  }

  static func makeFont(
    size: CGFloat,
    weight: UIFont.Weight,
    italic: Bool = false,
    style: CaptionAppearanceStyle
  ) -> UIFont {
    let base: UIFont
    if let fontName = style.fontName, !fontName.isEmpty, let custom = UIFont(name: fontName, size: size) {
      base = custom
    } else {
      base = UIFont.systemFont(ofSize: size, weight: weight)
    }
    var traits: UIFontDescriptor.SymbolicTraits = []
    if weight == .bold { traits.insert(.traitBold) }
    if italic { traits.insert(.traitItalic) }
    if !traits.isEmpty, let descriptor = base.fontDescriptor.withSymbolicTraits(traits) {
      return UIFont(descriptor: descriptor, size: size)
    }
    return base
  }

  static func makeStyledString(
    text: String,
    fontSize: CGFloat,
    slot: SubtitleSlot,
    style: CaptionAppearanceStyle = .default
  ) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = textAlignment(for: slot)
    paragraph.lineBreakMode = .byWordWrapping
    var attrs: [NSAttributedString.Key: Any] = [
      .font: makeFont(size: fontSize, weight: .semibold, style: style),
      .foregroundColor: style.foreground.uiColor,
      .paragraphStyle: paragraph,
    ]
    if style.window != nil && style.background.alpha > 0.01 {
      attrs[.backgroundColor] = style.background.uiColor
    }
    return NSAttributedString(string: text, attributes: attrs)
  }

  static func makeRichString(
    runs: [SubtitleTextRun],
    fontSize: CGFloat,
    slot: SubtitleSlot,
    style: CaptionAppearanceStyle = .default
  ) -> NSAttributedString? {
    let combinedText = runs.map(\.text).joined().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !combinedText.isEmpty else { return nil }

    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = textAlignment(for: slot)
    paragraph.lineBreakMode = .byWordWrapping

    let out = NSMutableAttributedString()
    for run in runs where !run.text.isEmpty {
      let font = makeFont(
        size: fontSize,
        weight: run.isBold ? .bold : .semibold,
        italic: run.isItalic,
        style: style
      )
      let color = run.color.map {
        UIColor(red: CGFloat($0.r) / 255.0, green: CGFloat($0.g) / 255.0, blue: CGFloat($0.b) / 255.0, alpha: 1.0)
      } ?? style.foreground.uiColor
      var attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color,
        .paragraphStyle: paragraph,
      ]
      if style.window != nil && style.background.alpha > 0.01 {
        attrs[.backgroundColor] = style.background.uiColor
      }
      if run.isUnderlined { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
      if run.isStruckThrough { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      out.append(NSAttributedString(string: run.text, attributes: attrs))
    }
    return out.length > 0 ? out : nil
  }
}

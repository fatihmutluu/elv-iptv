import AetherEngine
import AVFoundation
import UIKit

/// Snapshot of active subtitle cues and picture geometry rendered above `AetherPlayerView` and below `shutterView`.
struct SubtitlePresentation: Equatable {
  static let empty = SubtitlePresentation(cues: [], videoSize: .zero, gravity: .resizeAspect)

  var cues: [SubtitleCue]
  var videoSize: CGSize
  var gravity: AVLayerVideoGravity

  static func == (lhs: SubtitlePresentation, rhs: SubtitlePresentation) -> Bool {
    guard lhs.videoSize == rhs.videoSize,
          lhs.gravity == rhs.gravity,
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

/// Attributed-string builders for plain and ASS/teletext rich-text subtitle cues.
enum SubtitleTextStyling {
  static func textAlignment(for slot: SubtitleSlot) -> NSTextAlignment {
    switch slot.horizontal {
    case .left: return .left
    case .center: return .center
    case .right: return .right
    }
  }

  static func makeStyledString(text: String, fontSize: CGFloat, slot: SubtitleSlot) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = textAlignment(for: slot)
    paragraph.lineBreakMode = .byWordWrapping
    return NSAttributedString(
      string: text,
      attributes: [
        .font: UIFont.systemFont(ofSize: fontSize, weight: .semibold),
        .foregroundColor: UIColor.white,
        .paragraphStyle: paragraph,
      ]
    )
  }

  static func makeRichString(runs: [SubtitleTextRun], fontSize: CGFloat, slot: SubtitleSlot) -> NSAttributedString? {
    let combinedText = runs.map(\.text).joined().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !combinedText.isEmpty else { return nil }

    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = textAlignment(for: slot)
    paragraph.lineBreakMode = .byWordWrapping

    let out = NSMutableAttributedString()
    for run in runs where !run.text.isEmpty {
      var font = UIFont.systemFont(ofSize: fontSize, weight: run.isBold ? .bold : .semibold)
      if run.isItalic, let descriptor = font.fontDescriptor.withSymbolicTraits(
        run.isBold ? [.traitBold, .traitItalic] : [.traitItalic]
      ) {
        font = UIFont(descriptor: descriptor, size: fontSize)
      }
      let color = run.color.map {
        UIColor(red: CGFloat($0.r) / 255.0, green: CGFloat($0.g) / 255.0, blue: CGFloat($0.b) / 255.0, alpha: 1.0)
      } ?? .white
      var attrs: [NSAttributedString.Key: Any] = [
        .font: font,
        .foregroundColor: color,
        .paragraphStyle: paragraph,
      ]
      if run.isUnderlined { attrs[.underlineStyle] = NSUnderlineStyle.single.rawValue }
      if run.isStruckThrough { attrs[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      out.append(NSAttributedString(string: run.text, attributes: attrs))
    }
    return out.length > 0 ? out : nil
  }
}

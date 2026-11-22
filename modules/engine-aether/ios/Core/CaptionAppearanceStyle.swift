import Foundation

/// Platform-neutral RGBA color in `[0.0, 1.0]` used for system caption styling.
public struct CaptionAppearanceColor: Equatable, Sendable {
  public let red: Double
  public let green: Double
  public let blue: Double
  public let alpha: Double

  public init(red: Double, green: Double, blue: Double, alpha: Double) {
    self.red = red
    self.green = green
    self.blue = blue
    self.alpha = alpha
  }
}

/// Resolved system caption appearance settings consumed by the subtitle renderer.
public struct CaptionAppearanceStyle: Equatable, Sendable {
  public let foreground: CaptionAppearanceColor
  public let background: CaptionAppearanceColor
  public let window: CaptionAppearanceColor?
  public let relativeCharacterSize: Double
  public let fontName: String?

  public init(
    foreground: CaptionAppearanceColor = CaptionAppearanceColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0),
    background: CaptionAppearanceColor = CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.74),
    window: CaptionAppearanceColor? = nil,
    relativeCharacterSize: Double = 1.0,
    fontName: String? = nil
  ) {
    self.foreground = foreground
    self.background = background
    self.window = window
    self.relativeCharacterSize = clampCharacterSize(relativeCharacterSize)
    self.fontName = fontName
  }

  public static let `default` = CaptionAppearanceStyle()
}

/// Abstraction supplying platform caption appearance preferences to `resolveCaptionAppearance(source:)`.
public protocol CaptionAppearanceSource: Sendable {
  func readCaptionAppearance() -> CaptionAppearanceStyle?
}

/// Resolves and sanitizes system caption appearance settings, clamping colors to `[0, 1]` and relative character size to `[0.5, 2.0]`.
public func resolveCaptionAppearance(source: (any CaptionAppearanceSource)?) -> CaptionAppearanceStyle {
  guard let raw = source?.readCaptionAppearance() else {
    return .default
  }
  let fallback = CaptionAppearanceStyle.default
  let normalizedFont = raw.fontName?.trimmingCharacters(in: .whitespacesAndNewlines)
  return CaptionAppearanceStyle(
    foreground: clampColor(raw.foreground, fallback: fallback.foreground),
    background: clampColor(raw.background, fallback: fallback.background),
    window: raw.window.map { clampColor($0, fallback: CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.0)) },
    relativeCharacterSize: clampCharacterSize(raw.relativeCharacterSize),
    fontName: (normalizedFont?.isEmpty == false) ? normalizedFont : nil
  )
}

/// Deduplicates sequential subtitle cue strings for VoiceOver announcements, resetting on empty gaps.
public struct VoiceOverAnnouncementDeduper: Equatable, Sendable {
  private var lastAnnounced: String?

  public init() {}

  /// Returns a newly joined non-empty cue string when it differs from the previous announcement, or `nil` otherwise.
  public mutating func nextAnnouncement(for cues: [String]) -> String? {
    let lines = cues
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
    guard !lines.isEmpty else {
      lastAnnounced = nil
      return nil
    }
    let joined = lines.joined(separator: "\n")
    guard joined != lastAnnounced else { return nil }
    lastAnnounced = joined
    return joined
  }

  /// Resets the last announced cue so the next non-empty cue is announced again.
  public mutating func reset() {
    lastAnnounced = nil
  }
}

private func clampUnit(_ value: Double, fallback: Double) -> Double {
  guard value.isFinite else { return fallback }
  return min(1.0, max(0.0, value))
}

private func clampColor(_ color: CaptionAppearanceColor, fallback: CaptionAppearanceColor) -> CaptionAppearanceColor {
  CaptionAppearanceColor(
    red: clampUnit(color.red, fallback: fallback.red),
    green: clampUnit(color.green, fallback: fallback.green),
    blue: clampUnit(color.blue, fallback: fallback.blue),
    alpha: clampUnit(color.alpha, fallback: fallback.alpha)
  )
}

private func clampCharacterSize(_ value: Double) -> Double {
  guard value.isFinite else { return 1.0 }
  return min(2.0, max(0.5, value))
}

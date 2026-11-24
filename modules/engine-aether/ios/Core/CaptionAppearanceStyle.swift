import Foundation

/// User-selectable subtitle text size preset (`#32`).
public enum UserSubtitleFontSize: String, Equatable, Sendable {
  case small
  case medium
  case large
  case extraLarge

  public var relativeScale: Double {
    switch self {
    case .small: return 0.78
    case .medium: return 1.0
    case .large: return 1.3
    case .extraLarge: return 1.65
    }
  }
}

/// User-selectable subtitle foreground color preset (`#32`).
public enum UserSubtitleTextColor: String, Equatable, Sendable {
  case white
  case yellow
  case cyan
  case green

  public var captionColor: CaptionAppearanceColor {
    switch self {
    case .white: return CaptionAppearanceColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0)
    case .yellow: return CaptionAppearanceColor(red: 1.0, green: 0.92, blue: 0.23, alpha: 1.0)
    case .cyan: return CaptionAppearanceColor(red: 0.2, green: 0.92, blue: 1.0, alpha: 1.0)
    case .green: return CaptionAppearanceColor(red: 0.35, green: 0.95, blue: 0.45, alpha: 1.0)
    }
  }
}

/// User-selectable subtitle backdrop opacity preset (`#32`).
public enum UserSubtitleBackgroundColor: String, Equatable, Sendable {
  case none
  case translucent
  case opaque

  public var captionColor: CaptionAppearanceColor {
    switch self {
    case .none: return CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.0)
    case .translucent: return CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.72)
    case .opaque: return CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.96)
    }
  }
}

/// User-selectable subtitle text edge treatment (`#32`).
public enum UserSubtitleEdgeStyle: String, Equatable, Sendable {
  case none
  case outline
  case dropShadow
}

/// User-selectable subtitle vertical placement preset (`#32`).
public enum UserSubtitleVerticalPosition: String, Equatable, Sendable {
  case bottom
  case raised
  case top
}

/// Cross-platform user subtitle style override layered over system caption appearance (`#32`).
public struct UserSubtitleStyleOverride: Equatable, Sendable {
  public var fontSize: UserSubtitleFontSize
  public var textColor: UserSubtitleTextColor
  public var backgroundColor: UserSubtitleBackgroundColor
  public var edgeStyle: UserSubtitleEdgeStyle
  public var verticalPosition: UserSubtitleVerticalPosition

  public init(
    fontSize: UserSubtitleFontSize = .medium,
    textColor: UserSubtitleTextColor = .white,
    backgroundColor: UserSubtitleBackgroundColor = .translucent,
    edgeStyle: UserSubtitleEdgeStyle = .outline,
    verticalPosition: UserSubtitleVerticalPosition = .bottom
  ) {
    self.fontSize = fontSize
    self.textColor = textColor
    self.backgroundColor = backgroundColor
    self.edgeStyle = edgeStyle
    self.verticalPosition = verticalPosition
  }

  /// Parses raw string fields from JS safely, falling back to Cinema Quietude defaults on missing/invalid tokens.
  public static func fromRaw(
    fontSize: String?,
    textColor: String?,
    backgroundColor: String?,
    edgeStyle: String?,
    verticalPosition: String?
  ) -> UserSubtitleStyleOverride {
    UserSubtitleStyleOverride(
      fontSize: fontSize.flatMap { UserSubtitleFontSize(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? .medium,
      textColor: textColor.flatMap { UserSubtitleTextColor(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? .white,
      backgroundColor: backgroundColor.flatMap { UserSubtitleBackgroundColor(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? .translucent,
      edgeStyle: edgeStyle.flatMap { UserSubtitleEdgeStyle(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? .outline,
      verticalPosition: verticalPosition.flatMap { UserSubtitleVerticalPosition(rawValue: $0.trimmingCharacters(in: .whitespacesAndNewlines)) } ?? .bottom
    )
  }
}

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
  public let edgeStyle: UserSubtitleEdgeStyle
  public let verticalPosition: UserSubtitleVerticalPosition

  public init(
    foreground: CaptionAppearanceColor = CaptionAppearanceColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0),
    background: CaptionAppearanceColor = CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.74),
    window: CaptionAppearanceColor? = nil,
    relativeCharacterSize: Double = 1.0,
    fontName: String? = nil,
    edgeStyle: UserSubtitleEdgeStyle = .none,
    verticalPosition: UserSubtitleVerticalPosition = .bottom
  ) {
    self.foreground = foreground
    self.background = background
    self.window = window
    self.relativeCharacterSize = clampCharacterSize(relativeCharacterSize)
    self.fontName = fontName
    self.edgeStyle = edgeStyle
    self.verticalPosition = verticalPosition
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
    fontName: (normalizedFont?.isEmpty == false) ? normalizedFont : nil,
    edgeStyle: raw.edgeStyle,
    verticalPosition: raw.verticalPosition
  )
}

/// Maps a JS `subtitleFontFamily` preference (`"atkinson"`, `"opendyslexic"`, `"system"`) to the bundled
/// PostScript font name, or `nil` when system caption font styling should be preserved (`#163`).
public func resolveSubtitleFontName(_ family: String?) -> String? {
  guard let raw = family?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else {
    return nil
  }
  switch raw {
  case "atkinson":
    return "AtkinsonHyperlegibleNext-Regular"
  case "opendyslexic":
    return "OpenDyslexic-Regular"
  default:
    return nil
  }
}

/// Applies an explicit subtitle font override to a resolved `CaptionAppearanceStyle` while leaving system
/// foreground, background, window, edge, vertical position, and relative character size intact (`#163`).
public func applyingSubtitleFontOverride(
  _ style: CaptionAppearanceStyle,
  family: String?
) -> CaptionAppearanceStyle {
  guard let overrideFont = resolveSubtitleFontName(family) else {
    return style
  }
  return CaptionAppearanceStyle(
    foreground: style.foreground,
    background: style.background,
    window: style.window,
    relativeCharacterSize: style.relativeCharacterSize,
    fontName: overrideFont,
    edgeStyle: style.edgeStyle,
    verticalPosition: style.verticalPosition
  )
}

/// Layers a user `UserSubtitleStyleOverride` on top of a resolved `CaptionAppearanceStyle` while preserving `fontName` (`#32`).
public func applyingUserSubtitleStyle(
  _ base: CaptionAppearanceStyle,
  override: UserSubtitleStyleOverride?
) -> CaptionAppearanceStyle {
  guard let override else { return base }
  return CaptionAppearanceStyle(
    foreground: override.textColor.captionColor,
    background: override.backgroundColor.captionColor,
    window: nil,
    relativeCharacterSize: override.fontSize.relativeScale,
    fontName: base.fontName,
    edgeStyle: override.edgeStyle,
    verticalPosition: override.verticalPosition
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

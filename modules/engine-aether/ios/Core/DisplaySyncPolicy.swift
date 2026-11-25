import Foundation

/// Auto frame-rate matching policy forwarded from user preferences (`#188`, `#116`).
public enum AppleAutoFrameRateMode: String, Sendable, Equatable {
  case off
  case seamless
  case always

  /// Parses a raw JS or configuration string (`"off"`, `"seamless"`, `"always"`), defaulting to `.seamless`.
  public static func parse(_ raw: String?) -> AppleAutoFrameRateMode {
    guard let raw else { return .seamless }
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return AppleAutoFrameRateMode(rawValue: normalized) ?? .seamless
  }

  /// Parses a raw JS or configuration string strictly, returning `nil` when absent or unrecognized.
  public static func parseExact(_ raw: String?) -> AppleAutoFrameRateMode? {
    guard let raw else { return nil }
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return AppleAutoFrameRateMode(rawValue: normalized)
  }
}

/// Combined Apple/tvOS display frame-rate and HDR dynamic-range matching settings (`#188`, `#116`).
public struct AppleDisplaySyncSettings: Sendable, Equatable {
  public var autoFrameRate: AppleAutoFrameRateMode
  public var autoDynamicRange: Bool

  public static let `default` = AppleDisplaySyncSettings(autoFrameRate: .seamless, autoDynamicRange: true)
  public static let disabled = AppleDisplaySyncSettings(autoFrameRate: .off, autoDynamicRange: false)

  /// True whenever either frame-rate matching or HDR dynamic-range matching is enabled.
  public var isEnabled: Bool {
    autoFrameRate != .off || autoDynamicRange
  }

  public init(autoFrameRate: AppleAutoFrameRateMode = .seamless, autoDynamicRange: Bool = true) {
    self.autoFrameRate = autoFrameRate
    self.autoDynamicRange = autoDynamicRange
  }

  /// Resolves optional per-load overrides against default display-sync preferences.
  public static func resolve(
    autoFrameRate: AppleAutoFrameRateMode?,
    autoDynamicRange: Bool?
  ) -> AppleDisplaySyncSettings {
    AppleDisplaySyncSettings(
      autoFrameRate: autoFrameRate ?? .seamless,
      autoDynamicRange: autoDynamicRange ?? true
    )
  }
}

/// Normalized video dynamic range classifications mapped onto tvOS `AVDisplayCriteria` (`#188`, `#116`).
public enum AppleHdrDynamicRange: String, Sendable, Equatable {
  case sdr
  case hdr10
  case hlg
  case dolbyVision

  /// Parses a decoded stream HDR tag (`"sdr"`, `"hdr10"`, `"hlg"`, `"dv"`, `"dolbyVision"`).
  public static func parse(_ raw: String?) -> AppleHdrDynamicRange? {
    guard let raw else { return nil }
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalized.isEmpty else { return nil }
    switch normalized {
    case "sdr":
      return .sdr
    case "hdr10", "pq", "hdr":
      return .hdr10
    case "hlg":
      return .hlg
    case "dv", "dolbyvision", "dolby_vision", "dolby-vision":
      return .dolbyVision
    default:
      return nil
    }
  }
}

/// Lifecycle stop reason used to decide whether tvOS display criteria should be reset (`#188`, `#116`).
public enum AppleStopReason: String, Sendable, Equatable {
  case zap
  case rebuild
  case userStop
  case dispose
}

/// Evaluated tvOS display-criteria application plan including HDMI resync shutter settle window (`#188`, `#116`).
public struct AppleDisplayCriteriaPlan: Sendable, Equatable {
  public let shouldApply: Bool
  public let refreshRate: Float?
  public let dynamicRange: AppleHdrDynamicRange?
  public let shutterSettleMs: Int

  public init(
    shouldApply: Bool,
    refreshRate: Float?,
    dynamicRange: AppleHdrDynamicRange?,
    shutterSettleMs: Int
  ) {
    self.shouldApply = shouldApply
    self.refreshRate = refreshRate
    self.dynamicRange = dynamicRange
    self.shutterSettleMs = shutterSettleMs
  }
}

/// Canonical cinema and broadcast refresh rates supported by Apple TV HDMI output (`#188`, `#116`).
public let appleStandardFrameRates: [Double] = [
  23.976, 24.0, 25.0, 29.97, 30.0, 50.0, 59.94, 60.0,
]

/// Maximum snapping tolerance (fps) around a canonical broadcast/cinema refresh rate.
public let appleFrameRateSnapTolerance: Double = 0.15

/// Shutter settle duration (ms) hiding HDMI resync black-flash transitions on tvOS.
public let appleHdmiShutterSettleMs: Int = 650

/// Snaps a measured stream frame rate to the closest canonical cinema/broadcast rate within `±0.15` fps.
public func snapAppleStandardFrameRate(_ rawFps: Double) -> Float? {
  guard rawFps.isFinite, rawFps > 0, rawFps <= 240.0 else { return nil }
  var bestRate: Double?
  var bestDelta = Double.greatestFiniteMagnitude
  for candidate in appleStandardFrameRates {
    let delta = abs(rawFps - candidate)
    if delta <= appleFrameRateSnapTolerance, delta < bestDelta {
      bestDelta = delta
      bestRate = candidate
    }
  }
  return bestRate.map(Float.init)
}

/// Computes the tvOS `AVDisplayCriteria` plan for stabilized stream metadata and HDMI shutter settle window.
public func planAppleDisplayCriteria(
  settings: AppleDisplaySyncSettings,
  fps: Double?,
  hdr: AppleHdrDynamicRange?,
  isTvOS: Bool,
  previousRefreshRate: Float? = nil,
  previousDynamicRange: AppleHdrDynamicRange? = nil
) -> AppleDisplayCriteriaPlan {
  guard isTvOS, settings.isEnabled else {
    return AppleDisplayCriteriaPlan(
      shouldApply: false,
      refreshRate: nil,
      dynamicRange: nil,
      shutterSettleMs: 0
    )
  }

  let snappedRate: Float? = settings.autoFrameRate != .off ? fps.flatMap(snapAppleStandardFrameRate) : nil
  let dynamicRange: AppleHdrDynamicRange? = settings.autoDynamicRange ? hdr : nil

  guard snappedRate != nil || dynamicRange != nil else {
    return AppleDisplayCriteriaPlan(
      shouldApply: false,
      refreshRate: nil,
      dynamicRange: nil,
      shutterSettleMs: 0
    )
  }

  let changed = (snappedRate != previousRefreshRate) || (dynamicRange != previousDynamicRange)
  return AppleDisplayCriteriaPlan(
    shouldApply: true,
    refreshRate: snappedRate,
    dynamicRange: dynamicRange,
    shutterSettleMs: changed ? appleHdmiShutterSettleMs : 0
  )
}

/// Decides whether tvOS display criteria should be reset on stop/teardown (`false` during live zap/rebuild when active).
public func shouldResetDisplayCriteria(
  reason: AppleStopReason,
  settings: AppleDisplaySyncSettings
) -> Bool {
  guard settings.isEnabled else { return true }
  switch reason {
  case .zap, .rebuild:
    return false
  case .userStop, .dispose:
    return true
  }
}

/// Maps display-sync preferences onto `AetherEngine`'s `DisplayCriteriaOwnerOption` (`.host` disables engine switching).
public func resolveDisplayCriteriaOwner(
  for settings: AppleDisplaySyncSettings
) -> DisplayCriteriaOwnerOption {
  settings.isEnabled ? .engine : .host
}

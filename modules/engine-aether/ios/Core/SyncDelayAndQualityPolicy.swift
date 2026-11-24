import Foundation

/// Pure clamping and timing offset helpers for live audio and subtitle sync delays (`#59`).
public enum SyncDelayPolicy: Sendable {
  public static let minDelayMs: Double = -30_000
  public static let maxDelayMs: Double = 30_000
  public static let minDelaySeconds: Double = -30.0
  public static let maxDelaySeconds: Double = 30.0

  /// Clamps a millisecond delay to `[-30_000, 30_000]`, mapping NaN/Infinity and `-0.0` to `0`.
  public static func clampDelayMs(_ delayMs: Double) -> Double {
    guard delayMs.isFinite else { return 0 }
    let clamped = min(maxDelayMs, max(minDelayMs, delayMs))
    return clamped == 0 ? 0 : clamped
  }

  /// Converts a millisecond delay into clamped seconds (`[-30.0, 30.0]`), mapping non-finite inputs to `0`.
  public static func delaySeconds(fromMs delayMs: Double) -> Double {
    let ms = clampDelayMs(delayMs)
    return ms == 0 ? 0 : ms / 1_000.0
  }

  /// Clamps a delay already expressed in seconds to `[-30.0, 30.0]`, mapping non-finite inputs to `0`.
  public static func clampDelaySeconds(_ seconds: Double) -> Double {
    guard seconds.isFinite else { return 0 }
    let clamped = min(maxDelaySeconds, max(minDelaySeconds, seconds))
    return clamped == 0 ? 0 : clamped
  }

  /// Computes the effective cue lookup timestamp (`sourceTimeSeconds - subtitleDelaySeconds`) for overlay subtitles.
  public static func effectiveSubtitleTime(
    sourceTimeSeconds: Double,
    subtitleDelaySeconds: Double
  ) -> Double {
    guard sourceTimeSeconds.isFinite else { return 0 }
    let delay = clampDelaySeconds(subtitleDelaySeconds)
    return sourceTimeSeconds - delay
  }
}

/// One selectable adaptive video rendition advertised on `onEngineEvent` (`#59`).
public struct VideoQualityOptionOut: Equatable, Sendable {
  public let id: String
  public let label: String
  public let width: Int?
  public let height: Int?
  public let bitrateBps: Int?
  public let fps: Double?

  public init(
    id: String,
    label: String,
    width: Int? = nil,
    height: Int? = nil,
    bitrateBps: Int? = nil,
    fps: Double? = nil
  ) {
    self.id = id
    self.label = label
    self.width = width
    self.height = height
    self.bitrateBps = bitrateBps
    self.fps = fps
  }

  public func toDictionary() -> [String: Any] {
    var out: [String: Any] = [
      "id": id,
      "label": label,
    ]
    if let width { out["width"] = width }
    if let height { out["height"] = height }
    if let bitrateBps { out["bitrateBps"] = bitrateBps }
    if let fps { out["fps"] = fps }
    return out
  }
}

/// Resolution and peak-bitrate ceiling mapped onto `AVPlayerItem.preferredMaximumResolution` / `preferredPeakBitRate`.
public struct VideoQualityCap: Equatable, Sendable {
  public let id: String
  public let maxWidth: Int
  public let maxHeight: Int
  public let peakBitrateBps: Double

  public init(id: String, maxWidth: Int, maxHeight: Int, peakBitrateBps: Double) {
    self.id = id
    self.maxWidth = maxWidth
    self.maxHeight = maxHeight
    self.peakBitrateBps = peakBitrateBps
  }
}

/// Standard adaptive HLS resolution ceiling presets and resolution helper (`#59`).
public enum VideoQualityPolicy: Sendable {
  public static let adaptivePresets: [VideoQualityOptionOut] = [
    VideoQualityOptionOut(id: "2160p", label: "2160p", width: 3840, height: 2160, bitrateBps: 25_000_000),
    VideoQualityOptionOut(id: "1080p", label: "1080p", width: 1920, height: 1080, bitrateBps: 10_000_000),
    VideoQualityOptionOut(id: "720p", label: "720p", width: 1280, height: 720, bitrateBps: 5_000_000),
    VideoQualityOptionOut(id: "480p", label: "480p", width: 854, height: 480, bitrateBps: 2_500_000),
  ]

  /// Resolves a preset ID (`"2160p"`, `"1080p"`, `"720p"`, `"480p"`) to its ABR ceiling, or `nil` for Auto / unknown.
  public static func resolveCap(for id: String?) -> VideoQualityCap? {
    guard let raw = id?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
      return nil
    }
    let normalized = raw.lowercased()
    guard let preset = adaptivePresets.first(where: { $0.id == normalized }),
          let width = preset.width,
          let height = preset.height,
          let bitrate = preset.bitrateBps
    else {
      return nil
    }
    return VideoQualityCap(
      id: preset.id,
      maxWidth: width,
      maxHeight: height,
      peakBitrateBps: Double(bitrate)
    )
  }

  /// True when the active media plan is an adaptive HLS stream eligible for ABR ceiling constraints.
  public static func isAdaptiveStream(plan: MediaPlan?) -> Bool {
    if case .hls = plan {
      return true
    }
    return false
  }
}

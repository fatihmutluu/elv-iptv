import Foundation

private let bytesPerGiB: UInt64 = 1_073_741_824
private let bytesPerMiB: Int64 = 1_048_576
private let lowRamThresholdBytes: UInt64 = 2 * bytesPerGiB
private let midRamThresholdBytes: UInt64 = 3 * bytesPerGiB
private let minThrottleForwardSeconds: Double = 15.0
private let maxThrottleBackoffLevel = 3
private let loadedRangeBoundaryToleranceSeconds: Double = 0.5
private let adjacentRangeMergeGapSeconds: Double = 0.05

/// User-selected VOD read-ahead buffer preset forwarded from JavaScript (`#350`).
public enum AppleBufferPreset: String, Equatable, Sendable {
  case auto
  case balanced
  case large

  /// Parses a case- and whitespace-insensitive preset string, defaulting to `.auto`.
  public static func parse(_ raw: String?) -> AppleBufferPreset {
    guard let normalized = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
          let preset = AppleBufferPreset(rawValue: normalized)
    else {
      return .auto
    }
    return preset
  }
}

/// Live VOD read-ahead and back-buffer cushion telemetry emitted on `ClockAnchor` (`#350`).
public struct AppleBufferHealth: Equatable, Sendable {
  public let bufferedAheadMs: Double
  public let bufferedBehindMs: Double
  public let throttled: Bool?

  public init(bufferedAheadMs: Double, bufferedBehindMs: Double, throttled: Bool? = nil) {
    self.bufferedAheadMs = bufferedAheadMs
    self.bufferedBehindMs = bufferedBehindMs
    self.throttled = throttled
  }

  /// Serializes this sample for the `onEngineEvent` JS payload dictionary.
  public func toDictionary() -> [String: Any] {
    var out: [String: Any] = [
      "bufferedAheadMs": bufferedAheadMs,
      "bufferedBehindMs": bufferedBehindMs,
    ]
    if let throttled {
      out["throttled"] = throttled
    }
    return out
  }
}

/// RAM-tiered, `jetsam`-safe VOD buffer budget applied to `AVPlayerItem` (`#350`).
public struct AppleVodBufferBudget: Equatable, Sendable {
  public let enabled: Bool
  public let preferredForwardBufferDurationSeconds: Double
  public let backTargetMs: Double
  public let maxMemoryBytes: Int64
  public let throttleBackoffLevel: Int

  public init(
    enabled: Bool,
    preferredForwardBufferDurationSeconds: Double,
    backTargetMs: Double,
    maxMemoryBytes: Int64,
    throttleBackoffLevel: Int
  ) {
    self.enabled = enabled
    self.preferredForwardBufferDurationSeconds = preferredForwardBufferDurationSeconds
    self.backTargetMs = backTargetMs
    self.maxMemoryBytes = maxMemoryBytes
    self.throttleBackoffLevel = throttleBackoffLevel
  }
}

/// Pure representation of one `AVPlayerItem.loadedTimeRanges` `CMTimeRange` entry in seconds.
public struct LoadedTimeRangeSample: Equatable, Sendable {
  public let startSeconds: Double
  public let durationSeconds: Double

  public init(startSeconds: Double, durationSeconds: Double) {
    self.startSeconds = startSeconds
    self.durationSeconds = durationSeconds
  }
}

/// Advances the per-session VOD throttle backoff level (clamped `0...3`) on HTTP `429` or `509`.
public func nextAppleThrottleBackoffLevel(current: Int, httpStatus: Int) -> Int {
  let clamped = max(0, min(maxThrottleBackoffLevel, current))
  if httpStatus == 429 || httpStatus == 509 {
    return min(maxThrottleBackoffLevel, clamped + 1)
  }
  return clamped
}

/// Returns `true` when an active memory warning or elevated Apple thermal state (`.serious`/`.critical`)
/// requires stepping down the VOD read-ahead buffer budget (`#350`).
public func shouldApplyAppleLowMemoryPressure(
  thermalState: ProcessInfo.ThermalState,
  memoryWarningActive: Bool
) -> Bool {
  memoryWarningActive || thermalState == .serious || thermalState == .critical
}

/// Computes the deterministic, `jetsam`-safe VOD forward buffer budget for Apple iOS/tvOS devices (`#350`).
/// Live streams always return a disabled zero budget so live-edge latency stays untouched.
public func computeAppleVodBufferBudget(
  isLive: Bool,
  preset: AppleBufferPreset,
  physicalMemoryBytes: UInt64,
  throttleBackoffLevel: Int = 0,
  lowMemoryPressure: Bool = false
) -> AppleVodBufferBudget {
  if isLive {
    return AppleVodBufferBudget(
      enabled: false,
      preferredForwardBufferDurationSeconds: 0,
      backTargetMs: 0,
      maxMemoryBytes: 0,
      throttleBackoffLevel: 0
    )
  }

  let clampedBackoff = max(0, min(maxThrottleBackoffLevel, throttleBackoffLevel))
  let baseForwardSeconds: Double
  let backTargetMs: Double
  let maxMemoryBytes: Int64

  if lowMemoryPressure || physicalMemoryBytes <= lowRamThresholdBytes {
    switch preset {
    case .auto:
      baseForwardSeconds = 20
      backTargetMs = 6_000
      maxMemoryBytes = 12 * bytesPerMiB
    case .balanced:
      baseForwardSeconds = 25
      backTargetMs = 7_000
      maxMemoryBytes = 14 * bytesPerMiB
    case .large:
      baseForwardSeconds = 30
      backTargetMs = 8_000
      maxMemoryBytes = 16 * bytesPerMiB
    }
  } else if physicalMemoryBytes <= midRamThresholdBytes {
    switch preset {
    case .auto:
      baseForwardSeconds = 35
      backTargetMs = 12_000
      maxMemoryBytes = 24 * bytesPerMiB
    case .balanced:
      baseForwardSeconds = 50
      backTargetMs = 16_000
      maxMemoryBytes = 36 * bytesPerMiB
    case .large:
      baseForwardSeconds = 75
      backTargetMs = 20_000
      maxMemoryBytes = 48 * bytesPerMiB
    }
  } else {
    switch preset {
    case .auto:
      baseForwardSeconds = 60
      backTargetMs = 15_000
      maxMemoryBytes = 48 * bytesPerMiB
    case .balanced:
      baseForwardSeconds = 90
      backTargetMs = 22_500
      maxMemoryBytes = 72 * bytesPerMiB
    case .large:
      baseForwardSeconds = 150
      backTargetMs = 30_000
      maxMemoryBytes = 96 * bytesPerMiB
    }
  }

  let divisor = Double(1 << clampedBackoff)
  let effectiveForwardSeconds = max(minThrottleForwardSeconds, baseForwardSeconds / divisor)

  return AppleVodBufferBudget(
    enabled: true,
    preferredForwardBufferDurationSeconds: effectiveForwardSeconds,
    backTargetMs: backTargetMs,
    maxMemoryBytes: maxMemoryBytes,
    throttleBackoffLevel: clampedBackoff
  )
}

/// Extracts `bufferedAheadMs` and `bufferedBehindMs` from the loaded range enclosing `currentTimeSeconds`
/// (allowing `0.5s` boundary jitter), returning `nil` for empty, invalid, or non-enclosing inputs.
public func extractAppleBufferHealth(
  ranges: [LoadedTimeRangeSample],
  currentTimeSeconds: Double,
  throttled: Bool = false
) -> AppleBufferHealth? {
  guard !ranges.isEmpty, currentTimeSeconds.isFinite, currentTimeSeconds >= 0 else {
    return nil
  }

  let validIntervals: [(start: Double, end: Double)] = ranges.compactMap { sample in
    guard sample.startSeconds.isFinite,
          sample.durationSeconds.isFinite,
          sample.startSeconds >= 0,
          sample.durationSeconds > 0
    else {
      return nil
    }
    let end = sample.startSeconds + sample.durationSeconds
    guard end.isFinite, end > sample.startSeconds else { return nil }
    return (start: sample.startSeconds, end: end)
  }.sorted { $0.start < $1.start }

  guard !validIntervals.isEmpty else { return nil }

  var merged: [(start: Double, end: Double)] = []
  merged.reserveCapacity(validIntervals.count)
  for interval in validIntervals {
    if var last = merged.last, interval.start <= last.end + adjacentRangeMergeGapSeconds {
      last.end = max(last.end, interval.end)
      merged[merged.count - 1] = last
    } else {
      merged.append(interval)
    }
  }

  var bestMatch: (start: Double, end: Double, strict: Bool)?
  for interval in merged {
    let strict = interval.start <= currentTimeSeconds && currentTimeSeconds <= interval.end
    let withinTolerance =
      (interval.start - loadedRangeBoundaryToleranceSeconds) <= currentTimeSeconds
      && currentTimeSeconds <= (interval.end + loadedRangeBoundaryToleranceSeconds)
    guard strict || withinTolerance else { continue }
    if let existing = bestMatch {
      if strict && !existing.strict {
        bestMatch = (interval.start, interval.end, strict)
      } else if strict == existing.strict && interval.end > existing.end {
        bestMatch = (interval.start, interval.end, strict)
      }
    } else {
      bestMatch = (interval.start, interval.end, strict)
    }
  }

  guard let matched = bestMatch else { return nil }
  let aheadMs = max(0.0, (matched.end - currentTimeSeconds) * 1_000.0)
  let behindMs = max(0.0, (currentTimeSeconds - matched.start) * 1_000.0)
  return AppleBufferHealth(
    bufferedAheadMs: aheadMs,
    bufferedBehindMs: behindMs,
    throttled: throttled ? true : nil
  )
}

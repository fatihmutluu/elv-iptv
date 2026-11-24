import Foundation

/// Minimum seekable span in seconds required to expose bounded live time-shift seeking (`#28`).
public let defaultMinLiveTimeShiftSpanSeconds: Double = 2.0

/// Validated bounded live seekable window in seconds (`#28`).
public struct LiveSeekableWindow: Equatable, Sendable {
  public let startSec: Double
  public let endSec: Double

  public var spanSec: Double {
    endSec - startSec
  }

  public var startMs: Double {
    startSec * 1_000.0
  }

  public var endMs: Double {
    endSec * 1_000.0
  }

  public init(startSec: Double, endSec: Double) {
    self.startSec = startSec
    self.endSec = endSec
  }
}

/// Evaluates whether `[startSec, endSec]` forms a valid bounded live time-shift window spanning
/// at least `minSpanSec` seconds (`#28`). Returns `nil` for nil, non-finite, negative, inverted,
/// or below-threshold windows.
public func evaluateLiveSeekWindow(
  startSec: Double?,
  endSec: Double?,
  minSpanSec: Double = defaultMinLiveTimeShiftSpanSeconds
) -> LiveSeekableWindow? {
  guard let start = startSec,
        let end = endSec,
        start.isFinite,
        end.isFinite,
        minSpanSec.isFinite,
        start >= 0,
        end > start
  else {
    return nil
  }
  let threshold = max(0, minSpanSec)
  guard (end - start) >= threshold else {
    return nil
  }
  return LiveSeekableWindow(startSec: start, endSec: end)
}

/// Computes the encompassing bounded live seekable window from one or more `(startSec, endSec)`
/// ranges (e.g. `AVPlayerItem.seekableTimeRanges`), ignoring invalid/non-finite entries and
/// requiring a total span of at least `minSpanSec` seconds (`#28`).
public func evaluateLiveSeekRanges(
  _ ranges: [(startSec: Double, endSec: Double)],
  minSpanSec: Double = defaultMinLiveTimeShiftSpanSeconds
) -> LiveSeekableWindow? {
  var minStart: Double?
  var maxEnd: Double?
  for range in ranges {
    guard range.startSec.isFinite,
          range.endSec.isFinite,
          range.startSec >= 0,
          range.endSec > range.startSec
    else {
      continue
    }
    minStart = minStart.map { min($0, range.startSec) } ?? range.startSec
    maxEnd = maxEnd.map { max($0, range.endSec) } ?? range.endSec
  }
  return evaluateLiveSeekWindow(startSec: minStart, endSec: maxEnd, minSpanSec: minSpanSec)
}

/// Clamps `targetSec` strictly inside `[window.startSec, window.endSec]`, returning `nil` for
/// non-finite targets (`#28`).
public func clampLiveSeek(targetSec: Double, window: LiveSeekableWindow) -> Double? {
  guard targetSec.isFinite else { return nil }
  return min(window.endSec, max(window.startSec, targetSec))
}

/// Returns `true` when a paused live stream should run the 1-second seekable-window refresh tick
/// so `liveSeekableStartMs`, `liveEdgeMs`, and behind-live offset continue advancing while paused (`#28`).
public func shouldTickLiveWindowWhilePaused(
  isLive: Bool,
  isLiveTs: Bool,
  isPaused: Bool,
  hasSeekableWindow: Bool
) -> Bool {
  isLive && !isLiveTs && isPaused && hasSeekableWindow
}

import Foundation

/// Throttles high-frequency playback clock emissions to coarse intervals while the player OSD is hidden.
public struct OsdClockThrottle: Equatable, Sendable {
  public let hiddenIntervalSeconds: Double
  public private(set) var osdVisible: Bool

  private var lastEmittedAt: Double?
  private var lastRate: Double?
  private var lastIsPlaying: Bool?

  public init(hiddenIntervalSeconds: Double = 5.0, osdVisible: Bool = true) {
    self.hiddenIntervalSeconds = hiddenIntervalSeconds.isFinite ? max(0.0, hiddenIntervalSeconds) : 5.0
    self.osdVisible = osdVisible
  }

  /// Updates OSD visibility and returns `true` on a `false -> true` transition so the caller can emit an immediate clock snapshot.
  public mutating func setOsdVisible(_ visible: Bool) -> Bool {
    let becameVisible = !osdVisible && visible
    osdVisible = visible
    return becameVisible
  }

  /// Returns whether a clock tick at `nowSeconds` should be forwarded given current visibility, rate, and playing state.
  public mutating func shouldEmit(nowSeconds: Double, rate: Double, isPlaying: Bool) -> Bool {
    if osdVisible {
      lastEmittedAt = nowSeconds
      lastRate = rate
      lastIsPlaying = isPlaying
      return true
    }

    guard
      let previousAt = lastEmittedAt,
      lastRate == rate,
      lastIsPlaying == isPlaying
    else {
      lastEmittedAt = nowSeconds
      lastRate = rate
      lastIsPlaying = isPlaying
      return true
    }

    guard nowSeconds.isFinite, previousAt.isFinite else { return false }
    if nowSeconds - previousAt >= hiddenIntervalSeconds {
      lastEmittedAt = nowSeconds
      lastRate = rate
      lastIsPlaying = isPlaying
      return true
    }
    return false
  }

  /// Clears prior tick history across media loads while preserving the current `osdVisible` state.
  public mutating func reset() {
    lastEmittedAt = nil
    lastRate = nil
    lastIsPlaying = nil
  }
}

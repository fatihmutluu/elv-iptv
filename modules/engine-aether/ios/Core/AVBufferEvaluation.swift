import Foundation

/// Immutable snapshot of `AVPlayer` and `AVPlayerItem` buffering signals evaluated on the main actor.
public struct AVBufferSnapshot: Equatable, Sendable {
  public let isPlaybackBufferEmpty: Bool
  public let isPlaybackBufferFull: Bool
  public let isPlaybackLikelyToKeepUp: Bool
  public let isWaitingToPlay: Bool
  public let waitingToMinimizeStallsOrEvaluating: Bool
  public let isUserPaused: Bool

  public init(
    isPlaybackBufferEmpty: Bool,
    isPlaybackBufferFull: Bool,
    isPlaybackLikelyToKeepUp: Bool,
    isWaitingToPlay: Bool,
    waitingToMinimizeStallsOrEvaluating: Bool,
    isUserPaused: Bool
  ) {
    self.isPlaybackBufferEmpty = isPlaybackBufferEmpty
    self.isPlaybackBufferFull = isPlaybackBufferFull
    self.isPlaybackLikelyToKeepUp = isPlaybackLikelyToKeepUp
    self.isWaitingToPlay = isWaitingToPlay
    self.waitingToMinimizeStallsOrEvaluating = waitingToMinimizeStallsOrEvaluating
    self.isUserPaused = isUserPaused
  }
}

/// Evaluates whether `AVPlayer` is buffering, prioritizing `isPlaybackBufferEmpty` strictly before `isPlaybackBufferFull` and `isPlaybackLikelyToKeepUp`.
public func evaluateAVPlayerBuffering(_ snapshot: AVBufferSnapshot) -> Bool {
  if snapshot.isUserPaused {
    return false
  }
  if snapshot.isPlaybackBufferEmpty {
    return true
  }
  if snapshot.isWaitingToPlay && snapshot.waitingToMinimizeStallsOrEvaluating {
    return true
  }
  return false
}

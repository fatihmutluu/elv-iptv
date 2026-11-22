import ElvAetherCore
import Foundation
import Testing

@Suite("AVBufferEvaluation (#187)")
struct AVBufferEvaluationTests {
  @Test("isPlaybackBufferEmpty takes strict precedence over isPlaybackBufferFull and isPlaybackLikelyToKeepUp")
  func bufferEmptyTakesStrictPrecedence() {
    let emptyAndFull = AVBufferSnapshot(
      isPlaybackBufferEmpty: true,
      isPlaybackBufferFull: true,
      isPlaybackLikelyToKeepUp: false,
      isWaitingToPlay: false,
      waitingToMinimizeStallsOrEvaluating: false,
      isUserPaused: false
    )
    #expect(evaluateAVPlayerBuffering(emptyAndFull))

    let emptyAndLikelyToKeepUp = AVBufferSnapshot(
      isPlaybackBufferEmpty: true,
      isPlaybackBufferFull: false,
      isPlaybackLikelyToKeepUp: true,
      isWaitingToPlay: false,
      waitingToMinimizeStallsOrEvaluating: false,
      isUserPaused: false
    )
    #expect(evaluateAVPlayerBuffering(emptyAndLikelyToKeepUp))

    let emptyAndBothTrue = AVBufferSnapshot(
      isPlaybackBufferEmpty: true,
      isPlaybackBufferFull: true,
      isPlaybackLikelyToKeepUp: true,
      isWaitingToPlay: false,
      waitingToMinimizeStallsOrEvaluating: false,
      isUserPaused: false
    )
    #expect(evaluateAVPlayerBuffering(emptyAndBothTrue))
  }

  @Test("waitingToPlay with toMinimizeStalls/evaluatingBufferingRate evaluates to buffering")
  func waitingToPlayForStallsEvaluatesBuffering() {
    let waitingForStalls = AVBufferSnapshot(
      isPlaybackBufferEmpty: false,
      isPlaybackBufferFull: false,
      isPlaybackLikelyToKeepUp: true,
      isWaitingToPlay: true,
      waitingToMinimizeStallsOrEvaluating: true,
      isUserPaused: false
    )
    #expect(evaluateAVPlayerBuffering(waitingForStalls))

    let waitingOtherReason = AVBufferSnapshot(
      isPlaybackBufferEmpty: false,
      isPlaybackBufferFull: false,
      isPlaybackLikelyToKeepUp: true,
      isWaitingToPlay: true,
      waitingToMinimizeStallsOrEvaluating: false,
      isUserPaused: false
    )
    #expect(!evaluateAVPlayerBuffering(waitingOtherReason))

    let healthyPlaying = AVBufferSnapshot(
      isPlaybackBufferEmpty: false,
      isPlaybackBufferFull: false,
      isPlaybackLikelyToKeepUp: true,
      isWaitingToPlay: false,
      waitingToMinimizeStallsOrEvaluating: true,
      isUserPaused: false
    )
    #expect(!evaluateAVPlayerBuffering(healthyPlaying))
  }

  @Test("user paused never reports buffering even when buffer is empty or waiting")
  func userPausedNeverReportsBuffering() {
    let pausedWithEmptyBuffer = AVBufferSnapshot(
      isPlaybackBufferEmpty: true,
      isPlaybackBufferFull: false,
      isPlaybackLikelyToKeepUp: false,
      isWaitingToPlay: true,
      waitingToMinimizeStallsOrEvaluating: true,
      isUserPaused: true
    )
    #expect(!evaluateAVPlayerBuffering(pausedWithEmptyBuffer))
  }
}

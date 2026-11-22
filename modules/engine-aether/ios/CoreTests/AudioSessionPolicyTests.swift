import ElvAetherCore
import Foundation
import Testing

@Suite("AudioSessionPolicy (#427)")
struct AudioSessionPolicyTests {
  @Test("interruption began and ended with shouldResume resumes only when previously playing")
  func interruptionResumeAndUserPausedBehavior() {
    var policy = AudioSessionPolicy()
    #expect(!policy.isInterrupted)
    #expect(!policy.wasPlayingBeforeInterruption)
    #expect(!policy.latchedRoutePause)
    #expect(!policy.shouldTreatPauseAsSystem)

    #expect(policy.handleInterruptionBegan(currentlyPlaying: true) == .systemPause)
    #expect(policy.isInterrupted)
    #expect(policy.wasPlayingBeforeInterruption)
    #expect(policy.shouldTreatPauseAsSystem)

    #expect(policy.handleInterruptionEnded(shouldResume: true) == .resume)
    #expect(!policy.isInterrupted)
    #expect(!policy.wasPlayingBeforeInterruption)
    #expect(!policy.shouldTreatPauseAsSystem)

    // Interruption ended without shouldResume does not auto-resume.
    #expect(policy.handleInterruptionBegan(currentlyPlaying: true) == .systemPause)
    #expect(policy.handleInterruptionEnded(shouldResume: false) == .none)
    #expect(!policy.isInterrupted)
    #expect(!policy.wasPlayingBeforeInterruption)

    // Already user-paused before interruption must stay paused even when shouldResume is true.
    #expect(policy.handleInterruptionBegan(currentlyPlaying: false) == .systemPause)
    #expect(!policy.wasPlayingBeforeInterruption)
    #expect(policy.handleInterruptionEnded(shouldResume: true) == .none)
    #expect(!policy.isInterrupted)
  }

  @Test("route removal during interruption suppresses auto-resume when interruption ends")
  func routeRemovalDuringInterruptionSuppressesResume() {
    var policy = AudioSessionPolicy()
    #expect(policy.handleInterruptionBegan(currentlyPlaying: true) == .systemPause)
    #expect(policy.handleOldDeviceUnavailable(isRemovedAudioRoute: true) == .pauseAndSystemPause)
    #expect(policy.latchedRoutePause)

    #expect(policy.handleInterruptionEnded(shouldResume: true) == .none)
    #expect(!policy.isInterrupted)
    #expect(policy.latchedRoutePause)
    #expect(policy.shouldTreatPauseAsSystem)

    policy.clearLatchesOnUserPlay()
    #expect(!policy.latchedRoutePause)
    #expect(!policy.wasPlayingBeforeInterruption)
    #expect(!policy.shouldTreatPauseAsSystem)
  }

  @Test("non-removal route changes return none and reset clears all flags")
  func nonRemovalRouteIgnoredAndResetClearsState() {
    var policy = AudioSessionPolicy()
    #expect(policy.handleOldDeviceUnavailable(isRemovedAudioRoute: false) == .none)
    #expect(!policy.latchedRoutePause)
    #expect(!policy.shouldTreatPauseAsSystem)

    _ = policy.handleInterruptionBegan(currentlyPlaying: true)
    _ = policy.handleOldDeviceUnavailable(isRemovedAudioRoute: true)
    policy.reset()
    #expect(!policy.isInterrupted)
    #expect(!policy.wasPlayingBeforeInterruption)
    #expect(!policy.latchedRoutePause)
    #expect(!policy.shouldTreatPauseAsSystem)
  }

  @Test("delayed paused callback > 1500 ms after headphone disconnect keeps EngineCore paused with zero play calls")
  @MainActor
  func delayedPausedAfterHeadphoneDisconnectNeverAutoResumes() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })
    var policy = AudioSessionPolicy()

    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts", live: true), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    clock.nowMs = 2_000
    core.observe(.clock(positionSeconds: 5.0, rate: 1.0, durationSeconds: nil, liveEdgeSeconds: 6.0), serial: 1)
    backend.calls.removeAll()
    sink.events.removeAll()

    // Headphone unplug triggers immediate pause + systemPaused latch.
    let action = policy.handleOldDeviceUnavailable(isRemovedAudioRoute: true)
    #expect(action == .pauseAndSystemPause)
    #expect(policy.shouldTreatPauseAsSystem)
    backend.pause()
    core.observe(.phase(.systemPaused), serial: 1)
    #expect(backend.calls == [.pause])
    #expect(sink.events.first == .state(attempt: 1, state: .paused))

    backend.calls.removeAll()
    sink.events.removeAll()

    // Simulate AVPlayer delivering a delayed .paused callback 2,500 ms later (> old 1,500 ms window).
    clock.nowMs = 4_500
    #expect(policy.shouldTreatPauseAsSystem)
    let delayedPhase: BackendPhase = policy.shouldTreatPauseAsSystem ? .systemPaused : .paused
    core.observe(.phase(delayedPhase), serial: 1)
    // Even a raw .paused after .systemPaused must stay paused and never invoke backend.play().
    core.observe(.phase(.paused), serial: 1)
    #expect(!backend.calls.contains(.play))
    #expect(backend.calls.isEmpty)
    #expect(!sink.screenOn)
  }
}

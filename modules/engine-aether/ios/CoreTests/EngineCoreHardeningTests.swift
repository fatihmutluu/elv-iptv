import ElvAetherCore
import Foundation
import Testing

@Suite("EngineCore Hardening (#227, #280, EOF, Seek)")
@MainActor
struct EngineCoreHardeningTests {
  private func makeHarness() -> (EngineCore, FakeBackend, RecordingSink, FakeClock) {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })
    return (core, backend, sink, clock)
  }

  @Test("pre-framed and seeking clock ticks never overwrite VOD startMs or emit premature anchors (#280)")
  func preFramedAndSeekingClockTicksPreserveStartMs() {
    let (core, backend, sink, clock) = makeHarness()
    core.load(
      LoadRequest(url: "http://h:7878/movie/demo/demo/200001.mp4", live: false, startMs: 45_000),
      attempt: 1
    )
    sink.events.removeAll()

    // Engine emits 0.0s clock tick during .ready before firstFrame, then viewer pauses before firstFrame.
    core.observe(.clock(positionSeconds: 0.0, rate: 0.0, durationSeconds: 120.0, liveEdgeSeconds: nil), serial: 1)
    core.pause(2)
    core.observe(.phase(.paused), serial: 1)
    #expect(sink.events == [.state(attempt: 2, state: .paused)])

    // Retry must still resume at 45.0s, NOT 0.0s!
    backend.calls.removeAll()
    core.retry(3)
    #expect(
      backend.calls == [
        .stopMedia,
        .start(
          .vod(URL(string: "http://h:7878/movie/demo/demo/200001.mp4")!, startSeconds: 45.0),
          EngineLoadOptions(isLive: false, maxConcurrentSourceRequests: 1),
          2
        ),
      ]
    )

    // Once framed and playing, entering .seeking ignores stale pre-seek clock ticks.
    core.observe(.firstFrame, serial: 2)
    core.observe(.phase(.playing), serial: 2)
    clock.nowMs = 2_000
    core.seek(4, positionMs: 90_000)
    core.observe(.phase(.seeking), serial: 2)
    sink.events.removeAll()

    clock.nowMs = 2_500
    core.observe(.clock(positionSeconds: 45.2, rate: 1.0, durationSeconds: 120.0, liveEdgeSeconds: nil), serial: 2)
    #expect(sink.events.isEmpty)

    core.observe(.phase(.playing), serial: 2)
    clock.nowMs = 2_600
    core.observe(.clock(positionSeconds: 90.0, rate: 1.0, durationSeconds: 120.0, liveEdgeSeconds: nil), serial: 2)
    #expect(
      sink.events == [
        .state(attempt: 4, state: .playing),
        .clock(attempt: 4, anchor: ClockAnchorOut(positionMs: 90_000, atMs: 2_600, rate: 1.0, durationMs: 120_000)),
      ]
    )
  }

  @Test("seek ignores NaN/Infinity and clamps to 0...duration")
  func seekRejectsNonFiniteAndClampsToDuration() {
    let (core, backend, _, clock) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/1.mp4", live: false), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    clock.nowMs = 1_500
    core.observe(.clock(positionSeconds: 10.0, rate: 1.0, durationSeconds: 60.0, liveEdgeSeconds: nil), serial: 1)
    backend.calls.removeAll()

    core.seek(2, positionMs: .nan)
    core.seek(3, positionMs: .infinity)
    core.seek(4, positionMs: -.infinity)
    #expect(backend.calls.isEmpty)

    core.seek(5, positionMs: -5_000)
    #expect(backend.calls.last == .seek(0.0))

    core.seek(6, positionMs: 95_000)
    #expect(backend.calls.last == .seek(60.0))
  }

  @Test("resumed VOD at EOF emits clean ended and clears subtitles while 0-byte VOD still reports network")
  func resumedVodAtEofEmitsEndedAndClearsSubtitles() {
    let (core, _, sink, _) = makeHarness()
    core.load(
      LoadRequest(url: "http://h:7878/movie/demo/demo/1.mp4", live: false, startMs: 120_000),
      attempt: 1
    )
    sink.events.removeAll()
    sink.clearSubtitlesCount = 0

    // Duration resolved (> 0) and startMs > 0 -> immediate .ended before firstFrame is valid EOF!
    core.observe(.clock(positionSeconds: 0.0, rate: 0.0, durationSeconds: 120.0, liveEdgeSeconds: nil), serial: 1)
    core.observe(.phase(.ended), serial: 1)
    #expect(sink.events == [.state(attempt: 1, state: .ended)])
    #expect(sink.clearSubtitlesCount == 1)

    // Empty 0-byte VOD (duration == nil) at startMs: 0 still reports vodEndedBeforePlay network error.
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/empty.mp4", live: false), attempt: 2)
    sink.events.removeAll()
    core.observe(.phase(.ended), serial: 2)
    if case let .error(attempt, err) = sink.events.first, sink.events.count == 1 {
      #expect(attempt == 2 && err.code == "network" && err.detail.hasPrefix("vodEndedBeforePlay"))
    } else {
      Issue.record("expected vodEndedBeforePlay on empty VOD")
    }
  }

  @Test("unrequested live paused converts to rebuffering and resumes while user/system pauses stay paused (#227)")
  func unrequestedLivePausedConvertsToRebuffering() {
    let (core, backend, sink, clock) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.m3u8", live: true), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    clock.nowMs = 1_500
    core.observe(.clock(positionSeconds: 8.0, rate: 1.0, durationSeconds: nil, liveEdgeSeconds: 10.0), serial: 1)
    backend.calls.removeAll()
    sink.events.removeAll()

    // Unrequested AVPlayer .paused on live -> stall start + buffering + backend.play()!
    clock.nowMs = 2_000
    core.observe(.phase(.paused), serial: 1)
    #expect(backend.calls == [.play])
    #expect(
      sink.events == [
        .stall(attempt: 1, phase: .start, atMs: 2_000),
        .state(attempt: 1, state: .buffering),
        .clock(attempt: 1, anchor: ClockAnchorOut(positionMs: 8_000, atMs: 2_000, rate: 0, liveEdgeMs: 10_000)),
      ]
    )

    // Resuming playing closes the stall cleanly.
    clock.nowMs = 2_400
    core.observe(.phase(.playing), serial: 1)
    sink.events.removeAll()
    backend.calls.removeAll()

    // System audio interruption / route removal (.systemPaused) stays genuinely paused (#256).
    clock.nowMs = 3_000
    core.observe(.phase(.systemPaused), serial: 1)
    #expect(backend.calls.isEmpty)
    #expect(
      sink.events == [
        .state(attempt: 1, state: .paused),
        .clock(attempt: 1, anchor: ClockAnchorOut(positionMs: 8_000, atMs: 3_000, rate: 0, liveEdgeMs: 10_000)),
      ]
    )

    // Explicit user play() clears pause intent, and explicit user pause() stays paused.
    core.play(2)
    core.observe(.phase(.playing), serial: 1)
    backend.calls.removeAll()
    sink.events.removeAll()

    clock.nowMs = 4_000
    core.pause(3)
    backend.calls.removeAll()
    core.observe(.phase(.paused), serial: 1)
    #expect(backend.calls.isEmpty)
    #expect(sink.events.first == .state(attempt: 3, state: .paused))
  }

  @Test("duration observation updates metadata without clobbering playing clock rate or position")
  func durationObservationPreservesPlayingClockAndSupportsVodEof() {
    let (core, _, sink, clock) = makeHarness()
    core.load(
      LoadRequest(url: "http://h:7878/movie/demo/demo/200010.mp4", live: false, startMs: 120_000),
      attempt: 1
    )
    sink.events.removeAll()

    // Early duration before firstFrame satisfies resumed VOD EOF without emitting premature clock.
    core.observe(.duration(120.0), serial: 1)
    #expect(sink.events.isEmpty)
    core.observe(.phase(.ended), serial: 1)
    #expect(sink.events == [.state(attempt: 1, state: .ended)])

    // Once playing, duplicate duration does not emit and changed duration keeps rate 1.0 and position.
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200010.mp4", live: false), attempt: 2)
    core.observe(.firstFrame, serial: 2)
    core.observe(.phase(.playing), serial: 2)
    clock.nowMs = 1_500
    core.observe(.clock(positionSeconds: 5.0, rate: 1.0, durationSeconds: 600.0, liveEdgeSeconds: nil), serial: 2)
    sink.events.removeAll()

    clock.nowMs = 1_600
    core.observe(.duration(600.0), serial: 2)
    #expect(sink.events.isEmpty)

    clock.nowMs = 1_700
    core.observe(.duration(605.0), serial: 2)
    #expect(
      sink.events == [
        .clock(attempt: 2, anchor: ClockAnchorOut(positionMs: 5_000, atMs: 1_700, rate: 1.0, durationMs: 605_000)),
      ]
    )
  }

  @Test("mid-playback loading freezes clock without stall and resumes playing at rate 1.0")
  func midPlaybackLoadingFreezesClockAndResumesAtRateOne() {
    let (core, _, sink, clock) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200010.mp4", live: false), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    clock.nowMs = 1_200
    core.observe(.clock(positionSeconds: 0.5, rate: 1.0, durationSeconds: 600.0, liveEdgeSeconds: nil), serial: 1)
    sink.events.removeAll()

    // Mid-playback audio-switch rebuild enters .loading: emits buffering + rate 0, no stall, ignores mid-reload ticks.
    clock.nowMs = 1_300
    core.observe(.phase(.loading), serial: 1)
    core.observe(.duration(600.0), serial: 1)
    core.observe(.clock(positionSeconds: 0.0, rate: 0.0, durationSeconds: 600.0, liveEdgeSeconds: nil), serial: 1)
    #expect(
      sink.events == [
        .state(attempt: 1, state: .buffering),
        .clock(attempt: 1, anchor: ClockAnchorOut(positionMs: 500, atMs: 1_300, rate: 0, durationMs: 600_000)),
      ]
    )
    sink.events.removeAll()

    // Returning to .playing immediately restores rate 1.0 and forces the next real clock tick through.
    clock.nowMs = 1_600
    core.observe(.phase(.playing), serial: 1)
    #expect(
      sink.events == [
        .state(attempt: 1, state: .playing),
        .clock(attempt: 1, anchor: ClockAnchorOut(positionMs: 500, atMs: 1_600, rate: 1.0, durationMs: 600_000)),
      ]
    )
    sink.events.removeAll()

    clock.nowMs = 1_650
    core.observe(.clock(positionSeconds: 0.6, rate: 1.0, durationSeconds: 600.0, liveEdgeSeconds: nil), serial: 1)
    #expect(
      sink.events == [
        .clock(attempt: 1, anchor: ClockAnchorOut(positionMs: 600, atMs: 1_650, rate: 1.0, durationMs: 600_000)),
      ]
    )
  }
}

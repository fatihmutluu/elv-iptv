import ElvAetherCore
import Foundation
import Testing

@Suite("EngineCore")
@MainActor
struct EngineCoreTests {
  private func makeHarness() -> (EngineCore, FakeBackend, RecordingSink, FakeClock) {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })
    return (core, backend, sink, clock)
  }

  @Test("load emits opening with its token and starts the backend after stopping the old media")
  func loadEmitsOpeningAndStartsBackend() {
    let (core, backend, sink, _) = makeHarness()
    let req = LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts", live: true)
    core.load(req, attempt: 4)

    #expect(sink.shutterCovered)
    #expect(sink.events == [.state(attempt: 4, state: .opening)])
    let expectedOpts = EngineLoadOptions(isLive: true, liveStartupGraceSeconds: 0, liveStartupSingleSegmentMinimumSeconds: 1.0)
    #expect(backend.calls == [.stopMedia, .start(.liveTs(URL(string: "http://h:7878/live/demo/demo/1001.ts")!), expectedOpts, 1)])
  }

  @Test("events of a stopped media never reach the new serial")
  func stoppedMediaEventsIgnored() {
    let (core, _, sink, clock) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1)
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1002.ts"), attempt: 2)
    sink.events.removeAll()

    core.observe(.firstFrame, serial: 1)
    core.observe(.failure(.liveSourceReset), serial: 1)
    #expect(sink.events.isEmpty)
    #expect(sink.shutterCovered)

    clock.nowMs = 1_250
    core.observe(.firstFrame, serial: 2)
    #expect(sink.events == [.firstFrame(attempt: 2, atMs: 1_250)])
    #expect(!sink.shutterCovered)
  }

  @Test("playing waits for the first frame on video")
  func playingWaitsForFirstFrameOnVideo() {
    let (core, _, sink, clock) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1)
    sink.events.removeAll()

    core.observe(.opened, serial: 1)
    core.observe(.opened, serial: 1)
    core.observe(.ready, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    #expect(sink.events == [.state(attempt: 1, state: .buffering), .state(attempt: 1, state: .ready)])
    #expect(sink.shutterCovered)

    clock.nowMs = 1_500
    core.observe(.firstFrame, serial: 1)
    core.observe(.firstFrame, serial: 1)
    #expect(
      sink.events == [
        .state(attempt: 1, state: .buffering),
        .state(attempt: 1, state: .ready),
        .firstFrame(attempt: 1, atMs: 1_500),
        .state(attempt: 1, state: .playing),
      ]
    )
    #expect(!sink.shutterCovered)
    #expect(sink.screenOn)
  }

  @Test("audio-only media sends firstFrame at its first playing and keeps the shutter covered")
  func audioOnlySendsFirstFrameAtPlaying() {
    let (core, _, sink, clock) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1025.ts"), attempt: 3)
    sink.events.removeAll()

    clock.nowMs = 2_000
    core.observe(.audioOnly, serial: 1)
    core.observe(.phase(.playing), serial: 1)

    #expect(sink.events == [.firstFrame(attempt: 3, atMs: 2_000), .state(attempt: 3, state: .playing)])
    #expect(sink.shutterCovered)
    #expect(sink.screenOn)
  }

  @Test("a newer command token tags later events")
  func newerTokenAdopted() {
    let (core, backend, sink, _) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    sink.events.removeAll()

    core.pause(5)
    #expect(backend.calls.last == .pause)
    core.observe(.phase(.paused), serial: 1)
    #expect(sink.events.allSatisfy { ($0.payload["attempt"] as? Int) == 5 })

    sink.events.removeAll()
    core.play(6)
    #expect(backend.calls.last == .play)
    core.observe(.phase(.playing), serial: 1)
    #expect(
      sink.events == [
        .state(attempt: 6, state: .playing),
        .clock(attempt: 6, anchor: ClockAnchorOut(positionMs: 0, atMs: 1_000, rate: 1.0)),
      ]
    )
  }

  @Test("pause anchors the clock at rate 0")
  func pauseAnchorsAtRateZero() {
    let (core, _, sink, clock) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/1.mp4", live: false), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    clock.nowMs = 1_100
    core.observe(
      .clock(positionSeconds: 12.5, rate: 1.0, durationSeconds: 120.0, liveEdgeSeconds: nil),
      serial: 1
    )
    sink.events.removeAll()

    clock.nowMs = 1_600
    core.pause(2)
    core.observe(.phase(.paused), serial: 1)

    #expect(
      sink.events == [
        .state(attempt: 2, state: .paused),
        .clock(
          attempt: 2,
          anchor: ClockAnchorOut(positionMs: 12_500, atMs: 1_600, rate: 0, durationMs: 120_000)
        ),
      ]
    )
    #expect(!sink.screenOn)
  }

  @Test("clock anchors at most once a second while playing unless seeked or rate changes")
  func clockThrottledToOneSecond() {
    let (core, _, sink, clock) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/1.mp4", live: false), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    sink.events.removeAll()

    clock.nowMs = 1_000
    core.observe(.clock(positionSeconds: 1.0, rate: 1.0, durationSeconds: 60.0, liveEdgeSeconds: nil), serial: 1)
    clock.nowMs = 1_400
    core.observe(.clock(positionSeconds: 1.4, rate: 1.0, durationSeconds: 60.0, liveEdgeSeconds: nil), serial: 1)
    clock.nowMs = 1_999
    core.observe(.clock(positionSeconds: 1.999, rate: 1.0, durationSeconds: 60.0, liveEdgeSeconds: nil), serial: 1)
    clock.nowMs = 2_000
    core.observe(.clock(positionSeconds: 2.0, rate: 1.0, durationSeconds: 60.0, liveEdgeSeconds: nil), serial: 1)

    #expect(
      sink.events == [
        .clock(attempt: 1, anchor: ClockAnchorOut(positionMs: 1_000, atMs: 1_000, rate: 1.0, durationMs: 60_000)),
        .clock(attempt: 1, anchor: ClockAnchorOut(positionMs: 2_000, atMs: 2_000, rate: 1.0, durationMs: 60_000)),
      ]
    )

    sink.events.removeAll()
    clock.nowMs = 2_200
    core.seek(2, positionMs: 30_000)
    core.observe(.clock(positionSeconds: 30.0, rate: 1.0, durationSeconds: 60.0, liveEdgeSeconds: nil), serial: 1)
    #expect(
      sink.events == [
        .clock(attempt: 2, anchor: ClockAnchorOut(positionMs: 30_000, atMs: 2_200, rate: 1.0, durationMs: 60_000)),
      ]
    )
  }

  @Test("a stall after playing sends stall start and end with buffering, playing and clock anchors")
  func stallAfterPlaying() {
    let (core, _, sink, clock) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    clock.nowMs = 1_000
    core.observe(.clock(positionSeconds: 4.0, rate: 1.0, durationSeconds: nil, liveEdgeSeconds: 4.0), serial: 1)
    sink.events.removeAll()

    clock.nowMs = 1_300
    core.observe(.phase(.rebuffering), serial: 1)
    #expect(sink.screenOn)

    clock.nowMs = 1_800
    core.observe(.phase(.playing), serial: 1)

    #expect(
      sink.events == [
        .stall(attempt: 1, phase: .start, atMs: 1_300),
        .state(attempt: 1, state: .buffering),
        .clock(attempt: 1, anchor: ClockAnchorOut(positionMs: 4_000, atMs: 1_300, rate: 0, liveEdgeMs: 4_000)),
        .stall(attempt: 1, phase: .end, atMs: 1_800),
        .state(attempt: 1, state: .playing),
        .clock(attempt: 1, anchor: ClockAnchorOut(positionMs: 4_000, atMs: 1_800, rate: 1.0, liveEdgeMs: 4_000)),
      ]
    )
  }

  @Test("a live media or an unplayed VOD that ends is a network error; a played VOD media ends")
  func endedBehaviorLiveVsVod() {
    let (core, _, sink, _) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts", live: true), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    sink.events.removeAll()

    core.observe(.phase(.ended), serial: 1)
    if case let .error(attempt, error) = sink.events.first, sink.events.count == 1 {
      #expect(attempt == 1 && error.code == "network" && error.detail.hasPrefix("liveEnded"))
    } else {
      Issue.record("expected network error on live ended")
    }
    #expect(!sink.screenOn)

    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200001.mp4", live: false), attempt: 2)
    core.observe(.firstFrame, serial: 2)
    core.observe(.phase(.playing), serial: 2)
    sink.events.removeAll()

    core.observe(.phase(.ended), serial: 2)
    #expect(sink.events == [.state(attempt: 2, state: .ended)])
    #expect(!sink.screenOn)

    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200001.mp4", live: false), attempt: 3)
    sink.events.removeAll()

    core.observe(.phase(.ended), serial: 3)
    if case let .error(attempt, error) = sink.events.first, sink.events.count == 1 {
      #expect(attempt == 3 && error.code == "network" && error.detail.hasPrefix("vodEndedBeforePlay"))
    } else {
      Issue.record("expected network error when VOD ends before play")
    }
    #expect(!sink.screenOn)
  }

  @Test("a failure is reported once per media with the mapped code")
  func failureReportedOnce() {
    let (core, _, sink, _) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 7)
    sink.events.removeAll()

    core.observe(
      .failure(.engine(kind: "sourceRefused", underlyingDomain: nil, underlyingCode: 404)),
      serial: 1
    )
    core.observe(.failure(.liveSourceReset), serial: 1)

    #expect(sink.events.count == 1)
    if case let .error(attempt, mapped) = sink.events.first {
      #expect(attempt == 7)
      #expect(mapped.code == "http-404")
      #expect(mapped.httpStatus == 404)
    } else {
      Issue.record("expected single http-404 error event")
    }
  }

  @Test("retry reloads VOD at the last anchored position and keeps the shutter")
  func retryReloadsVodAtLastAnchoredPosition() {
    let (core, backend, sink, clock) = makeHarness()
    core.load(
      LoadRequest(url: "http://h:7878/movie/demo/demo/200001.mp4", live: false, startMs: 2_000),
      attempt: 1
    )
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    clock.nowMs = 1_500
    core.observe(.clock(positionSeconds: 45.5, rate: 1.0, durationSeconds: 600, liveEdgeSeconds: nil), serial: 1)

    sink.shutterHistory.removeAll()
    sink.events.removeAll()
    backend.calls.removeAll()

    core.retry(2)

    #expect(sink.shutterHistory.isEmpty)
    #expect(!sink.shutterCovered)
    #expect(sink.events == [.state(attempt: 2, state: .opening)])
    #expect(
      backend.calls == [
        .stopMedia,
        .start(
          .vod(URL(string: "http://h:7878/movie/demo/demo/200001.mp4")!, startSeconds: 45.5),
          EngineLoadOptions(isLive: false, maxConcurrentSourceRequests: 1),
          2
        ),
      ]
    )
  }
}

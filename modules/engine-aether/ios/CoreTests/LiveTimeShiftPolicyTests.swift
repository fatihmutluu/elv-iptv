import ElvAetherCore
import Foundation
import Testing

@Suite("LiveTimeShiftPolicy")
struct LiveTimeShiftPolicyTests {
  @Test("evaluateLiveSeekWindow accepts valid live windows >= minSpanSec and rejects invalid bounds")
  func evaluatesSeekWindowBounds() {
    #expect(evaluateLiveSeekWindow(startSec: nil, endSec: 60.0) == nil)
    #expect(evaluateLiveSeekWindow(startSec: 0.0, endSec: nil) == nil)
    #expect(evaluateLiveSeekWindow(startSec: -1.0, endSec: 60.0) == nil)
    #expect(evaluateLiveSeekWindow(startSec: 60.0, endSec: 60.0) == nil)
    #expect(evaluateLiveSeekWindow(startSec: 70.0, endSec: 60.0) == nil)
    #expect(evaluateLiveSeekWindow(startSec: .nan, endSec: 60.0) == nil)
    #expect(evaluateLiveSeekWindow(startSec: 0.0, endSec: .infinity) == nil)
    #expect(evaluateLiveSeekWindow(startSec: 10.0, endSec: 11.9) == nil)

    let exactBoundary = evaluateLiveSeekWindow(startSec: 10.0, endSec: 12.0)
    #expect(exactBoundary == LiveSeekableWindow(startSec: 10.0, endSec: 12.0))
    #expect(exactBoundary?.spanSec == 2.0)
    #expect(exactBoundary?.startMs == 10_000.0)
    #expect(exactBoundary?.endMs == 12_000.0)

    let customMin = evaluateLiveSeekWindow(startSec: 5.0, endSec: 8.0, minSpanSec: 5.0)
    #expect(customMin == nil)
  }

  @Test("evaluateLiveSeekRanges merges valid ranges and skips malformed entries")
  func evaluatesMultipleSeekRanges() {
    #expect(evaluateLiveSeekRanges([]) == nil)
    #expect(evaluateLiveSeekRanges([(startSec: -5.0, endSec: 20.0), (startSec: .nan, endSec: 30.0)]) == nil)

    let merged = evaluateLiveSeekRanges([
      (startSec: -2.0, endSec: 5.0),
      (startSec: 30.0, endSec: 90.0),
      (startSec: 80.0, endSec: 150.0),
      (startSec: 100.0, endSec: 95.0),
    ])
    #expect(merged == LiveSeekableWindow(startSec: 30.0, endSec: 150.0))
  }

  @Test("clampLiveSeek clamps strictly inside window and rejects non-finite targets")
  func clampsTargetsInsideWindow() {
    let window = LiveSeekableWindow(startSec: 60.0, endSec: 180.0)
    #expect(clampLiveSeek(targetSec: 10.0, window: window) == 60.0)
    #expect(clampLiveSeek(targetSec: 250.0, window: window) == 180.0)
    #expect(clampLiveSeek(targetSec: 120.5, window: window) == 120.5)
    #expect(clampLiveSeek(targetSec: .nan, window: window) == nil)
    #expect(clampLiveSeek(targetSec: .infinity, window: window) == nil)
    #expect(clampLiveSeek(targetSec: -.infinity, window: window) == nil)
  }

  @Test("EngineCore emits live time-shift metadata and clamps seeks for HLS live windows while blocking raw TS")
  @MainActor
  func engineCoreLiveTimeShiftIntegration() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    // Live HLS with >= 2s seekable range enables bounded live seek
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.m3u8", live: true), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    sink.events.removeAll()
    clock.nowMs = 2_000
    core.observe(
      .clock(
        positionSeconds: 150.0,
        rate: 1.0,
        durationSeconds: nil,
        liveEdgeSeconds: 180.0,
        liveSeekableStartSeconds: 60.0,
        timeShiftSupported: true
      ),
      serial: 1
    )

    #expect(core.isLiveTimeShiftSupported)
    #expect(core.liveSeekableWindow == LiveSeekableWindow(startSec: 60.0, endSec: 180.0))
    #expect(
      sink.events == [
        .clock(
          attempt: 1,
          anchor: ClockAnchorOut(
            positionMs: 150_000,
            atMs: 2_000,
            rate: 1.0,
            liveEdgeMs: 180_000,
            liveSeekableStartMs: 60_000,
            timeShiftSupported: true
          )
        ),
      ]
    )
    let anchorDict = sink.events[0].payload["anchor"] as? [String: Any]
    #expect(anchorDict?["liveSeekableStartMs"] as? Double == 60_000)
    #expect(anchorDict?["liveEdgeMs"] as? Double == 180_000)
    #expect(anchorDict?["timeShiftSupported"] as? Bool == true)

    // Seeks clamp strictly inside [60s, 180s]
    core.seek(2, positionMs: 15_000)
    #expect(backend.calls.last == .seek(60.0))
    core.seek(3, positionMs: 240_000)
    #expect(backend.calls.last == .seek(180.0))
    core.seek(4, positionMs: 120_000)
    #expect(backend.calls.last == .seek(120.0))

    // Forward-only live raw MPEG-TS always reports timeShiftSupported = false and rejects seek
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1002.ts", live: true), attempt: 5)
    core.observe(.firstFrame, serial: 2)
    core.observe(.phase(.playing), serial: 2)
    sink.events.removeAll()
    backend.calls.removeAll()
    clock.nowMs = 4_000
    core.observe(
      .clock(
        positionSeconds: 20.0,
        rate: 1.0,
        durationSeconds: nil,
        liveEdgeSeconds: 30.0,
        liveSeekableStartSeconds: 0.0,
        timeShiftSupported: true
      ),
      serial: 2
    )
    #expect(!core.isLiveTimeShiftSupported)
    #expect(core.liveSeekableWindow == nil)
    let tsAnchorDict = sink.events.last?.payload["anchor"] as? [String: Any]
    #expect(tsAnchorDict?["liveSeekableStartMs"] == nil)
    #expect(tsAnchorDict?["timeShiftSupported"] as? Bool == false)

    core.seek(6, positionMs: 10_000)
    #expect(backend.calls.isEmpty)
  }

  @Test("shouldTickLiveWindowWhilePaused enables paused live ticks strictly for seekable non-TS live streams")
  func evaluatesPausedLiveWindowTickPolicy() {
    #expect(shouldTickLiveWindowWhilePaused(isLive: true, isLiveTs: false, isPaused: true, hasSeekableWindow: true))
    #expect(!shouldTickLiveWindowWhilePaused(isLive: false, isLiveTs: false, isPaused: true, hasSeekableWindow: true))
    #expect(!shouldTickLiveWindowWhilePaused(isLive: true, isLiveTs: true, isPaused: true, hasSeekableWindow: true))
    #expect(!shouldTickLiveWindowWhilePaused(isLive: true, isLiveTs: false, isPaused: false, hasSeekableWindow: true))
    #expect(!shouldTickLiveWindowWhilePaused(isLive: true, isLiveTs: false, isPaused: true, hasSeekableWindow: false))
  }

  @Test("EngineCore emits updated liveSeekableStartMs and liveEdgeMs anchors while live stream is paused (#28)")
  @MainActor
  func engineCoreEmitsPausedLiveWindowUpdates() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.m3u8", live: true), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    clock.nowMs = 1_000
    core.observe(
      .clock(
        positionSeconds: 120.0,
        rate: 1.0,
        durationSeconds: nil,
        liveEdgeSeconds: 120.0,
        liveSeekableStartSeconds: 60.0,
        timeShiftSupported: true
      ),
      serial: 1
    )

    // User pauses live playback
    core.pause(2)
    core.observe(.phase(.paused), serial: 1)
    sink.events.removeAll()

    // 1 second later while paused: position stays 120s, live window advances to [61s, 121s]
    clock.nowMs = 2_000
    core.observe(
      .clock(
        positionSeconds: 120.0,
        rate: 0.0,
        durationSeconds: nil,
        liveEdgeSeconds: 121.0,
        liveSeekableStartSeconds: 61.0,
        timeShiftSupported: true
      ),
      serial: 1
    )
    #expect(core.liveSeekableWindow == LiveSeekableWindow(startSec: 61.0, endSec: 121.0))
    #expect(
      sink.events == [
        .clock(
          attempt: 2,
          anchor: ClockAnchorOut(
            positionMs: 120_000,
            atMs: 2_000,
            rate: 0.0,
            liveEdgeMs: 121_000,
            liveSeekableStartMs: 61_000,
            timeShiftSupported: true
          )
        ),
      ]
    )
  }
}

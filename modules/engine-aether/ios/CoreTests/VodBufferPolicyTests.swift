import ElvAetherCore
import Foundation
import Testing

@Suite("VodBufferPolicy")
struct VodBufferPolicyTests {
  private static let giB: UInt64 = 1_073_741_824
  private static let miB: Int64 = 1_048_576

  @Test("AppleBufferPreset.parse normalizes case/whitespace and falls back to .auto")
  func presetParsing() {
    #expect(AppleBufferPreset.parse(nil) == .auto)
    #expect(AppleBufferPreset.parse("") == .auto)
    #expect(AppleBufferPreset.parse("   ") == .auto)
    #expect(AppleBufferPreset.parse("unknown") == .auto)
    #expect(AppleBufferPreset.parse("auto") == .auto)
    #expect(AppleBufferPreset.parse("AUTO") == .auto)
    #expect(AppleBufferPreset.parse(" balanced ") == .balanced)
    #expect(AppleBufferPreset.parse("LaRgE\n") == .large)
  }

  @Test("live streams always disable VOD buffer policy regardless of preset, RAM, or backoff")
  func liveAlwaysDisabled() {
    for preset in [AppleBufferPreset.auto, .balanced, .large] {
      let budget = computeAppleVodBufferBudget(
        isLive: true,
        preset: preset,
        physicalMemoryBytes: 8 * Self.giB,
        throttleBackoffLevel: 2,
        lowMemoryPressure: false
      )
      #expect(
        budget
          == AppleVodBufferBudget(
            enabled: false,
            preferredForwardBufferDurationSeconds: 0,
            backTargetMs: 0,
            maxMemoryBytes: 0,
            throttleBackoffLevel: 0
          )
      )
    }
  }

  @Test("low-RAM tier (<= 2 GiB or lowMemoryPressure) enforces jetsam-safe ceilings")
  func lowRamTier() {
    let autoBudget = computeAppleVodBufferBudget(
      isLive: false,
      preset: .auto,
      physicalMemoryBytes: 2 * Self.giB
    )
    #expect(autoBudget.enabled)
    #expect(autoBudget.preferredForwardBufferDurationSeconds == 20)
    #expect(autoBudget.maxMemoryBytes <= 16 * Self.miB)
    #expect(autoBudget.backTargetMs > 0 && autoBudget.backTargetMs <= 8_000)

    let balancedBudget = computeAppleVodBufferBudget(
      isLive: false,
      preset: .balanced,
      physicalMemoryBytes: 2 * Self.giB
    )
    #expect(balancedBudget.preferredForwardBufferDurationSeconds == 25)
    #expect(balancedBudget.maxMemoryBytes <= 16 * Self.miB)
    #expect(balancedBudget.backTargetMs <= 8_000)

    let largeBudget = computeAppleVodBufferBudget(
      isLive: false,
      preset: .large,
      physicalMemoryBytes: 1 * Self.giB
    )
    #expect(largeBudget.preferredForwardBufferDurationSeconds == 30)
    #expect(largeBudget.maxMemoryBytes <= 16 * Self.miB)
    #expect(largeBudget.backTargetMs <= 8_000)

    // High-RAM device under active lowMemoryPressure falls back to the conservative tier.
    let pressured = computeAppleVodBufferBudget(
      isLive: false,
      preset: .large,
      physicalMemoryBytes: 6 * Self.giB,
      lowMemoryPressure: true
    )
    #expect(pressured.preferredForwardBufferDurationSeconds == 30)
    #expect(pressured.maxMemoryBytes <= 16 * Self.miB)
    #expect(pressured.backTargetMs <= 8_000)
  }

  @Test("shouldApplyAppleLowMemoryPressure triggers on serious/critical thermal state or active memory warning")
  func thermalAndMemoryPressureHelper() {
    #expect(!shouldApplyAppleLowMemoryPressure(thermalState: .nominal, memoryWarningActive: false))
    #expect(!shouldApplyAppleLowMemoryPressure(thermalState: .fair, memoryWarningActive: false))
    #expect(shouldApplyAppleLowMemoryPressure(thermalState: .serious, memoryWarningActive: false))
    #expect(shouldApplyAppleLowMemoryPressure(thermalState: .critical, memoryWarningActive: false))
    #expect(shouldApplyAppleLowMemoryPressure(thermalState: .nominal, memoryWarningActive: true))
    #expect(shouldApplyAppleLowMemoryPressure(thermalState: .fair, memoryWarningActive: true))

    let relaxed = computeAppleVodBufferBudget(
      isLive: false,
      preset: .large,
      physicalMemoryBytes: 6 * Self.giB,
      lowMemoryPressure: shouldApplyAppleLowMemoryPressure(thermalState: .fair, memoryWarningActive: false)
    )
    let thermallyPressured = computeAppleVodBufferBudget(
      isLive: false,
      preset: .large,
      physicalMemoryBytes: 6 * Self.giB,
      lowMemoryPressure: shouldApplyAppleLowMemoryPressure(thermalState: .serious, memoryWarningActive: false)
    )
    #expect(relaxed.preferredForwardBufferDurationSeconds == 150)
    #expect(thermallyPressured.preferredForwardBufferDurationSeconds == 30)
    #expect(thermallyPressured.maxMemoryBytes <= 16 * Self.miB)
  }

  @Test("mid-RAM tier (<= 3 GiB) scales auto/balanced/large for 3 GB Apple TV / iPad")
  func midRamTier() {
    let autoBudget = computeAppleVodBufferBudget(
      isLive: false,
      preset: .auto,
      physicalMemoryBytes: 3 * Self.giB
    )
    let balancedBudget = computeAppleVodBufferBudget(
      isLive: false,
      preset: .balanced,
      physicalMemoryBytes: 3 * Self.giB
    )
    let largeBudget = computeAppleVodBufferBudget(
      isLive: false,
      preset: .large,
      physicalMemoryBytes: 3 * Self.giB
    )

    #expect(autoBudget.preferredForwardBufferDurationSeconds == 35)
    #expect(balancedBudget.preferredForwardBufferDurationSeconds == 50)
    #expect(largeBudget.preferredForwardBufferDurationSeconds == 75)
    #expect(autoBudget.backTargetMs >= 12_000 && autoBudget.backTargetMs <= 20_000)
    #expect(balancedBudget.backTargetMs >= 12_000 && balancedBudget.backTargetMs <= 20_000)
    #expect(largeBudget.backTargetMs >= 12_000 && largeBudget.backTargetMs <= 20_000)
    #expect(autoBudget.backTargetMs < balancedBudget.backTargetMs)
    #expect(balancedBudget.backTargetMs < largeBudget.backTargetMs)
  }

  @Test("high-RAM tier (> 3 GiB) scales auto=60s, balanced=90s, large=150s")
  func highRamTier() {
    let autoBudget = computeAppleVodBufferBudget(
      isLive: false,
      preset: .auto,
      physicalMemoryBytes: 4 * Self.giB
    )
    let balancedBudget = computeAppleVodBufferBudget(
      isLive: false,
      preset: .balanced,
      physicalMemoryBytes: 6 * Self.giB
    )
    let largeBudget = computeAppleVodBufferBudget(
      isLive: false,
      preset: .large,
      physicalMemoryBytes: 8 * Self.giB
    )

    #expect(autoBudget.preferredForwardBufferDurationSeconds == 60)
    #expect(balancedBudget.preferredForwardBufferDurationSeconds == 90)
    #expect(largeBudget.preferredForwardBufferDurationSeconds == 150)
    #expect(autoBudget.backTargetMs >= 15_000 && autoBudget.backTargetMs <= 30_000)
    #expect(balancedBudget.backTargetMs >= 15_000 && balancedBudget.backTargetMs <= 30_000)
    #expect(largeBudget.backTargetMs >= 15_000 && largeBudget.backTargetMs <= 30_000)
  }

  @Test("429/509 throttle backoff increments within 0..3 and halves forward duration with 15s floor")
  func throttleBackoffProgression() {
    #expect(nextAppleThrottleBackoffLevel(current: 0, httpStatus: 200) == 0)
    #expect(nextAppleThrottleBackoffLevel(current: 0, httpStatus: 404) == 0)
    #expect(nextAppleThrottleBackoffLevel(current: 0, httpStatus: 429) == 1)
    #expect(nextAppleThrottleBackoffLevel(current: 1, httpStatus: 509) == 2)
    #expect(nextAppleThrottleBackoffLevel(current: 2, httpStatus: 429) == 3)
    #expect(nextAppleThrottleBackoffLevel(current: 3, httpStatus: 509) == 3)
    #expect(nextAppleThrottleBackoffLevel(current: -2, httpStatus: 429) == 1)
    #expect(nextAppleThrottleBackoffLevel(current: 9, httpStatus: 200) == 3)

    // High-RAM large (150s): 150 -> 75 -> 37.5 -> 18.75
    let b1 = computeAppleVodBufferBudget(
      isLive: false,
      preset: .large,
      physicalMemoryBytes: 4 * Self.giB,
      throttleBackoffLevel: 1
    )
    let b2 = computeAppleVodBufferBudget(
      isLive: false,
      preset: .large,
      physicalMemoryBytes: 4 * Self.giB,
      throttleBackoffLevel: 2
    )
    let b3 = computeAppleVodBufferBudget(
      isLive: false,
      preset: .large,
      physicalMemoryBytes: 4 * Self.giB,
      throttleBackoffLevel: 3
    )
    #expect(b1.preferredForwardBufferDurationSeconds == 75)
    #expect(b1.throttleBackoffLevel == 1)
    #expect(b2.preferredForwardBufferDurationSeconds == 37.5)
    #expect(b3.preferredForwardBufferDurationSeconds == 18.75)

    // High-RAM auto (60s): 60 -> 30 -> 15 -> 15 (15s floor)
    let floorCheck = computeAppleVodBufferBudget(
      isLive: false,
      preset: .auto,
      physicalMemoryBytes: 4 * Self.giB,
      throttleBackoffLevel: 3
    )
    #expect(floorCheck.preferredForwardBufferDurationSeconds == 15)
    #expect(floorCheck.throttleBackoffLevel == 3)

    // Low-RAM auto (20s): level 1 hits 15s floor immediately.
    let lowFloor = computeAppleVodBufferBudget(
      isLive: false,
      preset: .auto,
      physicalMemoryBytes: 2 * Self.giB,
      throttleBackoffLevel: 1
    )
    #expect(lowFloor.preferredForwardBufferDurationSeconds == 15)
  }

  @Test("extractAppleBufferHealth computes ahead/behind ms with 0.5s boundary tolerance and rejects invalid input")
  func extractBufferHealth() {
    #expect(extractAppleBufferHealth(ranges: [], currentTimeSeconds: 10) == nil)
    #expect(
      extractAppleBufferHealth(
        ranges: [LoadedTimeRangeSample(startSeconds: 0, durationSeconds: 30)],
        currentTimeSeconds: .nan
      ) == nil
    )
    #expect(
      extractAppleBufferHealth(
        ranges: [LoadedTimeRangeSample(startSeconds: 0, durationSeconds: 30)],
        currentTimeSeconds: -1
      ) == nil
    )
    #expect(
      extractAppleBufferHealth(
        ranges: [LoadedTimeRangeSample(startSeconds: .nan, durationSeconds: 10)],
        currentTimeSeconds: 5
      ) == nil
    )
    #expect(
      extractAppleBufferHealth(
        ranges: [LoadedTimeRangeSample(startSeconds: 0, durationSeconds: 0)],
        currentTimeSeconds: 0
      ) == nil
    )

    let nominal = extractAppleBufferHealth(
      ranges: [LoadedTimeRangeSample(startSeconds: 10, durationSeconds: 50)],
      currentTimeSeconds: 25
    )
    #expect(nominal == AppleBufferHealth(bufferedAheadMs: 35_000, bufferedBehindMs: 15_000, throttled: nil))

    // Boundary jitter within 0.5s before range start clamps behind to 0.
    let startJitter = extractAppleBufferHealth(
      ranges: [LoadedTimeRangeSample(startSeconds: 10.0, durationSeconds: 20.0)],
      currentTimeSeconds: 9.7
    )
    #expect(startJitter != nil)
    #expect(startJitter?.bufferedBehindMs == 0)
    #expect(abs((startJitter?.bufferedAheadMs ?? 0) - 20_300) < 1)

    // Boundary jitter within 0.5s past range end clamps ahead to 0.
    let endJitter = extractAppleBufferHealth(
      ranges: [LoadedTimeRangeSample(startSeconds: 10.0, durationSeconds: 20.0)],
      currentTimeSeconds: 30.3
    )
    #expect(endJitter != nil)
    #expect(endJitter?.bufferedAheadMs == 0)
    #expect(abs((endJitter?.bufferedBehindMs ?? 0) - 20_300) < 1)

    // Disjoint ranges: picks enclosing range, ignores unrelated range, returns nil when far outside.
    let disjoint = [
      LoadedTimeRangeSample(startSeconds: 0, durationSeconds: 15),
      LoadedTimeRangeSample(startSeconds: 100, durationSeconds: 45),
    ]
    let inSecond = extractAppleBufferHealth(ranges: disjoint, currentTimeSeconds: 110, throttled: true)
    #expect(inSecond == AppleBufferHealth(bufferedAheadMs: 35_000, bufferedBehindMs: 10_000, throttled: true))
    #expect(extractAppleBufferHealth(ranges: disjoint, currentTimeSeconds: 50) == nil)
  }

  @Test("bufferPreset propagates from LoadRequest to EngineLoadOptions keeping maxConcurrentSourceRequests = 1 and urlCache = nil")
  func loadOptionsAndSessionInvariants() throws {
    let req = LoadRequest(
      url: "https://cdn.example/movie/123.mp4",
      live: false,
      bufferPreset: .large
    )
    let plan = try #require(planMedia(req))
    let opts = loadOptions(for: plan, request: req)
    #expect(opts.bufferPreset == .large)
    #expect(!opts.isLive)
    #expect(opts.maxConcurrentSourceRequests == 1)

    let hlsVodReq = LoadRequest(
      url: "https://cdn.example/vod/master.m3u8",
      live: false,
      bufferPreset: .balanced
    )
    let hlsVodOpts = loadOptions(for: try #require(planMedia(hlsVodReq)), request: hlsVodReq)
    #expect(hlsVodOpts.bufferPreset == .balanced)
    #expect(hlsVodOpts.maxConcurrentSourceRequests == 1)

    let sessionCfg = makeStreamSessionConfiguration()
    #expect(sessionCfg.urlCache == nil)
    #expect(sessionCfg.httpMaximumConnectionsPerHost == 1)
  }

  @Test("ClockAnchorOut serializes bufferHealth cleanly with optional throttled flag")
  func clockAnchorPayloadSerialization() throws {
    let health = AppleBufferHealth(bufferedAheadMs: 42_000, bufferedBehindMs: 12_500, throttled: true)
    let anchor = ClockAnchorOut(
      positionMs: 30_000,
      atMs: 5_000,
      rate: 1.0,
      durationMs: 120_000,
      bufferHealth: health
    )
    let payload = EngineEventOut.clock(attempt: 2, anchor: anchor).payload
    let anchorDict = try #require(payload["anchor"] as? [String: Any])
    let bh = try #require(anchorDict["bufferHealth"] as? [String: Any])
    #expect((bh["bufferedAheadMs"] as? Double) == 42_000)
    #expect((bh["bufferedBehindMs"] as? Double) == 12_500)
    #expect((bh["throttled"] as? Bool) == true)

    let unthrottled = ClockAnchorOut(
      positionMs: 30_000,
      atMs: 5_000,
      rate: 1.0,
      bufferHealth: AppleBufferHealth(bufferedAheadMs: 10_000, bufferedBehindMs: 2_000, throttled: nil)
    )
    let unthrottledAnchor = try #require(EngineEventOut.clock(attempt: 2, anchor: unthrottled).payload["anchor"] as? [String: Any])
    let unthrottledBh = try #require(unthrottledAnchor["bufferHealth"] as? [String: Any])
    #expect(unthrottledBh["throttled"] == nil)

    let noHealthAnchor = try #require(
      EngineEventOut.clock(attempt: 2, anchor: ClockAnchorOut(positionMs: 0, atMs: 1_000, rate: 1.0)).payload["anchor"] as? [String: Any]
    )
    #expect(noHealthAnchor["bufferHealth"] == nil)
  }

  @Test("EngineCore emits VOD bufferHealth on ClockAnchor even when played && !stalled, and omits it for live")
  @MainActor
  func engineCoreVodAndLiveBufferHealth() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    // VOD session
    core.load(LoadRequest(url: "https://cdn.example/movie/1.mp4", live: false, bufferPreset: .balanced), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    sink.events.removeAll()

    // While played && !stalled, bufferHealth observation is retained and included in ClockAnchor.
    let bh1 = AppleBufferHealth(bufferedAheadMs: 30_000, bufferedBehindMs: 10_000, throttled: nil)
    core.observe(.bufferHealth(bh1), serial: 1)
    clock.nowMs = 2_000
    core.observe(.clock(positionSeconds: 15.0, rate: 1.0, durationSeconds: 120.0, liveEdgeSeconds: nil), serial: 1)

    #expect(
      sink.events
        == [
          .clock(
            attempt: 1,
            anchor: ClockAnchorOut(
              positionMs: 15_000,
              atMs: 2_000,
              rate: 1.0,
              durationMs: 120_000,
              bufferHealth: bh1
            )
          ),
        ]
    )

    // While actively playing (rate == 1.0), .bufferHealth MUST update stored buffer health
    // WITHOUT emitting a stale-position rewind anchor; the next real .clock tick carries it.
    sink.events.removeAll()
    let bh2 = AppleBufferHealth(bufferedAheadMs: 48_000, bufferedBehindMs: 16_000, throttled: true)
    clock.nowMs = 3_200
    core.observe(.bufferHealth(bh2), serial: 1)
    #expect(sink.events.isEmpty)

    clock.nowMs = 4_000
    core.observe(.clock(positionSeconds: 17.0, rate: 1.0, durationSeconds: 120.0, liveEdgeSeconds: nil), serial: 1)
    #expect(
      sink.events
        == [
          .clock(
            attempt: 1,
            anchor: ClockAnchorOut(
              positionMs: 17_000,
              atMs: 4_000,
              rate: 1.0,
              durationMs: 120_000,
              bufferHealth: bh2
            )
          ),
        ]
    )

    // While paused (rate == 0.0), .bufferHealth emits live read-ahead growth anchors with
    // >= 1_000 ms throttle and >= 500 ms delta (or throttled state change).
    clock.nowMs = 4_500
    core.pause(1)
    core.observe(.phase(.paused), serial: 1)
    sink.events.removeAll()

    // Within 1_000 ms throttle window: stored, not emitted yet.
    let bhPausedEarly = AppleBufferHealth(bufferedAheadMs: 55_000, bufferedBehindMs: 16_000, throttled: true)
    clock.nowMs = 5_100
    core.observe(.bufferHealth(bhPausedEarly), serial: 1)
    #expect(sink.events.isEmpty)

    // Past 1_000 ms throttle with >= 500 ms ahead growth: emits paused anchor with fresh health.
    let bhPausedGrown = AppleBufferHealth(bufferedAheadMs: 55_200, bufferedBehindMs: 16_000, throttled: true)
    clock.nowMs = 5_600
    core.observe(.bufferHealth(bhPausedGrown), serial: 1)
    #expect(
      sink.events
        == [
          .clock(
            attempt: 1,
            anchor: ClockAnchorOut(
              positionMs: 17_000,
              atMs: 5_600,
              rate: 0.0,
              durationMs: 120_000,
              bufferHealth: bhPausedGrown
            )
          ),
        ]
    )

    // Past 1_000 ms throttle, but sub-500 ms jitter without throttled change: suppressed.
    sink.events.removeAll()
    let bhPausedSmallDelta = AppleBufferHealth(bufferedAheadMs: 55_500, bufferedBehindMs: 16_000, throttled: true)
    clock.nowMs = 7_000
    core.observe(.bufferHealth(bhPausedSmallDelta), serial: 1)
    #expect(sink.events.isEmpty)

    // Cumulative growth across small ticks (>= 500 ms vs last emitted 55_200) emits cleanly.
    let bhPausedCumulative = AppleBufferHealth(bufferedAheadMs: 55_800, bufferedBehindMs: 16_000, throttled: true)
    clock.nowMs = 7_200
    core.observe(.bufferHealth(bhPausedCumulative), serial: 1)
    #expect(
      sink.events
        == [
          .clock(
            attempt: 1,
            anchor: ClockAnchorOut(
              positionMs: 17_000,
              atMs: 7_200,
              rate: 0.0,
              durationMs: 120_000,
              bufferHealth: bhPausedCumulative
            )
          ),
        ]
    )

    // Throttled flag change alone is meaningful even with identical ahead/behind ms.
    sink.events.removeAll()
    let bhPausedThrottleFlip = AppleBufferHealth(bufferedAheadMs: 55_800, bufferedBehindMs: 16_000, throttled: nil)
    clock.nowMs = 8_500
    core.observe(.bufferHealth(bhPausedThrottleFlip), serial: 1)
    #expect(
      sink.events
        == [
          .clock(
            attempt: 1,
            anchor: ClockAnchorOut(
              positionMs: 17_000,
              atMs: 8_500,
              rate: 0.0,
              durationMs: 120_000,
              bufferHealth: bhPausedThrottleFlip
            )
          ),
        ]
    )

    // Live session: bufferHealth is strictly omitted (nil) even if reported.
    core.load(LoadRequest(url: "https://cdn.example/live/1.m3u8", live: true, bufferPreset: .large), attempt: 2)
    core.observe(.firstFrame, serial: 2)
    core.observe(.phase(.playing), serial: 2)
    sink.events.removeAll()

    core.observe(.bufferHealth(bh2), serial: 2)
    clock.nowMs = 10_000
    core.observe(
      .clock(positionSeconds: 10.0, rate: 1.0, durationSeconds: nil, liveEdgeSeconds: 12.0, bufferHealth: bh2),
      serial: 2
    )
    #expect(
      sink.events
        == [
          .clock(
            attempt: 2,
            anchor: ClockAnchorOut(
              positionMs: 10_000,
              atMs: 10_000,
              rate: 1.0,
              liveEdgeMs: 12_000,
              bufferHealth: nil
            )
          ),
        ]
    )
  }
}

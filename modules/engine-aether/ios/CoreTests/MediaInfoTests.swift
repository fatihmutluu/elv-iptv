import ElvAetherCore
import Testing

@Suite("StreamVideoInfo & mediaInfo propagation")
@MainActor
struct MediaInfoTests {
  private func makeHarness() -> (EngineCore, FakeBackend, RecordingSink, FakeClock) {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })
    return (core, backend, sink, clock)
  }

  @Test("propagates, merges, deduplicates, and serializes .mediaInfo events on active serial")
  func mediaInfoPropagationMergeAndDedup() {
    let (core, _, sink, _) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/1.mp4", live: false), attempt: 4)
    sink.events.removeAll()

    core.observe(
      .mediaInfo(StreamVideoInfo(width: 3840, height: 2160, hdr: "hdr10")),
      serial: 1
    )
    let expectedFirst = StreamVideoInfo(width: 3840, height: 2160, hdr: "hdr10")
    #expect(sink.events == [.mediaInfo(attempt: 4, info: expectedFirst)])

    // Identical info is deduplicated
    core.observe(.mediaInfo(expectedFirst), serial: 1)
    #expect(sink.events.count == 1)

    // Incremental update merges codec and fps and adopts newer command token
    core.pause(5)
    core.observe(.mediaInfo(StreamVideoInfo(fps: 59.94, codec: " hevc ")), serial: 1)
    let expectedMerged = StreamVideoInfo(width: 3840, height: 2160, fps: 59.94, codec: "hevc", hdr: "hdr10")
    #expect(sink.events.last == .mediaInfo(attempt: 5, info: expectedMerged))

    // Verify JS payload serialization
    let payload = sink.events.last?.payload
    #expect(payload?["type"] as? String == "mediaInfo")
    #expect(payload?["attempt"] as? Int == 5)
    let infoDict = payload?["info"] as? [String: Any]
    #expect(infoDict?["width"] as? Int == 3840)
    #expect(infoDict?["height"] as? Int == 2160)
    #expect(infoDict?["fps"] as? Double == 59.94)
    #expect(infoDict?["codec"] as? String == "hevc")
    #expect(infoDict?["hdr"] as? String == "hdr10")
  }

  @Test("drops stale-serial .mediaInfo events and resets deduplication on new load or stop")
  func staleSerialFilteringAndReset() {
    let (core, _, sink, _) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 1)
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1002.ts"), attempt: 2)
    sink.events.removeAll()

    // Stale serial 1 is dropped
    let hd = StreamVideoInfo(width: 1920, height: 1080, fps: 50, codec: "h264", hdr: "sdr")
    core.observe(.mediaInfo(hd), serial: 1)
    #expect(sink.events.isEmpty)

    // Active serial 2 succeeds
    core.observe(.mediaInfo(hd), serial: 2)
    #expect(sink.events == [.mediaInfo(attempt: 2, info: hd)])

    // Stop drops subsequent observations on old serial
    core.stop(3)
    sink.events.removeAll()
    core.observe(.mediaInfo(StreamVideoInfo(width: 3840, height: 2160)), serial: 2)
    #expect(sink.events.isEmpty)

    // New load resets deduplication so identical hd metadata emits again cleanly
    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1003.ts"), attempt: 4)
    sink.events.removeAll()
    core.observe(.mediaInfo(hd), serial: 4)
    #expect(sink.events == [.mediaInfo(attempt: 4, info: hd)])
  }

  @Test("CommandFence fences .mediaInfo by mediaEpoch while adopting latest in-epoch token")
  func commandFenceFiltersMediaInfo() throws {
    let fence = CommandFence()
    let epoch1 = try #require(fence.recordLoad(attempt: 10))
    #expect(fence.beginMedia(epoch: epoch1) == .run(epoch: epoch1, rebuildFirst: false))

    let pauseEpoch = try #require(fence.recordInEpochCommand(attempt: 11))
    #expect(pauseEpoch == epoch1)

    let info = StreamVideoInfo(width: 1920, height: 1080, fps: 60, codec: "hevc", hdr: "dv")
    #expect(
      fence.filterOutbound(.mediaInfo(attempt: 10, info: info), driverEpoch: epoch1)
        == .mediaInfo(attempt: 11, info: info)
    )

    // New media epoch strictly drops stale-epoch mediaInfo
    let epoch2 = try #require(fence.recordLoad(attempt: 12))
    #expect(fence.filterOutbound(.mediaInfo(attempt: 11, info: info), driverEpoch: epoch1) == nil)
    #expect(
      fence.filterOutbound(.mediaInfo(attempt: 12, info: info), driverEpoch: epoch2)
        == .mediaInfo(attempt: 12, info: info)
    )
  }
}

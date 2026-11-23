import ElvAetherCore
import Foundation
import Testing

@Suite("MediaPlan")
struct MediaPlanTests {
  @Test(".M3U8?x=1 and .m3u paths route to HLS keeping the live flag")
  func hlsRouting() throws {
    let liveReq = LoadRequest(url: "http://h:7878/hls/demo/demo/1001.M3U8?x=1", live: true)
    let livePlan = try #require(planMedia(liveReq))
    #expect(livePlan == .hls(URL(string: "http://h:7878/hls/demo/demo/1001.M3U8?x=1")!, live: true))

    let vodHlsReq = LoadRequest(url: "https://cdn.example/vod/master.m3u", live: false)
    let vodHlsPlan = try #require(planMedia(vodHlsReq))
    #expect(vodHlsPlan == .hls(URL(string: "https://cdn.example/vod/master.m3u")!, live: false))
  }

  @Test("non-HLS VOD converts finite startMs to seconds and non-HLS live routes to liveTs")
  func vodAndLiveTsRouting() throws {
    let vodReq = LoadRequest(url: "http://h:7878/movie/demo/demo/200001.mp4", live: false, startMs: 12_500)
    let vodPlan = try #require(planMedia(vodReq))
    #expect(vodPlan == .vod(URL(string: "http://h:7878/movie/demo/demo/200001.mp4")!, startSeconds: 12.5))

    let nanVod = LoadRequest(url: "http://h:7878/movie/demo/demo/200001.mp4", live: false, startMs: .nan)
    #expect(try #require(planMedia(nanVod)) == .vod(URL(string: "http://h:7878/movie/demo/demo/200001.mp4")!, startSeconds: nil))

    let tsReq = LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts", live: true)
    let tsPlan = try #require(planMedia(tsReq))
    #expect(tsPlan == .liveTs(URL(string: "http://h:7878/live/demo/demo/1001.ts")!))
  }

  @Test("garbage or non-HTTP URL returns nil")
  func garbageUrlReturnsNil() {
    #expect(planMedia(LoadRequest(url: "")) == nil)
    #expect(planMedia(LoadRequest(url: "not a url")) == nil)
    #expect(planMedia(LoadRequest(url: "http://")) == nil)
    #expect(planMedia(LoadRequest(url: ":///live/1.ts")) == nil)
    #expect(planMedia(LoadRequest(url: "file:///etc/passwd")) == nil)
    #expect(planMedia(LoadRequest(url: "ftp://example.com/1.ts")) == nil)
  }

  @Test("VOD and HLS cap concurrent requests at 1, keep hardware video on softwareAudio, and configure #228/#231 defaults")
  func optionsConstruction() throws {
    let vodReq = LoadRequest(
      url: "http://h:7878/movie/demo/demo/200001.mp4",
      headers: ["User-Agent": "ELV/0.1\r\nInjected: 1", "Bad Header": "drop"],
      live: false,
      softwareAudio: true
    )
    let vodPlan = try #require(planMedia(vodReq))
    let vodOpts = loadOptions(for: vodPlan, request: vodReq)
    #expect(!vodOpts.isLive)
    #expect(vodOpts.httpHeaders == ["User-Agent": "ELV/0.1Injected: 1"])
    #expect(vodOpts.maxConcurrentSourceRequests == 1)
    #expect(!vodOpts.preferSoftwareDecode)
    #expect(vodOpts.displayCriteriaOwner == .engine)
    #expect(EngineLoadOptions(isLive: true).displayCriteriaOwner == .engine)
    #expect(!vodOpts.generatesBackgroundScrubPreviews)
    #expect(vodOpts.skipsContainerAttachments)
    #expect(!vodOpts.hostRetriesExhaustedLiveReplay)

    let liveHlsReq = LoadRequest(
      url: "http://h:7878/hls/demo/demo/1001.m3u8",
      live: true,
      liveEdgeCushionSeconds: 6.0
    )
    let liveHlsPlan = try #require(planMedia(liveHlsReq))
    let liveHlsOpts = loadOptions(for: liveHlsPlan, request: liveHlsReq)
    #expect(liveHlsOpts.isLive)
    #expect(liveHlsOpts.maxConcurrentSourceRequests == 1)
    #expect(liveHlsOpts.hostRetriesExhaustedLiveReplay)
    #expect(liveHlsOpts.liveEdgeCushionSeconds == 6.0)

    let vodHlsReq = LoadRequest(url: "http://h:7878/hls/demo/demo/2001.m3u8", live: false)
    let vodHlsOpts = loadOptions(for: try #require(planMedia(vodHlsReq)), request: vodHlsReq)
    #expect(vodHlsOpts.maxConcurrentSourceRequests == 1)
    #expect(!vodHlsOpts.hostRetriesExhaustedLiveReplay)
  }

  @Test("liveTs carries Candidate C startup values and hlsHandoffOptions resets them cleanly")
  func liveTsAndHlsHandoffOptions() throws {
    let tsReq = LoadRequest(
      url: "http://h:7878/live/demo/demo/1001.ts",
      headers: ["Referer": "http://panel.example/"],
      live: true
    )
    let tsPlan = try #require(planMedia(tsReq))
    var tsOpts = loadOptions(for: tsPlan, request: tsReq)
    #expect(tsOpts.liveStartupGraceSeconds == 0)
    #expect(tsOpts.liveStartupSingleSegmentMinimumSeconds == 1.0)
    #expect(tsOpts.maxConcurrentSourceRequests == nil)
    #expect(!tsOpts.hostRetriesExhaustedLiveReplay)

    tsOpts.audioStreamIndex = 2
    tsOpts.preferredAudioLanguages = ["tur"]
    tsOpts.subtitlesDisabled = true

    let handoff = hlsHandoffOptions(from: tsOpts)
    #expect(handoff.isLive)
    #expect(handoff.maxConcurrentSourceRequests == 1)
    #expect(handoff.hostRetriesExhaustedLiveReplay)
    #expect(handoff.liveStartupGraceSeconds == nil)
    #expect(handoff.liveStartupSingleSegmentMinimumSeconds == nil)
    #expect(handoff.probesize == nil)
    #expect(handoff.maxAnalyzeDurationMicros == nil)
    #expect(handoff.audioStreamIndex == 2)
    #expect(handoff.preferredAudioLanguages == ["tur"])
    #expect(handoff.subtitlesDisabled)
    #expect(handoff.httpHeaders == ["Referer": "http://panel.example/"])
  }

  @Test("allowLegacyTls defaults to false and propagates cleanly through loadOptions and hlsHandoffOptions (#182)")
  func allowLegacyTlsPropagation() throws {
    let defaultReq = LoadRequest(url: "https://modern.example/live/1.ts", live: true)
    let defaultOpts = loadOptions(for: try #require(planMedia(defaultReq)), request: defaultReq)
    #expect(!defaultReq.allowLegacyTls)
    #expect(!defaultOpts.allowLegacyTls)

    let legacyReq = LoadRequest(url: "https://legacy.example/live/1.ts", live: true, allowLegacyTls: true)
    let legacyOpts = loadOptions(for: try #require(planMedia(legacyReq)), request: legacyReq)
    #expect(legacyReq.allowLegacyTls)
    #expect(legacyOpts.allowLegacyTls)
    #expect(hlsHandoffOptions(from: legacyOpts).allowLegacyTls)
  }
}

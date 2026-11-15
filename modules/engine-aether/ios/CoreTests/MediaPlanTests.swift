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

  @Test("non-HLS VOD converts startMs to seconds and non-HLS live routes to liveTs")
  func vodAndLiveTsRouting() throws {
    let vodReq = LoadRequest(url: "http://h:7878/movie/demo/demo/200001.mp4", live: false, startMs: 12_500)
    let vodPlan = try #require(planMedia(vodReq))
    #expect(vodPlan == .vod(URL(string: "http://h:7878/movie/demo/demo/200001.mp4")!, startSeconds: 12.5))

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

  @Test("VOD options cap concurrent source requests at 1; HLS and liveTs do not; softwareAudio maps to preferSoftwareDecode")
  func optionsConstruction() throws {
    let vodReq = LoadRequest(
      url: "http://h:7878/movie/demo/demo/200001.mp4",
      headers: ["User-Agent": "ELV/0.1"],
      live: false,
      softwareAudio: true
    )
    let vodPlan = try #require(planMedia(vodReq))
    let vodOpts = loadOptions(for: vodPlan, request: vodReq)
    #expect(!vodOpts.isLive)
    #expect(vodOpts.httpHeaders == ["User-Agent": "ELV/0.1"])
    #expect(vodOpts.maxConcurrentSourceRequests == 1)
    #expect(vodOpts.preferSoftwareDecode)

    let hlsReq = LoadRequest(url: "http://h:7878/hls/demo/demo/1001.m3u8", live: true)
    let hlsPlan = try #require(planMedia(hlsReq))
    let hlsOpts = loadOptions(for: hlsPlan, request: hlsReq)
    #expect(hlsOpts.isLive)
    #expect(hlsOpts.maxConcurrentSourceRequests == nil)
    #expect(!hlsOpts.preferSoftwareDecode)

    let tsReq = LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts", live: true)
    let tsPlan = try #require(planMedia(tsReq))
    let tsOpts = loadOptions(for: tsPlan, request: tsReq)
    #expect(tsOpts.isLive)
    #expect(tsOpts.maxConcurrentSourceRequests == nil)
  }
}

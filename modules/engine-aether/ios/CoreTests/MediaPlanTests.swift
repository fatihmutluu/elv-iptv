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

  @Test("dnsFamily and validated hostOverride default cleanly and propagate through loadOptions and hlsHandoffOptions (#172)")
  func networkTransportOptionsPropagation() throws {
    let defaultReq = LoadRequest(url: "https://edge.example/live/1.ts", live: true)
    let defaultOpts = loadOptions(for: try #require(planMedia(defaultReq)), request: defaultReq)
    #expect(defaultReq.dnsFamily == .system)
    #expect(defaultReq.hostOverride == nil)
    #expect(defaultOpts.dnsFamily == .system)
    #expect(defaultOpts.hostOverride == nil)

    let ipv6Req = LoadRequest(
      url: "https://edge.example/live/1.ts",
      live: true,
      dnsFamily: .ipv6,
      hostOverride: "[2001:DB8::1]"
    )
    let ipv6Opts = loadOptions(for: try #require(planMedia(ipv6Req)), request: ipv6Req)
    #expect(ipv6Opts.dnsFamily == .ipv6)
    #expect(ipv6Opts.hostOverride == "2001:db8::1")
    let handoff = hlsHandoffOptions(from: ipv6Opts)
    #expect(handoff.dnsFamily == .ipv6)
    #expect(handoff.hostOverride == "2001:db8::1")

    let invalidOverrideReq = LoadRequest(
      url: "https://edge.example/live/1.ts",
      live: true,
      dnsFamily: .ipv4,
      hostOverride: "192.0.2.1:8080"
    )
    let sanitizedOpts = loadOptions(for: try #require(planMedia(invalidOverrideReq)), request: invalidOverrideReq)
    #expect(sanitizedOpts.dnsFamily == .ipv4)
    #expect(sanitizedOpts.hostOverride == nil)
  }

  @Test("displaySync preferences map displayCriteriaOwner and survive hlsHandoffOptions (#188, #116)")
  func displaySyncOptionsPropagation() throws {
    let disabledReq = LoadRequest(
      url: "https://tv.example/live/101.ts",
      live: true,
      autoFrameRate: .off,
      autoDynamicRange: false
    )
    let disabledOpts = loadOptions(for: try #require(planMedia(disabledReq)), request: disabledReq)
    #expect(disabledOpts.displayCriteriaOwner == .host)
    #expect(disabledOpts.displaySync == .disabled)
    let disabledHandoff = hlsHandoffOptions(from: disabledOpts)
    #expect(disabledHandoff.displayCriteriaOwner == .host)
    #expect(disabledHandoff.displaySync == .disabled)

    let afrOnlyReq = LoadRequest(
      url: "https://tv.example/live/102.ts",
      live: true,
      autoFrameRate: .always,
      autoDynamicRange: false
    )
    let afrOnlyOpts = loadOptions(for: try #require(planMedia(afrOnlyReq)), request: afrOnlyReq)
    #expect(afrOnlyOpts.displayCriteriaOwner == .engine)
    #expect(afrOnlyOpts.displaySync == AppleDisplaySyncSettings(autoFrameRate: .always, autoDynamicRange: false))
    #expect(hlsHandoffOptions(from: afrOnlyOpts).displaySync == afrOnlyOpts.displaySync)
  }

  @Test("planMedia allows only verified managed download file:// URLs inside allowedDownloadsRoot")
  func managedDownloadFileAllowlist() throws {
    let fm = FileManager.default
    let baseDir = fm.temporaryDirectory.appendingPathComponent("elv-aether-downloads-test-\(UUID().uuidString)", isDirectory: true)
    let downloadsDir = baseDir.appendingPathComponent("downloads", isDirectory: true)
    let outsideDir = baseDir.appendingPathComponent("outside", isDirectory: true)
    try fm.createDirectory(at: downloadsDir, withIntermediateDirectories: true)
    try fm.createDirectory(at: outsideDir, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: baseDir) }

    let validMovie = downloadsDir.appendingPathComponent("movie-101.mp4")
    fm.createFile(atPath: validMovie.path, contents: Data([0x00, 0x00, 0x00, 0x18]))
    let outsideMovie = outsideDir.appendingPathComponent("secret.mp4")
    fm.createFile(atPath: outsideMovie.path, contents: Data([0x00, 0x00, 0x00, 0x18]))
    let symlinkEscape = downloadsDir.appendingPathComponent("escape.mp4")
    try fm.createSymbolicLink(at: symlinkEscape, withDestinationURL: outsideMovie)
    let directoryPretendingToBeVideo = downloadsDir.appendingPathComponent("fake-dir.mp4", isDirectory: true)
    try fm.createDirectory(at: directoryPretendingToBeVideo, withIntermediateDirectories: true)
    let missingMovie = downloadsDir.appendingPathComponent("missing-movie.mp4")

    // Default allowedDownloadsRoot (nil) always rejects file:// URLs.
    #expect(planMedia(LoadRequest(url: validMovie.absoluteString, live: false)) == nil)
    #expect(isAllowedManagedDownloadFileURL(validMovie, allowedDownloadsRoot: downloadsDir))

    // Valid managed download resolves as .vod with startSeconds.
    let planned = try #require(
      planMedia(
        LoadRequest(url: validMovie.absoluteString, live: false, startMs: 15_000),
        allowedDownloadsRoot: downloadsDir
      )
    )
    #expect(planned == .vod(validMovie.standardizedFileURL.resolvingSymlinksInPath(), startSeconds: 15.0))

    // Reject outside files, symlinks escaping root, directories matching video extensions, missing files, traversal, query/fragment, remote authority, and non-video extensions.
    #expect(!isAllowedManagedDownloadFileURL(directoryPretendingToBeVideo, allowedDownloadsRoot: downloadsDir))
    #expect(planMedia(LoadRequest(url: directoryPretendingToBeVideo.absoluteString, live: false), allowedDownloadsRoot: downloadsDir) == nil)
    #expect(!isAllowedManagedDownloadFileURL(missingMovie, allowedDownloadsRoot: downloadsDir))
    #expect(planMedia(LoadRequest(url: missingMovie.absoluteString, live: false), allowedDownloadsRoot: downloadsDir) == nil)
    #expect(planMedia(LoadRequest(url: outsideMovie.absoluteString, live: false), allowedDownloadsRoot: downloadsDir) == nil)
    #expect(planMedia(LoadRequest(url: symlinkEscape.absoluteString, live: false), allowedDownloadsRoot: downloadsDir) == nil)
    #expect(planMedia(LoadRequest(url: "\(downloadsDir.absoluteString)../outside/secret.mp4", live: false), allowedDownloadsRoot: downloadsDir) == nil)
    #expect(planMedia(LoadRequest(url: "\(validMovie.absoluteString)?token=1", live: false), allowedDownloadsRoot: downloadsDir) == nil)
    #expect(planMedia(LoadRequest(url: "\(validMovie.absoluteString)#t=10", live: false), allowedDownloadsRoot: downloadsDir) == nil)
    #expect(planMedia(LoadRequest(url: "file://evil.example/downloads/movie.mp4", live: false), allowedDownloadsRoot: downloadsDir) == nil)
    #expect(planMedia(LoadRequest(url: downloadsDir.appendingPathComponent("notes.txt").absoluteString, live: false), allowedDownloadsRoot: downloadsDir) == nil)
  }
}

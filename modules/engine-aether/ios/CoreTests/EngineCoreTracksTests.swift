import ElvAetherCore
import Foundation
import Testing

@Suite("EngineCore Tracks")
@MainActor
struct EngineCoreTracksTests {
  private func makeHarness() -> (EngineCore, FakeBackend, RecordingSink, FakeClock) {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })
    return (core, backend, sink, clock)
  }

  private let sampleTracks = MediaTracksOut(
    audio: [
      TrackInfoOut(id: "a:1", language: "tur", label: "Turkish", codec: "aac", channels: 2, isDefault: true),
      TrackInfoOut(id: "a:2", language: "eng", label: "English", codec: "aac", channels: 2),
    ],
    subtitles: [
      TrackInfoOut(id: "s:3", language: "tur", label: "Turkish", codec: "subrip"),
      TrackInfoOut(id: "s:4", language: "eng", label: "English", codec: "subrip"),
    ],
    selectedAudioId: "a:1",
    selectedSubtitleId: nil
  )

  @Test("track stream ID parsers accept non-negative prefixed IDs and reject malformed, negative, or cross-prefixed IDs")
  func strictTrackIdParsing() {
    #expect(parseAudioTrackStreamId("a:0") == 0)
    #expect(parseAudioTrackStreamId(" a:12 ") == 12)
    #expect(parseAudioTrackStreamId("a:-1") == nil)
    #expect(parseAudioTrackStreamId("a:+2") == nil)
    #expect(parseAudioTrackStreamId("s:2") == nil)
    #expect(parseAudioTrackStreamId("2") == nil)
    #expect(parseAudioTrackStreamId("a:99999999999") == nil)

    #expect(parseSubtitleTrackStreamId("s:0") == 0)
    #expect(parseSubtitleTrackStreamId(" s:7 ") == 7)
    #expect(parseSubtitleTrackStreamId("s:-4") == nil)
    #expect(parseSubtitleTrackStreamId("a:7") == nil)
    #expect(parseSubtitleTrackStreamId("7") == nil)
  }

  @Test("ISO 639-1, ISO 639-2(T/B), and BCP-47 language codes match while undetermined tags never match")
  func iso639Equivalence() {
    #expect(sameTrackLanguage("tr", "tur"))
    #expect(sameTrackLanguage("tr-TR", "tur"))
    #expect(sameTrackLanguage("de", "ger"))
    #expect(sameTrackLanguage("deu", "ger"))
    #expect(sameTrackLanguage("en-US", "eng"))
    #expect(!sameTrackLanguage("und", "und"))
    #expect(!sameTrackLanguage("zxx", "zxx"))
    #expect(!sameTrackLanguage(nil, "eng"))
  }

  @Test("tracks observations are serial-fenced, deduplicated, and formatted for JS payload")
  func tracksObservationFencedAndDeduplicated() {
    let (core, _, sink, _) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200011.mkv", live: false), attempt: 1)
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200010.mp4", live: false), attempt: 2)
    sink.events.removeAll()

    core.observe(.tracks(sampleTracks), serial: 1)
    #expect(sink.events.isEmpty)

    core.observe(.tracks(sampleTracks), serial: 2)
    core.observe(.tracks(sampleTracks), serial: 2)
    #expect(sink.events == [.tracks(attempt: 2, tracks: sampleTracks)])

    let payload = sink.events[0].payload
    #expect(payload["attempt"] as? Int == 2)
    #expect(payload["type"] as? String == "tracks")
    let tracksDict = payload["tracks"] as? [String: Any]
    #expect(tracksDict?["selectedAudioId"] as? String == "a:1")
    #expect((tracksDict?["audio"] as? [[String: Any]])?.count == 2)
    #expect((tracksDict?["subtitles"] as? [[String: Any]])?.count == 2)
  }

  @Test("selectAudioTrack and selectSubtitleTrack adopt tokens, ignore malformed IDs, and clear cues on Off")
  func selectTracksAdoptsTokensAndClearsOnOff() {
    let (core, backend, sink, _) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200011.mkv", live: false), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    core.observe(.tracks(sampleTracks), serial: 1)
    backend.calls.removeAll()
    sink.events.removeAll()
    sink.clearSubtitlesCount = 0

    core.selectAudioTrack(4, id: "a:-1")
    #expect(backend.calls.isEmpty)

    core.selectAudioTrack(5, id: "a:2")
    #expect(backend.calls == [.selectAudioTrack(2)])

    var withEngAudioAndTurSub = sampleTracks
    withEngAudioAndTurSub.selectedAudioId = "a:2"
    withEngAudioAndTurSub.selectedSubtitleId = "s:3"

    core.selectSubtitleTrack(6, id: "s:3")
    #expect(backend.calls == [.selectAudioTrack(2), .selectSubtitleTrack(3)])
    core.observe(.tracks(withEngAudioAndTurSub), serial: 1)
    #expect(sink.events == [.tracks(attempt: 6, tracks: withEngAudioAndTurSub)])

    sink.events.removeAll()
    backend.calls.removeAll()
    core.selectSubtitleTrack(7, id: nil)
    #expect(sink.clearSubtitlesCount == 1)
    #expect(backend.calls == [.selectSubtitleTrack(nil)])

    var expectedOff = withEngAudioAndTurSub
    expectedOff.selectedSubtitleId = nil
    #expect(sink.events == [.tracks(attempt: 7, tracks: expectedOff)])
  }

  @Test("track preferences persist across retry and recreate+load with ISO-639 and label tie-breaking")
  func trackPreferencesPersistAcrossRetryAndRecreate() {
    let (core, backend, sink, _) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200011.mkv", live: false), attempt: 1)
    core.observe(.tracks(sampleTracks), serial: 1)
    core.selectAudioTrack(2, id: "a:2")
    core.selectSubtitleTrack(3, id: "s:3")

    backend.calls.removeAll()
    sink.events.removeAll()
    sink.clearSubtitlesCount = 0

    core.retry(4)
    #expect(sink.clearSubtitlesCount == 1)
    #expect(
      backend.calls == [
        .stopMedia,
        .start(
          .vod(URL(string: "http://h:7878/movie/demo/demo/200011.mkv")!, startSeconds: nil),
          EngineLoadOptions(
            isLive: false,
            maxConcurrentSourceRequests: 1,
            audioStreamIndex: 2,
            preferredAudioLanguages: ["eng"],
            initialSubtitleTrackId: 3,
            preferredSubtitleLanguages: ["tur"],
            subtitlesDisabled: false
          ),
          2
        ),
      ]
    )

    core.recreate(5)
    backend.calls.removeAll()
    sink.events.removeAll()

    core.load(
      LoadRequest(
        url: "http://h:7878/movie/demo/demo/200011.mkv",
        live: false,
        startMs: 18_000,
        audioTrackId: "a:2",
        subtitlePreference: .selected("s:3")
      ),
      attempt: 6
    )
    sink.events.removeAll()
    backend.calls.removeAll()

    // Simulate reload where ISO-639-1 ("en"/"tr") replaced ISO-639-2 ("eng"/"tur") AND stream IDs swapped!
    let shiftedObserved = MediaTracksOut(
      audio: [
        TrackInfoOut(id: "a:2", language: "en", label: "Commentary", codec: "aac", channels: 2),
        TrackInfoOut(id: "a:5", language: "en", label: "English", codec: "aac", channels: 2),
      ],
      subtitles: [
        TrackInfoOut(id: "s:7", language: "tr", label: "Turkish", codec: "subrip"),
        TrackInfoOut(id: "s:8", language: "en", label: "English", codec: "subrip"),
      ],
      selectedAudioId: "a:2",
      selectedSubtitleId: nil
    )
    core.observe(.tracks(shiftedObserved), serial: 4)

    // Label tie-breaker chooses a:5 ("English") over exact-ID a:2 ("Commentary"), and ISO-639 matches "tr" == "tur" -> s:7.
    #expect(backend.calls == [.selectAudioTrack(5), .selectSubtitleTrack(7)])
    var reconciled = shiftedObserved
    reconciled.selectedAudioId = "a:5"
    reconciled.selectedSubtitleId = "s:7"
    #expect(sink.events == [.tracks(attempt: 6, tracks: reconciled)])
  }

  @Test("reconcile applies audio/subtitle overrides at most once per load so liveTs fallback never loops")
  func reconcileAppliesOncePerLoadWithoutInfiniteReloadLoop() {
    let (core, backend, sink, _) = makeHarness()
    core.load(
      LoadRequest(
        url: "http://h:7878/live/demo/demo/1001.ts",
        live: true,
        audioTrackId: "a:2",
        subtitlePreference: .selected("s:4")
      ),
      attempt: 1
    )
    backend.calls.removeAll()
    sink.events.removeAll()

    // First observation reports backend fell back to a:1 / nil -> reconcile issues selectAudioTrack(2) & selectSubtitleTrack(4) ONCE.
    core.observe(.tracks(sampleTracks), serial: 1)
    #expect(backend.calls == [.selectAudioTrack(2), .selectSubtitleTrack(4)])

    backend.calls.removeAll()
    // Repeated observations in the same load where backend still reports a:1 / nil MUST NOT trigger another reload!
    core.observe(.tracks(sampleTracks), serial: 1)
    #expect(backend.calls.isEmpty)
  }

  @Test("explicit subtitle Off clears auto-selected backend subtitle track once per auto-selection")
  func explicitOffClearsAutoSelectedSubtitle() {
    let (core, backend, sink, _) = makeHarness()
    core.load(
      LoadRequest(
        url: "http://h:7878/live/demo/demo/1010.m3u8",
        live: true,
        subtitlePreference: .off
      ),
      attempt: 1
    )
    backend.calls.removeAll()
    sink.events.removeAll()

    var autoSelected = sampleTracks
    autoSelected.selectedSubtitleId = "s:3"
    core.observe(.tracks(autoSelected), serial: 1)

    #expect(backend.calls == [.selectSubtitleTrack(nil)])
    var forcedOff = autoSelected
    forcedOff.selectedSubtitleId = nil
    #expect(sink.events == [.tracks(attempt: 1, tracks: forcedOff)])
  }
}

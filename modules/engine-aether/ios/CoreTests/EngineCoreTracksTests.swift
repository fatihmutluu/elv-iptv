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

  @Test("parseLoadRequest distinguishes omitted, null Off, and selected subtitleTrackId")
  func parseLoadRequestDistinguishesSubtitlePreference() {
    let omitted = parseLoadRequest([
      "attempt": 1,
      "url": "http://127.0.0.1:7878/movie/demo/demo/200011.mkv",
      "kind": "vod",
    ])
    #expect(omitted.attempt == 1)
    #expect(omitted.request.audioTrackId == nil)
    #expect(omitted.request.subtitlePreference == .default)

    let explicitNull = parseLoadRequest([
      "attempt": 2,
      "url": "http://127.0.0.1:7878/movie/demo/demo/200011.mkv",
      "kind": "vod",
      "audioTrackId": "a:2",
      "subtitleTrackId": nil,
    ])
    #expect(explicitNull.attempt == 2)
    #expect(explicitNull.request.audioTrackId == "a:2")
    #expect(explicitNull.request.subtitlePreference == .off)

    let nsNull = parseLoadRequest([
      "attempt": 3,
      "url": "http://127.0.0.1:7878/movie/demo/demo/200011.mkv",
      "kind": "vod",
      "subtitleTrackId": NSNull(),
    ])
    #expect(nsNull.request.subtitlePreference == .off)

    let selected = parseLoadRequest([
      "attempt": 4,
      "url": "http://127.0.0.1:7878/movie/demo/demo/200011.mkv",
      "kind": "vod",
      "audioTrackId": "a:2",
      "subtitleTrackId": "s:3",
    ])
    #expect(selected.request.audioTrackId == "a:2")
    #expect(selected.request.subtitlePreference == .selected("s:3"))
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

  @Test("selectAudioTrack and selectSubtitleTrack adopt tokens, drive backend, and clear cues on Off")
  func selectTracksAdoptsTokensAndClearsOnOff() {
    let (core, backend, sink, _) = makeHarness()
    core.load(LoadRequest(url: "http://h:7878/movie/demo/demo/200011.mkv", live: false), attempt: 1)
    core.observe(.firstFrame, serial: 1)
    core.observe(.phase(.playing), serial: 1)
    core.observe(.tracks(sampleTracks), serial: 1)
    backend.calls.removeAll()
    sink.events.removeAll()
    sink.clearSubtitlesCount = 0

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

  @Test("track preferences persist across retry and recreate+load with language fallback when IDs shift")
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

    // Simulate recreate + reload where stream indices shifted (a:2 -> a:5, s:3 -> s:7)
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

    let shiftedObserved = MediaTracksOut(
      audio: [
        TrackInfoOut(id: "a:4", language: "tur", label: "Turkish", codec: "aac", channels: 2, isDefault: true),
        TrackInfoOut(id: "a:5", language: "eng", label: "English", codec: "aac", channels: 2),
      ],
      subtitles: [
        TrackInfoOut(id: "s:7", language: "tur", label: "Turkish", codec: "subrip"),
        TrackInfoOut(id: "s:8", language: "eng", label: "English", codec: "subrip"),
      ],
      selectedAudioId: "a:4",
      selectedSubtitleId: nil
    )
    core.observe(.tracks(shiftedObserved), serial: 4)

    #expect(backend.calls == [.selectAudioTrack(5), .selectSubtitleTrack(7)])
    var reconciled = shiftedObserved
    reconciled.selectedAudioId = "a:5"
    reconciled.selectedSubtitleId = "s:7"
    #expect(sink.events == [.tracks(attempt: 6, tracks: reconciled)])
  }

  @Test("explicit subtitle Off clears auto-selected backend subtitle track on observation")
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

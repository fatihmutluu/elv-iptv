import ElvAetherCore
import Foundation
import Testing

@Suite("SyncDelayAndQualityPolicy")
struct SyncDelayAndQualityPolicyTests {
  @Test("clamps sync delays to [-30000, 30000] ms and maps NaN/Infinity to 0")
  func clampsSyncDelays() {
    #expect(SyncDelayPolicy.clampDelayMs(0) == 0)
    #expect(SyncDelayPolicy.clampDelayMs(-0.0) == 0)
    #expect(SyncDelayPolicy.clampDelayMs(250) == 250)
    #expect(SyncDelayPolicy.clampDelayMs(-1_500) == -1_500)
    #expect(SyncDelayPolicy.clampDelayMs(99_000) == 30_000)
    #expect(SyncDelayPolicy.clampDelayMs(-99_000) == -30_000)
    #expect(SyncDelayPolicy.clampDelayMs(.nan) == 0)
    #expect(SyncDelayPolicy.clampDelayMs(.infinity) == 0)
    #expect(SyncDelayPolicy.clampDelayMs(-.infinity) == 0)

    #expect(SyncDelayPolicy.delaySeconds(fromMs: 500) == 0.5)
    #expect(SyncDelayPolicy.delaySeconds(fromMs: -250) == -0.25)
    #expect(SyncDelayPolicy.delaySeconds(fromMs: 60_000) == 30.0)
    #expect(SyncDelayPolicy.delaySeconds(fromMs: .nan) == 0)
  }

  @Test("computes effective subtitle cue time with positive and negative delays")
  func effectiveSubtitleTime() {
    // Positive delay shifts subtitles later, so at t=10s we look up cues scheduled at t=8.5s
    #expect(SyncDelayPolicy.effectiveSubtitleTime(sourceTimeSeconds: 10.0, subtitleDelaySeconds: 1.5) == 8.5)
    // Negative delay shifts subtitles earlier, so at t=10s we look up cues scheduled at t=11.0s
    #expect(SyncDelayPolicy.effectiveSubtitleTime(sourceTimeSeconds: 10.0, subtitleDelaySeconds: -1.0) == 11.0)
    #expect(SyncDelayPolicy.effectiveSubtitleTime(sourceTimeSeconds: .nan, subtitleDelaySeconds: 1.0) == 0)
    #expect(SyncDelayPolicy.effectiveSubtitleTime(sourceTimeSeconds: 10.0, subtitleDelaySeconds: .infinity) == 10.0)
  }

  @Test("resolves standard adaptive HLS resolution ceiling presets and nil for Auto or unknown")
  func resolvesVideoQualityCaps() {
    #expect(VideoQualityPolicy.adaptivePresets.map(\.id) == ["2160p", "1080p", "720p", "480p"])

    let cap2160 = VideoQualityPolicy.resolveCap(for: "2160p")
    #expect(cap2160 == VideoQualityCap(id: "2160p", maxWidth: 3840, maxHeight: 2160, peakBitrateBps: 25_000_000))

    let cap1080 = VideoQualityPolicy.resolveCap(for: " 1080P ")
    #expect(cap1080 == VideoQualityCap(id: "1080p", maxWidth: 1920, maxHeight: 1080, peakBitrateBps: 10_000_000))

    let cap720 = VideoQualityPolicy.resolveCap(for: "720p")
    #expect(cap720 == VideoQualityCap(id: "720p", maxWidth: 1280, maxHeight: 720, peakBitrateBps: 5_000_000))

    let cap480 = VideoQualityPolicy.resolveCap(for: "480p")
    #expect(cap480 == VideoQualityCap(id: "480p", maxWidth: 854, maxHeight: 480, peakBitrateBps: 2_500_000))

    #expect(VideoQualityPolicy.resolveCap(for: nil) == nil)
    #expect(VideoQualityPolicy.resolveCap(for: "") == nil)
    #expect(VideoQualityPolicy.resolveCap(for: "auto") == nil)
    #expect(VideoQualityPolicy.resolveCap(for: "360p") == nil)
  }

  @Test("identifies adaptive HLS plans only")
  func identifiesAdaptivePlans() {
    let url = URL(string: "http://h:7878/live/demo/demo/1001.m3u8")!
    #expect(VideoQualityPolicy.isAdaptiveStream(plan: .hls(url, live: true)))
    #expect(VideoQualityPolicy.isAdaptiveStream(plan: .hls(url, live: false)))
    #expect(!VideoQualityPolicy.isAdaptiveStream(plan: .liveTs(url)))
    #expect(!VideoQualityPolicy.isAdaptiveStream(plan: .vod(url, startSeconds: nil)))
    #expect(!VideoQualityPolicy.isAdaptiveStream(plan: nil))
  }

  @Test("EngineCore forwards clamped audio/subtitle delays and adaptive video quality selections (#59)")
  @MainActor
  func engineCoreSyncAndQualityWiring() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.m3u8", live: true), attempt: 1)
    core.observe(
      .tracks(
        MediaTracksOut(
          audio: [TrackInfoOut(id: "a:1", language: "en", label: "English")],
          subtitles: [],
          selectedAudioId: "a:1",
          selectedSubtitleId: nil,
          videoQualities: VideoQualityPolicy.adaptivePresets,
          selectedVideoQualityId: nil
        )
      ),
      serial: 1
    )
    sink.events.removeAll()
    backend.calls.removeAll()

    core.setAudioDelay(2, delayMs: 250)
    core.setSubtitleDelay(2, delayMs: -40_000)
    core.setAudioDelay(2, delayMs: .nan)
    #expect(
      backend.calls == [
        .setAudioDelay(0.25),
        .setSubtitleDelay(-30.0),
        .setAudioDelay(0),
      ]
    )

    // Invalid quality ID is ignored cleanly
    backend.calls.removeAll()
    core.selectVideoQuality(3, id: "invalid")
    #expect(backend.calls.isEmpty)
    #expect(sink.events.isEmpty)

    // Selecting 720p applies cap and emits updated tracks snapshot
    core.selectVideoQuality(4, id: "720p")
    let expectedCap = VideoQualityPolicy.resolveCap(for: "720p")
    #expect(backend.calls == [.selectVideoQuality(expectedCap)])
    guard case let .tracks(attempt, tracks) = sink.events.last else {
      Issue.record("expected tracks event")
      return
    }
    #expect(attempt == 4)
    #expect(tracks.selectedVideoQualityId == "720p")
    #expect(tracks.videoQualities == VideoQualityPolicy.adaptivePresets)

    // Returning to Auto (nil) clears cap and emits selectedVideoQualityId = nil
    sink.events.removeAll()
    backend.calls.removeAll()
    core.selectVideoQuality(5, id: nil)
    #expect(backend.calls == [.selectVideoQuality(nil)])
    guard case let .tracks(autoAttempt, autoTracks) = sink.events.last else {
      Issue.record("expected tracks event for Auto")
      return
    }
    #expect(autoAttempt == 5)
    #expect(autoTracks.selectedVideoQualityId == nil)
    #expect(autoTracks.toDictionary()["selectedVideoQualityId"] is NSNull)
  }
}

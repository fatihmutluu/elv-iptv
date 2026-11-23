import ElvAetherCore
import Foundation
import Testing

@Suite("NowPlayingPolicy (#413)")
struct NowPlayingPolicyTests {
  @Test("sanitizeNowPlayingArtworkUrl allows http/https, strips userinfo, and rejects credential query params")
  func sanitizesArtworkUrls() {
    #expect(sanitizeNowPlayingArtworkUrl(nil) == nil)
    #expect(sanitizeNowPlayingArtworkUrl("") == nil)
    #expect(sanitizeNowPlayingArtworkUrl("   ") == nil)
    #expect(sanitizeNowPlayingArtworkUrl("file:///tmp/poster.jpg") == nil)
    #expect(sanitizeNowPlayingArtworkUrl("data:image/png;base64,AAAA") == nil)
    #expect(sanitizeNowPlayingArtworkUrl("ftp://cdn.example/poster.jpg") == nil)
    #expect(sanitizeNowPlayingArtworkUrl("https://") == nil)

    #expect(
      sanitizeNowPlayingArtworkUrl("  https://cdn.example/posters/42.jpg?size=large  ")
        == URL(string: "https://cdn.example/posters/42.jpg?size=large")
    )
    #expect(
      sanitizeNowPlayingArtworkUrl("http://user:secret@cdn.example:8080/logos/ch1.png")
        == URL(string: "http://cdn.example:8080/logos/ch1.png")
    )

    let blockedParams = [
      "username",
      "password",
      "pass",
      "user",
      "token",
      "auth",
      "key",
      "apikey",
      "api_key",
      "access_token",
    ]
    for param in blockedParams {
      let url = "https://cdn.example/logo.png?width=300&\(param)=secret123"
      #expect(sanitizeNowPlayingArtworkUrl(url) == nil)
      let upper = "https://cdn.example/logo.png?\(param.uppercased())=secret123"
      #expect(sanitizeNowPlayingArtworkUrl(upper) == nil)
    }
  }

  @Test("capabilities reflect live vs VOD, track stepping, and inactive states")
  func computesCapabilities() {
    let inactive = NowPlayingPlaybackState(isActive: false, isPlaying: false, isLive: false)
    #expect(
      NowPlayingPolicy.capabilities(
        for: inactive,
        metadata: NowPlayingMetadata(title: "Movie", isLive: false, canStepTrack: true)
      ) == .disabled
    )
    #expect(NowPlayingPolicy.snapshot(for: inactive, metadata: nil) == nil)

    let liveState = NowPlayingPlaybackState(isActive: true, isPlaying: true, isLive: true, rate: 1.5, positionSeconds: 42, durationSeconds: 100)
    let liveMeta = NowPlayingMetadata(
      title: "  News HD  ",
      subtitle: "  Evening Bulletin ",
      artworkUrl: "https://u:p@cdn.example/ch.png",
      isLive: true,
      canStepTrack: true
    )
    let liveSnapshot = NowPlayingPolicy.snapshot(for: liveState, metadata: liveMeta)
    #expect(liveSnapshot?.title == "News HD")
    #expect(liveSnapshot?.subtitle == "Evening Bulletin")
    #expect(liveSnapshot?.artworkUrl == URL(string: "https://cdn.example/ch.png"))
    #expect(liveSnapshot?.isLive == true)
    #expect(liveSnapshot?.playbackRate == 1.0)
    #expect(liveSnapshot?.elapsedPlaybackTime == nil)
    #expect(liveSnapshot?.duration == nil)
    #expect(
      liveSnapshot?.capabilities == NowPlayingCommandCapabilities(
        play: true,
        pause: true,
        togglePlayPause: true,
        stop: true,
        skipForward: false,
        skipBackward: false,
        changePlaybackPosition: false,
        changePlaybackRate: false,
        nextTrack: true,
        previousTrack: true
      )
    )

    let vodState = NowPlayingPlaybackState(isActive: true, isPlaying: true, isLive: false, rate: 1.25, positionSeconds: 120, durationSeconds: 3600)
    let vodMeta = NowPlayingMetadata(title: "Film", subtitle: "   ", artworkUrl: "https://cdn.example/poster.jpg?token=abc", isLive: false, canStepTrack: false)
    let vodSnapshot = NowPlayingPolicy.snapshot(for: vodState, metadata: vodMeta)
    #expect(vodSnapshot?.subtitle == nil)
    #expect(vodSnapshot?.artworkUrl == nil)
    #expect(vodSnapshot?.playbackRate == 1.25)
    #expect(vodSnapshot?.defaultPlaybackRate == 1.25)
    #expect(vodSnapshot?.elapsedPlaybackTime == 120)
    #expect(vodSnapshot?.duration == 3600)
    #expect(
      vodSnapshot?.capabilities == NowPlayingCommandCapabilities(
        play: true,
        pause: true,
        togglePlayPause: true,
        stop: true,
        skipForward: true,
        skipBackward: true,
        changePlaybackPosition: true,
        changePlaybackRate: true,
        nextTrack: false,
        previousTrack: false
      )
    )
  }

  @Test("throttles steady clock refreshes to 5s while immediately publishing transitions, metadata changes, and seek jumps >= 1.5s")
  func throttlesRoutineTicksAndPassesEdges() {
    var policy = NowPlayingPolicy(minRefreshIntervalSeconds: 5.0, seekJumpThresholdSeconds: 1.5)
    let meta = NowPlayingMetadata(title: "Episode 1", subtitle: "Show", isLive: false, canStepTrack: true)
    policy.setMetadata(meta)

    let playing = NowPlayingPlaybackState(isActive: true, isPlaying: true, isLive: false, rate: 1.0, positionSeconds: 10.0, durationSeconds: 1800.0)
    guard case let .publish(first) = policy.evaluate(state: playing, nowSeconds: 100.0) else {
      Issue.record("Expected initial publish")
      return
    }
    #expect(first.elapsedPlaybackTime == 10.0)

    // Routine progression within 5.0 s is throttled.
    let tick2 = NowPlayingPlaybackState(isActive: true, isPlaying: true, isLive: false, rate: 1.0, positionSeconds: 12.0, durationSeconds: 1800.0)
    #expect(policy.evaluate(state: tick2, nowSeconds: 102.0) == .unchanged)
    let tick49 = NowPlayingPlaybackState(isActive: true, isPlaying: true, isLive: false, rate: 1.0, positionSeconds: 14.9, durationSeconds: 1800.0)
    #expect(policy.evaluate(state: tick49, nowSeconds: 104.9) == .unchanged)

    // At >= 5.0 s routine refresh publishes.
    let tick5 = NowPlayingPlaybackState(isActive: true, isPlaying: true, isLive: false, rate: 1.0, positionSeconds: 15.0, durationSeconds: 1800.0)
    guard case let .publish(refreshed) = policy.evaluate(state: tick5, nowSeconds: 105.0) else {
      Issue.record("Expected periodic publish at 5.0s")
      return
    }
    #expect(refreshed.elapsedPlaybackTime == 15.0)

    // Seek jump >= 1.5 s publishes immediately.
    let jumped = NowPlayingPlaybackState(isActive: true, isPlaying: true, isLive: false, rate: 1.0, positionSeconds: 26.0, durationSeconds: 1800.0)
    guard case let .publish(afterSeek) = policy.evaluate(state: jumped, nowSeconds: 106.0) else {
      Issue.record("Expected immediate publish on seek jump")
      return
    }
    #expect(afterSeek.elapsedPlaybackTime == 26.0)

    // Playback rate change publishes immediately.
    let faster = NowPlayingPlaybackState(isActive: true, isPlaying: true, isLive: false, rate: 1.5, positionSeconds: 27.0, durationSeconds: 1800.0)
    guard case let .publish(afterRate) = policy.evaluate(state: faster, nowSeconds: 107.0) else {
      Issue.record("Expected immediate publish on rate change")
      return
    }
    #expect(afterRate.playbackRate == 1.5)

    // Pause transition publishes immediately with playbackRate == 0.
    let paused = NowPlayingPlaybackState(isActive: true, isPlaying: false, isLive: false, rate: 1.5, positionSeconds: 28.5, durationSeconds: 1800.0)
    guard case let .publish(afterPause) = policy.evaluate(state: paused, nowSeconds: 108.0) else {
      Issue.record("Expected immediate publish on pause")
      return
    }
    #expect(afterPause.playbackRate == 0.0)
    #expect(afterPause.defaultPlaybackRate == 1.5)

    // Metadata update publishes immediately even within throttle window.
    policy.setMetadata(NowPlayingMetadata(title: "Episode 2", subtitle: "Show", isLive: false, canStepTrack: false))
    guard case let .publish(afterMeta) = policy.evaluate(state: paused, nowSeconds: 108.2) else {
      Issue.record("Expected immediate publish on metadata change")
      return
    }
    #expect(afterMeta.title == "Episode 2")
    #expect(afterMeta.capabilities.nextTrack == false)

    // Inactive transition clears once, preserves metadata, and subsequent inactive ticks stay unchanged.
    let inactive = NowPlayingPlaybackState(isActive: false, isPlaying: false, isLive: false)
    #expect(policy.evaluate(state: inactive, nowSeconds: 109.0) == .clear)
    #expect(policy.evaluate(state: inactive, nowSeconds: 110.0) == .unchanged)
    #expect(policy.metadata?.title == "Episode 2")

    // Resuming after clear publishes immediately with preserved metadata.
    guard case let .publish(resumed) = policy.evaluate(state: playing, nowSeconds: 111.0) else {
      Issue.record("Expected immediate publish on resume after clear")
      return
    }
    #expect(resumed.title == "Episode 2")
  }
}

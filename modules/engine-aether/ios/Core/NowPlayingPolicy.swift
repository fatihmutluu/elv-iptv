import Foundation

/// Typed playback metadata pushed from JavaScript to Apple `MPNowPlayingInfoCenter` (`#413`).
public struct NowPlayingMetadata: Equatable, Sendable {
  public let title: String
  public let subtitle: String?
  public let artworkUrl: String?
  public let isLive: Bool
  public let canStepTrack: Bool

  public init(
    title: String,
    subtitle: String? = nil,
    artworkUrl: String? = nil,
    isLive: Bool = true,
    canStepTrack: Bool = false
  ) {
    self.title = title
    self.subtitle = subtitle
    self.artworkUrl = artworkUrl
    self.isLive = isLive
    self.canStepTrack = canStepTrack
  }
}

/// Live playback state snapshot read from `EngineCore` for Now Playing evaluation (`#413`).
public struct NowPlayingPlaybackState: Equatable, Sendable {
  public let isActive: Bool
  public let isPlaying: Bool
  public let isLive: Bool
  public let rate: Double
  public let positionSeconds: Double
  public let durationSeconds: Double?

  public init(
    isActive: Bool,
    isPlaying: Bool,
    isLive: Bool,
    rate: Double = 1.0,
    positionSeconds: Double = 0,
    durationSeconds: Double? = nil
  ) {
    self.isActive = isActive
    self.isPlaying = isPlaying
    self.isLive = isLive
    self.rate = rate
    self.positionSeconds = positionSeconds
    self.durationSeconds = durationSeconds
  }
}

/// Enabled/disabled flags for every `MPRemoteCommandCenter` target managed by `AetherNowPlayingBridge`.
public struct NowPlayingCommandCapabilities: Equatable, Sendable {
  public let play: Bool
  public let pause: Bool
  public let togglePlayPause: Bool
  public let stop: Bool
  public let skipForward: Bool
  public let skipBackward: Bool
  public let changePlaybackPosition: Bool
  public let changePlaybackRate: Bool
  public let nextTrack: Bool
  public let previousTrack: Bool

  public static let disabled = NowPlayingCommandCapabilities(
    play: false,
    pause: false,
    togglePlayPause: false,
    stop: false,
    skipForward: false,
    skipBackward: false,
    changePlaybackPosition: false,
    changePlaybackRate: false,
    nextTrack: false,
    previousTrack: false
  )

  public init(
    play: Bool,
    pause: Bool,
    togglePlayPause: Bool,
    stop: Bool,
    skipForward: Bool,
    skipBackward: Bool,
    changePlaybackPosition: Bool,
    changePlaybackRate: Bool,
    nextTrack: Bool,
    previousTrack: Bool
  ) {
    self.play = play
    self.pause = pause
    self.togglePlayPause = togglePlayPause
    self.stop = stop
    self.skipForward = skipForward
    self.skipBackward = skipBackward
    self.changePlaybackPosition = changePlaybackPosition
    self.changePlaybackRate = changePlaybackRate
    self.nextTrack = nextTrack
    self.previousTrack = previousTrack
  }
}

/// Sanitized, ready-to-publish snapshot for `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter`.
public struct NowPlayingSnapshot: Equatable, Sendable {
  public let title: String
  public let subtitle: String?
  public let artworkUrl: URL?
  public let isLive: Bool
  public let isPlaying: Bool
  public let playbackRate: Double
  public let defaultPlaybackRate: Double
  public let elapsedPlaybackTime: Double?
  public let duration: Double?
  public let capabilities: NowPlayingCommandCapabilities

  public init(
    title: String,
    subtitle: String?,
    artworkUrl: URL?,
    isLive: Bool,
    isPlaying: Bool,
    playbackRate: Double,
    defaultPlaybackRate: Double,
    elapsedPlaybackTime: Double?,
    duration: Double?,
    capabilities: NowPlayingCommandCapabilities
  ) {
    self.title = title
    self.subtitle = subtitle
    self.artworkUrl = artworkUrl
    self.isLive = isLive
    self.isPlaying = isPlaying
    self.playbackRate = playbackRate
    self.defaultPlaybackRate = defaultPlaybackRate
    self.elapsedPlaybackTime = elapsedPlaybackTime
    self.duration = duration
    self.capabilities = capabilities
  }
}

/// Outcome of evaluating a playback state tick against `NowPlayingPolicy`.
public enum NowPlayingUpdate: Equatable, Sendable {
  case unchanged
  case clear
  case publish(NowPlayingSnapshot)
}

private let blockedArtworkCredentialQueryKeys: Set<String> = [
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

/// Validates and sanitizes an artwork URL before fetching it for `MPNowPlayingInfoCenter`:
/// allows only `http`/`https`, strips embedded `user`/`password` info, and rejects URLs carrying
/// credential query parameters so provider secrets never leak into system artwork fetches.
public func sanitizeNowPlayingArtworkUrl(_ raw: String?) -> URL? {
  guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
    return nil
  }
  guard var components = URLComponents(string: trimmed) else {
    return nil
  }
  guard let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
    return nil
  }
  guard let host = components.host, !host.isEmpty else {
    return nil
  }

  components.user = nil
  components.password = nil

  if let queryItems = components.queryItems {
    for item in queryItems where blockedArtworkCredentialQueryKeys.contains(item.name.lowercased()) {
      return nil
    }
  } else if let rawQuery = components.percentEncodedQuery, !rawQuery.isEmpty {
    for pair in rawQuery.split(separator: "&") {
      let rawKey = pair.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
      let decodedKey = String(rawKey).removingPercentEncoding ?? String(rawKey)
      if blockedArtworkCredentialQueryKeys.contains(decodedKey.lowercased()) {
        return nil
      }
    }
  }

  return components.url
}

/// Pure Foundation policy computing `MPRemoteCommandCenter` capabilities, sanitized `NowPlayingSnapshot`s,
/// and throttled clock-refresh decisions (`#413`).
public struct NowPlayingPolicy: Sendable {
  public let minRefreshIntervalSeconds: Double
  public let seekJumpThresholdSeconds: Double

  public private(set) var metadata: NowPlayingMetadata?

  private var lastPublishedAtSeconds: Double?
  private var lastPublishedState: NowPlayingPlaybackState?
  private var lastPublishedMetadata: NowPlayingMetadata?
  private var hasActivePublication = false

  public init(
    minRefreshIntervalSeconds: Double = 5.0,
    seekJumpThresholdSeconds: Double = 1.5
  ) {
    self.minRefreshIntervalSeconds = minRefreshIntervalSeconds
    self.seekJumpThresholdSeconds = seekJumpThresholdSeconds
  }

  /// Stores or clears metadata. Clearing requires an explicit `nil`; transient playback stops preserve metadata.
  public mutating func setMetadata(_ metadata: NowPlayingMetadata?) {
    self.metadata = metadata
  }

  /// Resets playback publication history without discarding configured metadata.
  public mutating func resetPlayback() {
    lastPublishedAtSeconds = nil
    lastPublishedState = nil
    lastPublishedMetadata = nil
    hasActivePublication = false
  }

  /// Computes remote command capabilities for the given playback state and metadata.
  public static func capabilities(
    for state: NowPlayingPlaybackState,
    metadata: NowPlayingMetadata?
  ) -> NowPlayingCommandCapabilities {
    guard state.isActive else {
      return .disabled
    }
    let canSeek = !state.isLive
    let canStep = metadata?.canStepTrack ?? false
    return NowPlayingCommandCapabilities(
      play: true,
      pause: true,
      togglePlayPause: true,
      stop: true,
      skipForward: canSeek,
      skipBackward: canSeek,
      changePlaybackPosition: canSeek,
      changePlaybackRate: canSeek,
      nextTrack: canStep,
      previousTrack: canStep
    )
  }

  /// Builds a `NowPlayingSnapshot` for an active playback state, or `nil` when inactive.
  public static func snapshot(
    for state: NowPlayingPlaybackState,
    metadata: NowPlayingMetadata?
  ) -> NowPlayingSnapshot? {
    guard state.isActive else {
      return nil
    }
    let title = metadata?.title.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let trimmedSubtitle = metadata?.subtitle?.trimmingCharacters(in: .whitespacesAndNewlines)
    let subtitle = (trimmedSubtitle?.isEmpty == false) ? trimmedSubtitle : nil
    let artworkUrl = sanitizeNowPlayingArtworkUrl(metadata?.artworkUrl)

    let normalizedRate = Self.normalizeRate(state.rate, isLive: state.isLive)
    let playbackRate = state.isPlaying ? normalizedRate : 0.0
    let elapsed: Double? = state.isLive ? nil : Self.normalizePosition(state.positionSeconds)
    let duration: Double? = state.isLive ? nil : Self.normalizeDuration(state.durationSeconds)

    return NowPlayingSnapshot(
      title: title,
      subtitle: subtitle,
      artworkUrl: artworkUrl,
      isLive: state.isLive,
      isPlaying: state.isPlaying,
      playbackRate: playbackRate,
      defaultPlaybackRate: normalizedRate,
      elapsedPlaybackTime: elapsed,
      duration: duration,
      capabilities: capabilities(for: state, metadata: metadata)
    )
  }

  /// Evaluates whether Now Playing info should be cleared, published immediately, or throttled.
  public mutating func evaluate(
    state: NowPlayingPlaybackState,
    nowSeconds: Double,
    force: Bool = false
  ) -> NowPlayingUpdate {
    guard state.isActive else {
      let shouldClear = hasActivePublication || force
      resetPlayback()
      return shouldClear ? .clear : .unchanged
    }
    guard nowSeconds.isFinite else {
      return .unchanged
    }
    guard let snapshot = Self.snapshot(for: state, metadata: metadata) else {
      resetPlayback()
      return .clear
    }

    if shouldPublish(state: state, nowSeconds: nowSeconds, force: force) {
      lastPublishedAtSeconds = nowSeconds
      lastPublishedState = state
      lastPublishedMetadata = metadata
      hasActivePublication = true
      return .publish(snapshot)
    }

    return .unchanged
  }

  private func shouldPublish(
    state: NowPlayingPlaybackState,
    nowSeconds: Double,
    force: Bool
  ) -> Bool {
    if force || !hasActivePublication {
      return true
    }
    guard let lastAt = lastPublishedAtSeconds, let prev = lastPublishedState else {
      return true
    }
    if lastPublishedMetadata != metadata {
      return true
    }
    if prev.isPlaying != state.isPlaying || prev.isLive != state.isLive {
      return true
    }

    let prevRate = Self.normalizeRate(prev.rate, isLive: prev.isLive)
    let curRate = Self.normalizeRate(state.rate, isLive: state.isLive)
    if prevRate != curRate {
      return true
    }

    let prevDuration = prev.isLive ? nil : Self.normalizeDuration(prev.durationSeconds)
    let curDuration = state.isLive ? nil : Self.normalizeDuration(state.durationSeconds)
    if prevDuration != curDuration {
      return true
    }

    if nowSeconds < lastAt {
      return true
    }

    let dt = nowSeconds - lastAt
    if !state.isLive {
      let prevPos = Self.normalizePosition(prev.positionSeconds)
      let curPos = Self.normalizePosition(state.positionSeconds)
      let expectedPos = prev.isPlaying ? (prevPos + dt * prevRate) : prevPos
      if abs(curPos - expectedPos) >= seekJumpThresholdSeconds {
        return true
      }
    }

    return dt >= minRefreshIntervalSeconds
  }

  private static func normalizeRate(_ rate: Double, isLive: Bool) -> Double {
    if isLive {
      return 1.0
    }
    return (rate.isFinite && rate > 0) ? rate : 1.0
  }

  private static func normalizePosition(_ positionSeconds: Double) -> Double {
    guard positionSeconds.isFinite else { return 0.0 }
    return max(0.0, positionSeconds)
  }

  private static func normalizeDuration(_ durationSeconds: Double?) -> Double? {
    guard let value = durationSeconds, value.isFinite, value > 0 else { return nil }
    return value
  }
}

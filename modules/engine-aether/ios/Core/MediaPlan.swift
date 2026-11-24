import Foundation

/// Chooses the playback plan (`hls`, `vod`, or `liveTs`) for `request`, or `nil` if `url` is invalid.
public func planMedia(_ request: LoadRequest) -> MediaPlan? {
  let trimmed = request.url.trimmingCharacters(in: .whitespacesAndNewlines)
  guard
    !trimmed.isEmpty,
    let components = URLComponents(string: trimmed),
    let scheme = components.scheme?.lowercased(),
    !scheme.isEmpty,
    let url = components.url
  else {
    return nil
  }

  guard scheme == "http" || scheme == "https", let host = components.host, !host.isEmpty else {
    return nil
  }

  let lowerPath = components.path.lowercased()
  if lowerPath.hasSuffix(".m3u8") || lowerPath.hasSuffix(".m3u") {
    return .hls(url, live: request.live)
  }

  if !request.live {
    let startSeconds = request.startMs.flatMap { $0.isFinite ? max(0, $0) / 1_000.0 : nil }
    return .vod(url, startSeconds: startSeconds)
  }

  return .liveTs(url)
}

/// Builds engine load options for `plan` and `request`.
public func loadOptions(for plan: MediaPlan, request: LoadRequest) -> EngineLoadOptions {
  let isLive: Bool
  let maxConcurrent: Int?
  let liveStartupGraceSeconds: Double?
  let liveStartupSingleSegmentMinimumSeconds: Double?
  let hostRetriesLiveReplay: Bool
  switch plan {
  case let .hls(_, live):
    isLive = live
    maxConcurrent = 1
    liveStartupGraceSeconds = nil
    liveStartupSingleSegmentMinimumSeconds = nil
    hostRetriesLiveReplay = live
  case .vod:
    isLive = false
    maxConcurrent = 1
    liveStartupGraceSeconds = nil
    liveStartupSingleSegmentMinimumSeconds = nil
    hostRetriesLiveReplay = false
  case .liveTs:
    isLive = true
    maxConcurrent = nil
    liveStartupGraceSeconds = 0
    liveStartupSingleSegmentMinimumSeconds = 1.0
    hostRetriesLiveReplay = false
  }

  let cushion = request.liveEdgeCushionSeconds.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }

  return EngineLoadOptions(
    isLive: isLive,
    httpHeaders: sanitizeRequestHeaders(request.headers),
    maxConcurrentSourceRequests: maxConcurrent,
    preferSoftwareDecode: request.preferHevcOverDolbyVision,
    displayCriteriaOwner: .engine,
    liveStartupGraceSeconds: liveStartupGraceSeconds,
    liveStartupSingleSegmentMinimumSeconds: liveStartupSingleSegmentMinimumSeconds,
    liveEdgeCushionSeconds: cushion,
    probesize: nil,
    maxAnalyzeDurationMicros: nil,
    generatesBackgroundScrubPreviews: false,
    skipsContainerAttachments: true,
    hostRetriesExhaustedLiveReplay: hostRetriesLiveReplay,
    filterSdhSubtitles: request.filterSdhSubtitles,
    allowLegacyTls: request.allowLegacyTls,
    secondarySubtitleTrackId: request.secondarySubtitleTrackId,
    externalSubtitles: request.externalSubtitles
  )
}

/// Resets `.liveTs`-specific startup overrides when a live progressive URL hands off to an `#EXTM3U` HLS playlist.
public func hlsHandoffOptions(from options: EngineLoadOptions) -> EngineLoadOptions {
  var hls = options
  hls.isLive = true
  hls.maxConcurrentSourceRequests = 1
  hls.hostRetriesExhaustedLiveReplay = true
  hls.liveStartupGraceSeconds = nil
  hls.liveStartupSingleSegmentMinimumSeconds = nil
  hls.probesize = nil
  hls.maxAnalyzeDurationMicros = nil
  return hls
}

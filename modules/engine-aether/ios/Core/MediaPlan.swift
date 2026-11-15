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
    let startSeconds = request.startMs.map { max(0, $0) / 1_000.0 }
    return .vod(url, startSeconds: startSeconds)
  }

  return .liveTs(url)
}

/// Builds engine load options for `plan` and `request`.
public func loadOptions(for plan: MediaPlan, request: LoadRequest) -> EngineLoadOptions {
  let isLive: Bool
  let maxConcurrent: Int?
  switch plan {
  case let .hls(_, live):
    isLive = live
    maxConcurrent = nil
  case .vod:
    isLive = false
    maxConcurrent = 1
  case .liveTs:
    isLive = true
    maxConcurrent = nil
  }

  return EngineLoadOptions(
    isLive: isLive,
    httpHeaders: request.headers,
    maxConcurrentSourceRequests: maxConcurrent,
    preferSoftwareDecode: request.softwareAudio,
    liveStartupGraceSeconds: nil,
    liveStartupSingleSegmentMinimumSeconds: nil,
    probesize: nil,
    maxAnalyzeDurationMicros: nil
  )
}

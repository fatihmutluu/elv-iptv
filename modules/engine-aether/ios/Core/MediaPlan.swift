import Foundation

private let allowedManagedDownloadExtensions: Set<String> = [
  "mp4",
  "mkv",
  "ts",
  "m4v",
  "webm",
  "mov",
]

/// Returns `true` only when `url` is a local `file://` URL with an allowlisted video extension whose
/// symlink-resolved canonical path is strictly contained inside `allowedDownloadsRoot`.
public func isAllowedManagedDownloadFileURL(_ url: URL, allowedDownloadsRoot: URL) -> Bool {
  guard url.isFileURL, allowedDownloadsRoot.isFileURL else { return false }
  guard url.query == nil, url.fragment == nil else { return false }
  if let host = url.host, !host.isEmpty, host.lowercased() != "localhost" {
    return false
  }
  if url.pathComponents.contains("..") {
    return false
  }
  let rawExt = url.pathExtension.lowercased()
  guard allowedManagedDownloadExtensions.contains(rawExt) else { return false }

  let rootPath = allowedDownloadsRoot.standardizedFileURL.resolvingSymlinksInPath().path
  guard !rootPath.isEmpty else { return false }
  let rootPrefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
  let resolvedUrl = url.standardizedFileURL.resolvingSymlinksInPath()
  let resolvedPath = resolvedUrl.path
  guard resolvedPath.hasPrefix(rootPrefix) else { return false }
  let resolvedExt = resolvedUrl.pathExtension.lowercased()
  guard allowedManagedDownloadExtensions.contains(resolvedExt) else { return false }
  let fileName = resolvedUrl.lastPathComponent
  guard !fileName.isEmpty, !fileName.hasPrefix("."), fileName.count > resolvedExt.count + 1 else {
    return false
  }
  var isDir: ObjCBool = false
  guard FileManager.default.fileExists(atPath: resolvedPath, isDirectory: &isDir), !isDir.boolValue else {
    return false
  }
  return true
}

/// Chooses the playback plan (`hls`, `vod`, or `liveTs`) for `request`, or `nil` if `url` is invalid.
/// Arbitrary `file://` URLs are always rejected; managed offline downloads are permitted only when
/// `allowedDownloadsRoot` is supplied and the canonical file path is strictly contained within it.
public func planMedia(_ request: LoadRequest, allowedDownloadsRoot: URL? = nil) -> MediaPlan? {
  let trimmed = request.url.trimmingCharacters(in: .whitespacesAndNewlines)
  guard
    !trimmed.isEmpty,
    !trimmed.unicodeScalars.contains(where: { $0.value <= 0x1F || $0.value == 0x7F }),
    let components = URLComponents(string: trimmed),
    let scheme = components.scheme?.lowercased(),
    !scheme.isEmpty,
    let url = components.url
  else {
    return nil
  }

  if url.isFileURL || scheme == "file" {
    guard
      let downloadsRoot = allowedDownloadsRoot,
      !trimmed.contains("?"),
      !trimmed.contains("#"),
      components.query == nil,
      components.fragment == nil,
      !components.path.split(separator: "/").contains(".."),
      isAllowedManagedDownloadFileURL(url, allowedDownloadsRoot: downloadsRoot)
    else {
      return nil
    }
    let resolvedUrl = url.standardizedFileURL.resolvingSymlinksInPath()
    let startSeconds = request.startMs.flatMap { $0.isFinite ? max(0, $0) / 1_000.0 : nil }
    return .vod(resolvedUrl, startSeconds: startSeconds)
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
  let displaySync = AppleDisplaySyncSettings.resolve(
    autoFrameRate: request.autoFrameRate,
    autoDynamicRange: request.autoDynamicRange
  )

  return EngineLoadOptions(
    isLive: isLive,
    httpHeaders: sanitizeRequestHeaders(request.headers),
    maxConcurrentSourceRequests: maxConcurrent,
    preferSoftwareDecode: request.preferHevcOverDolbyVision,
    displayCriteriaOwner: resolveDisplayCriteriaOwner(for: displaySync),
    displaySync: displaySync,
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
    dnsFamily: request.dnsFamily,
    hostOverride: validateHostOverride(request.hostOverride),
    secondarySubtitleTrackId: request.secondarySubtitleTrackId,
    externalSubtitles: request.externalSubtitles,
    bufferPreset: request.bufferPreset
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

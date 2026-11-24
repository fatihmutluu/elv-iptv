import AetherEngine
import Foundation

/// Parsed per-load network transport preferences forwarded from JavaScript (`#172`).
///
/// On iOS/tvOS, `AVURLAsset` / `URLSession` media transport (including `LiveTsReader`, which streams over
/// `URLSessionTransport` and `EngineHttpSession`) delegates DNS resolution and socket setup to the Apple OS
/// network stack so TLS SNI, certificate verification, and App Transport Security (ATS) remain untouched.
/// Carrying validated `dnsFamily` and `hostOverride` on `EngineLoadOptions` and `AetherNetworkTransportOptions`
/// keeps the bridge contract consistent across platforms and allows any future direct-socket / `NWConnection`
/// transport path to apply `dnsFamily` (e.g. `NWProtocolIP.Options.version`) without changing the JS/Swift wire format.
struct AetherNetworkTransportOptions: Equatable, Sendable {
  let dnsFamily: DnsFamilyPreference
  let hostOverride: String?

  init(dnsFamily rawDnsFamily: String? = nil, hostOverride rawHostOverride: String? = nil) {
    self.dnsFamily = DnsFamilyPreference.parse(rawDnsFamily)
    self.hostOverride = validateHostOverride(rawHostOverride)
  }

  init(from options: EngineLoadOptions) {
    self.dnsFamily = options.dnsFamily
    self.hostOverride = validateHostOverride(options.hostOverride)
  }
}

/// Translates engine-neutral `EngineLoadOptions` from `Core` onto `AetherEngine.LoadOptions`.
///
/// Note: `options.dnsFamily` and `options.hostOverride` are parsed and validated on `EngineLoadOptions` /
/// `AetherNetworkTransportOptions`, while `AVURLAsset` / `URLSession` media loads remain governed by
/// the iOS/tvOS OS network stack so TLS SNI and App Transport Security are never bypassed (`#172`).
func aetherOptions(_ options: EngineLoadOptions) -> LoadOptions {
  _ = AetherNetworkTransportOptions(from: options)
  var out = LoadOptions()
  out.isLive = options.isLive
  out.httpHeaders = options.httpHeaders
  out.maxConcurrentSourceRequests = options.maxConcurrentSourceRequests
  out.generatesBackgroundScrubPreviews = options.generatesBackgroundScrubPreviews
  out.skipsContainerAttachments = options.skipsContainerAttachments
  out.hostRetriesExhaustedLiveReplay = options.hostRetriesExhaustedLiveReplay
  out.displayCriteriaOwner = mapDisplayCriteriaOwner(options.displayCriteriaOwner)
  out.preferredAudioLanguages = options.preferredAudioLanguages
  out.initialSubtitleTrackID = options.subtitlesDisabled ? nil : options.initialSubtitleTrackId
  out.preferredSubtitleLanguages = options.subtitlesDisabled ? [] : options.preferredSubtitleLanguages
  if options.preferSoftwareDecode {
    out.preferredDecodePath = .software
  }
  if let grace = options.liveStartupGraceSeconds {
    out.liveStartupGraceSeconds = grace
  }
  if let minSegment = options.liveStartupSingleSegmentMinimumSeconds {
    out.liveStartupSingleSegmentMinimumSeconds = minSegment
  }
  if let cushion = options.liveEdgeCushionSeconds {
    out.liveEdgeCushionSeconds = cushion
  }
  if let probesize = options.probesize {
    out.probesize = Int64(probesize)
  }
  if let maxAnalyze = options.maxAnalyzeDurationMicros {
    out.maxAnalyzeDuration = Int64(maxAnalyze)
  }
  return out
}

private func mapDisplayCriteriaOwner(_ owner: DisplayCriteriaOwnerOption) -> DisplayCriteriaOwner {
  switch owner {
  case .engine: return .engine
  case .avKit: return .avKit
  case .host: return .host
  }
}

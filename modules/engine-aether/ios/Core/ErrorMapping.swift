import Foundation

private let namedHttpStatuses: Set<Int> = [401, 403, 404, 429, 509]

private let networkOnlyKinds: Set<String> = [
  "sourceCertificateRejected",
  "liveSourceUnavailable",
  "liveReloadNeverReady",
  "hlsIngestFailed",
]

private let openOrProbeKinds: Set<String> = [
  "sourceOpenFailed",
  "vodSourceFailed",
  "customSourceProbeFailed",
]

private let unsupportedFormatKinds: Set<String> = [
  "hlsFormatUnsupported",
  "masterPlaylistRejected",
  "hlsPlaylistOnRawLivePath",
  "demuxedAudioLiveUnsupported",
  "noPlayableTrackWithinBudget",
  "dolbyVisionRequiresHardware",
  "sourceFabricatesRanges",
]

private let decoderKinds: Set<String> = [
  "softwarePipelineFailed",
  "audioBridgeProducedNoOutput",
  "audioSessionFailed",
  "audioTrackSwitchFailed",
]

/// Maps a backend or reader failure to the player core spec §5.3 error taxonomy.
public func mapFailure(
  _ failure: BackendFailure,
  url: String,
  live: Bool,
  played: Bool
) -> MappedError {
  let redacted = redactUrl(url)
  switch failure {
  case let .reader(readerFailure):
    switch readerFailure {
    case let .status(status):
      let (code, httpStatus) = mapHttpStatus(status)
      return MappedError(code: code, httpStatus: httpStatus, detail: formatDetail("status:\(status)", redacted: redacted))
    case .notice:
      return MappedError(code: "connection-limit", httpStatus: nil, detail: formatDetail("notice", redacted: redacted))
    case let .transport(domain, code):
      return MappedError(
        code: "network",
        httpStatus: nil,
        detail: formatDetail("transport \(domain):\(code)", redacted: redacted)
      )
    }

  case .liveSourceReset:
    return MappedError(code: "network", httpStatus: nil, detail: formatDetail("liveSourceReset", redacted: redacted))

  case .rebuildFailed:
    return MappedError(
      code: "engine-wedged",
      httpStatus: nil,
      detail: formatDetail("rebuildFailed", redacted: redacted)
    )

  case let .engine(kind, underlyingDomain, underlyingCode):
    let cause = formatEngineCause(kind: kind, domain: underlyingDomain, code: underlyingCode)
    let detail = formatDetail(cause, redacted: redacted)

    if kind == "sourceRefused" || kind == "sourceRateLimited" {
      if let status = underlyingCode, status > 0 {
        let (code, httpStatus) = mapHttpStatus(status)
        return MappedError(code: code, httpStatus: httpStatus, detail: detail)
      }
      if kind == "sourceRateLimited" {
        return MappedError(code: "http-429", httpStatus: 429, detail: detail)
      }
      return MappedError(code: "http-other", httpStatus: nil, detail: detail)
    }

    if networkOnlyKinds.contains(kind) {
      return MappedError(code: "network", httpStatus: nil, detail: detail)
    }

    if openOrProbeKinds.contains(kind) {
      let isNetwork = underlyingDomain == NSURLErrorDomain || live || played
      return MappedError(
        code: isNetwork ? "network" : "unsupported-format",
        httpStatus: nil,
        detail: detail
      )
    }

    if unsupportedFormatKinds.contains(kind) {
      return MappedError(code: "unsupported-format", httpStatus: nil, detail: detail)
    }

    if kind == "nativeItemFailed" {
      return MappedError(
        code: underlyingDomain == NSURLErrorDomain ? "network" : "decoder",
        httpStatus: nil,
        detail: detail
      )
    }

    if decoderKinds.contains(kind) {
      return MappedError(code: "decoder", httpStatus: nil, detail: detail)
    }

    if kind == "reloadFailed" {
      return MappedError(code: "engine-wedged", httpStatus: nil, detail: detail)
    }

    return MappedError(code: "unknown", httpStatus: nil, detail: detail)
  }
}

private func mapHttpStatus(_ status: Int) -> (code: String, httpStatus: Int) {
  if namedHttpStatuses.contains(status) {
    return ("http-\(status)", status)
  }
  return ("http-other", status)
}

private func formatEngineCause(kind: String, domain: String?, code: Int?) -> String {
  if let domain, !domain.isEmpty, let code {
    return "\(kind) \(domain):\(code)"
  }
  if let code {
    return "\(kind) \(code)"
  }
  if let domain, !domain.isEmpty {
    return "\(kind) \(domain)"
  }
  return kind
}

private func formatDetail(_ cause: String, redacted: String) -> String {
  guard !redacted.isEmpty else { return cause }
  return "\(cause) \(redacted)"
}

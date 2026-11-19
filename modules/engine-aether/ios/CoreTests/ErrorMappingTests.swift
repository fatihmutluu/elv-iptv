import ElvAetherCore
import Foundation
import Testing

@Suite("ErrorMapping")
struct ErrorMappingTests {
  private let sampleUrl = "http://h:8080/live/user/pass/1.ts?token=secret"

  @Test("reader HTTP statuses map named, auth/not-found (#286), and panel limit (#314) codes")
  func readerStatuses() {
    for status in [401, 403, 404, 429, 509] {
      let mapped = mapFailure(.reader(.status(status)), url: sampleUrl, live: true, played: false)
      #expect(mapped.code == "http-\(status)")
      #expect(mapped.httpStatus == status)
    }

    let proxyAuth = mapFailure(.reader(.status(407)), url: sampleUrl, live: true, played: false)
    #expect(proxyAuth.code == "http-401")
    #expect(proxyAuth.httpStatus == 407)

    for gone in [410, 451] {
      let mapped = mapFailure(.reader(.status(gone)), url: sampleUrl, live: true, played: false)
      #expect(mapped.code == "http-404")
      #expect(mapped.httpStatus == gone)
    }

    for limit in [458, 460, 461, 462, 463, 469] {
      let mapped = mapFailure(.reader(.status(limit)), url: sampleUrl, live: true, played: false)
      #expect(mapped.code == "connection-limit")
      #expect(mapped.httpStatus == limit)
    }

    for other in [500, 503] {
      let mapped = mapFailure(.reader(.status(other)), url: sampleUrl, live: true, played: false)
      #expect(mapped.code == "http-other")
      #expect(mapped.httpStatus == other)
    }
  }

  @Test("reader notice maps to connection-limit and transport maps to network")
  func readerNoticeAndTransport() {
    let notice = mapFailure(.reader(.notice), url: sampleUrl, live: true, played: false)
    #expect(notice.code == "connection-limit")
    #expect(notice.httpStatus == nil)

    let transport = mapFailure(
      .reader(.transport(domain: NSURLErrorDomain, code: -1005)),
      url: sampleUrl,
      live: true,
      played: false
    )
    #expect(transport.code == "network")
    #expect(transport.httpStatus == nil)
  }

  @Test("engine sourceRefused and sourceRateLimited map HTTP status codes including #286 and #314")
  func engineHttpStatuses() {
    let notFound = mapFailure(
      .engine(kind: "sourceRefused", underlyingDomain: nil, underlyingCode: 404),
      url: sampleUrl,
      live: true,
      played: false
    )
    #expect(notFound.code == "http-404")
    #expect(notFound.httpStatus == 404)

    let legalGone = mapFailure(
      .engine(kind: "sourceRefused", underlyingDomain: nil, underlyingCode: 451),
      url: sampleUrl,
      live: false,
      played: false
    )
    #expect(legalGone.code == "http-404")
    #expect(legalGone.httpStatus == 451)

    let proxyAuth = mapFailure(
      .engine(kind: "sourceRefused", underlyingDomain: nil, underlyingCode: 407),
      url: sampleUrl,
      live: false,
      played: false
    )
    #expect(proxyAuth.code == "http-401")
    #expect(proxyAuth.httpStatus == 407)

    let panelLimit = mapFailure(
      .engine(kind: "sourceRefused", underlyingDomain: nil, underlyingCode: 458),
      url: sampleUrl,
      live: true,
      played: false
    )
    #expect(panelLimit.code == "connection-limit")
    #expect(panelLimit.httpStatus == 458)

    let bandwidth = mapFailure(
      .engine(kind: "sourceRateLimited", underlyingDomain: nil, underlyingCode: 509),
      url: sampleUrl,
      live: true,
      played: false
    )
    #expect(bandwidth.code == "http-509")
    #expect(bandwidth.httpStatus == 509)

    let unavailable = mapFailure(
      .engine(kind: "sourceRateLimited", underlyingDomain: nil, underlyingCode: 503),
      url: sampleUrl,
      live: true,
      played: false
    )
    #expect(unavailable.code == "http-other")
    #expect(unavailable.httpStatus == 503)
  }

  @Test("network-only engine kinds and liveSourceReset map to network")
  func networkOnlyKinds() {
    for kind in ["sourceCertificateRejected", "liveSourceUnavailable", "liveReloadNeverReady", "hlsIngestFailed"] {
      let mapped = mapFailure(
        .engine(kind: kind, underlyingDomain: nil, underlyingCode: nil),
        url: sampleUrl,
        live: false,
        played: false
      )
      #expect(mapped.code == "network")
    }
    let reset = mapFailure(.liveSourceReset, url: sampleUrl, live: true, played: true)
    #expect(reset.code == "network")
  }

  @Test("open/probe and nativeItemFailed treat URL, CFNetwork, and POSIX domains as network")
  func openProbeAndNativeItemNetworkDomains() {
    let networkDomains = [NSURLErrorDomain, NSPOSIXErrorDomain, "kCFErrorDomainCFNetwork", "NWErrorDomain"]
    for kind in ["sourceOpenFailed", "vodSourceFailed", "customSourceProbeFailed"] {
      for domain in networkDomains {
        let netErr = mapFailure(
          .engine(kind: kind, underlyingDomain: domain, underlyingCode: -1005),
          url: sampleUrl,
          live: false,
          played: false
        )
        #expect(netErr.code == "network")
      }

      let liveError = mapFailure(
        .engine(kind: kind, underlyingDomain: "AVFoundationErrorDomain", underlyingCode: -11800),
        url: sampleUrl,
        live: true,
        played: false
      )
      #expect(liveError.code == "network")

      let playedVod = mapFailure(
        .engine(kind: kind, underlyingDomain: "AVFoundationErrorDomain", underlyingCode: -11800),
        url: sampleUrl,
        live: false,
        played: true
      )
      #expect(playedVod.code == "network")

      let unplayedVodFormat = mapFailure(
        .engine(kind: kind, underlyingDomain: "AVFoundationErrorDomain", underlyingCode: -11828),
        url: sampleUrl,
        live: false,
        played: false
      )
      #expect(unplayedVodFormat.code == "unsupported-format")
    }

    for domain in networkDomains {
      let netItem = mapFailure(
        .engine(kind: "nativeItemFailed", underlyingDomain: domain, underlyingCode: 54),
        url: sampleUrl,
        live: false,
        played: true
      )
      #expect(netItem.code == "network")
    }

    let decItem = mapFailure(
      .engine(kind: "nativeItemFailed", underlyingDomain: "AVFoundationErrorDomain", underlyingCode: -11850),
      url: sampleUrl,
      live: false,
      played: false
    )
    #expect(decItem.code == "decoder")
  }

  @Test("format, decoder, engine-wedged,unknown kinds and allowlist URL redaction")
  func formatDecoderWedgedAndRedaction() {
    let formatKinds = [
      "hlsFormatUnsupported",
      "masterPlaylistRejected",
      "hlsPlaylistOnRawLivePath",
      "demuxedAudioLiveUnsupported",
      "noPlayableTrackWithinBudget",
      "dolbyVisionRequiresHardware",
      "dolbyVisionUnplayableOnSoftwarePath",
      "sourceFabricatesRanges",
    ]
    for kind in formatKinds {
      let mapped = mapFailure(
        .engine(kind: kind, underlyingDomain: nil, underlyingCode: nil),
        url: sampleUrl,
        live: true,
        played: false
      )
      #expect(mapped.code == "unsupported-format")
    }

    for kind in ["softwarePipelineFailed", "audioBridgeProducedNoOutput", "audioSessionFailed", "audioTrackSwitchFailed"] {
      let mapped = mapFailure(
        .engine(kind: kind, underlyingDomain: nil, underlyingCode: nil),
        url: sampleUrl,
        live: true,
        played: true
      )
      #expect(mapped.code == "decoder")
    }

    #expect(mapFailure(.rebuildFailed, url: sampleUrl, live: true, played: false).code == "engine-wedged")
    #expect(
      mapFailure(.engine(kind: "reloadFailed", underlyingDomain: nil, underlyingCode: nil), url: sampleUrl, live: true, played: true).code
        == "engine-wedged"
    )
    #expect(
      mapFailure(.engine(kind: "storageExhausted", underlyingDomain: nil, underlyingCode: nil), url: sampleUrl, live: true, played: false).code
        == "unknown"
    )

    let redactedDetail = mapFailure(
      .engine(kind: "sourceRefused", underlyingDomain: "HTTP", underlyingCode: 404),
      url: "http://h:8080/live/user/pass/1.ts?token=x",
      live: true,
      played: false
    )
    #expect(redactedDetail.detail.contains("http://h:8080/***/***/***/***.ts"))
    #expect(!redactedDetail.detail.contains("user"))
    #expect(!redactedDetail.detail.contains("pass"))
    #expect(!redactedDetail.detail.contains("token"))
  }
}

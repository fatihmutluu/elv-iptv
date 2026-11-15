import ElvAetherCore
import Foundation
import Testing

@Suite("ErrorMapping")
struct ErrorMappingTests {
  private let sampleUrl = "http://h:8080/live/user/pass/1.ts?token=secret"

  @Test("reader HTTP statuses map to exact codes and keep httpStatus")
  func readerStatuses() {
    for status in [401, 403, 404, 429, 509] {
      let mapped = mapFailure(.reader(.status(status)), url: sampleUrl, live: true, played: false)
      #expect(mapped.code == "http-\(status)")
      #expect(mapped.httpStatus == status)
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

  @Test("engine sourceRefused and sourceRateLimited map HTTP status codes")
  func engineHttpStatuses() {
    let notFound = mapFailure(
      .engine(kind: "sourceRefused", underlyingDomain: nil, underlyingCode: 404),
      url: sampleUrl,
      live: true,
      played: false
    )
    #expect(notFound.code == "http-404")
    #expect(notFound.httpStatus == 404)

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

  @Test("open and probe failures map to network for URL errors, live or played, else unsupported-format")
  func openAndProbeKinds() {
    for kind in ["sourceOpenFailed", "vodSourceFailed", "customSourceProbeFailed"] {
      let urlError = mapFailure(
        .engine(kind: kind, underlyingDomain: NSURLErrorDomain, underlyingCode: -1001),
        url: sampleUrl,
        live: false,
        played: false
      )
      #expect(urlError.code == "network")

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
  }

  @Test("format kinds map to unsupported-format")
  func unsupportedFormatKinds() {
    let kinds = [
      "hlsFormatUnsupported",
      "masterPlaylistRejected",
      "hlsPlaylistOnRawLivePath",
      "demuxedAudioLiveUnsupported",
      "noPlayableTrackWithinBudget",
      "dolbyVisionRequiresHardware",
      "sourceFabricatesRanges",
    ]
    for kind in kinds {
      let mapped = mapFailure(
        .engine(kind: kind, underlyingDomain: nil, underlyingCode: nil),
        url: sampleUrl,
        live: true,
        played: false
      )
      #expect(mapped.code == "unsupported-format")
    }
  }

  @Test("nativeItemFailed maps NSURLErrorDomain to network and others to decoder")
  func nativeItemFailedMapping() {
    let net = mapFailure(
      .engine(kind: "nativeItemFailed", underlyingDomain: NSURLErrorDomain, underlyingCode: -1009),
      url: sampleUrl,
      live: false,
      played: true
    )
    #expect(net.code == "network")

    let dec = mapFailure(
      .engine(kind: "nativeItemFailed", underlyingDomain: "AVFoundationErrorDomain", underlyingCode: -11850),
      url: sampleUrl,
      live: false,
      played: false
    )
    #expect(dec.code == "decoder")
  }

  @Test("decoder, engine-wedged, storageExhausted and unknown kinds map accurately")
  func decoderWedgedAndUnknownKinds() {
    for kind in ["softwarePipelineFailed", "audioBridgeProducedNoOutput", "audioSessionFailed", "audioTrackSwitchFailed"] {
      let mapped = mapFailure(
        .engine(kind: kind, underlyingDomain: nil, underlyingCode: nil),
        url: sampleUrl,
        live: true,
        played: true
      )
      #expect(mapped.code == "decoder")
    }

    let reload = mapFailure(
      .engine(kind: "reloadFailed", underlyingDomain: nil, underlyingCode: nil),
      url: sampleUrl,
      live: true,
      played: true
    )
    #expect(reload.code == "engine-wedged")

    let rebuild = mapFailure(.rebuildFailed, url: sampleUrl, live: true, played: false)
    #expect(rebuild.code == "engine-wedged")

    for kind in ["storageExhausted", "brandNewFutureKind"] {
      let mapped = mapFailure(
        .engine(kind: kind, underlyingDomain: nil, underlyingCode: nil),
        url: sampleUrl,
        live: true,
        played: false
      )
      #expect(mapped.code == "unknown")
    }
  }

  @Test("the detail never carries credentials")
  func detailRedactsCredentials() {
    let mapped = mapFailure(
      .engine(kind: "sourceRefused", underlyingDomain: "HTTP", underlyingCode: 404),
      url: "http://h:8080/live/user/pass/1.ts?token=x",
      live: true,
      played: false
    )
    #expect(mapped.detail.contains("http://h:8080/live/***/***/1.ts"))
    #expect(!mapped.detail.contains("user"))
    #expect(!mapped.detail.contains("pass"))
    #expect(!mapped.detail.contains("token"))
  }
}

import ElvAetherCore
import Foundation
import Testing

@Suite("SceneLinkReplay (#258)")
struct SceneLinkReplayTests {
  @Test("queues cold-launch URLs until JavaScript loads, replays once, and deduplicates subsequent notifications")
  func coldLaunchQueuedAndReplayedOnceOnJsLoad() {
    var replay = SceneLinkReplay()
    #expect(replay.isJavaScriptLoaded == false)
    #expect(replay.hasPendingColdLaunchURLs == false)

    let immediate = replay.enqueueColdLaunchURLs([
      "elviptv://play/live/42",
      "  ",
      "elviptv://play/live/42",
      "https://elv.example/watch/99",
    ])
    #expect(immediate == [])
    #expect(replay.hasPendingColdLaunchURLs == true)
    #expect(replay.pendingColdLaunchURLs == [
      "elviptv://play/live/42",
      "https://elv.example/watch/99",
    ])

    // Duplicate cold-launch enqueue before JS load does not duplicate pending entries
    let duplicateBeforeLoad = replay.enqueueColdLaunchURLs(["elviptv://play/live/42"])
    #expect(duplicateBeforeLoad == [])
    #expect(replay.pendingColdLaunchURLs == [
      "elviptv://play/live/42",
      "https://elv.example/watch/99",
    ])

    // First JS-load notification replays all queued URLs in order
    let replayed = replay.markJavaScriptLoaded()
    #expect(replay.isJavaScriptLoaded == true)
    #expect(replay.hasPendingColdLaunchURLs == false)
    #expect(replayed == [
      "elviptv://play/live/42",
      "https://elv.example/watch/99",
    ])

    // Repeated JS-load notifications or active fallback never fire again
    #expect(replay.markJavaScriptLoaded() == [])
    #expect(replay.flushPendingForActiveFallback() == [])
    #expect(replay.enqueueColdLaunchURLs(["elviptv://play/live/42"]) == [])
  }

  @Test("delivers cold-launch URLs immediately when JavaScript is already loaded")
  func coldLaunchWhenJsAlreadyLoadedDeliversImmediately() {
    var replay = SceneLinkReplay(isJavaScriptLoaded: true)

    let first = replay.enqueueColdLaunchURLs(["elviptv://import?url=https%3A%2F%2Fexample.com%2Fa.m3u"])
    #expect(first == ["elviptv://import?url=https%3A%2F%2Fexample.com%2Fa.m3u"])
    #expect(replay.hasPendingColdLaunchURLs == false)

    // Same cold-launch URL is deduplicated if scene reconnects with stale connectionOptions
    let repeated = replay.enqueueColdLaunchURLs(["elviptv://import?url=https%3A%2F%2Fexample.com%2Fa.m3u"])
    #expect(repeated == [])

    // A brand-new cold-launch URL on a later scene connection delivers immediately
    let second = replay.enqueueColdLaunchURLs(["elviptv://settings"])
    #expect(second == ["elviptv://settings"])
  }

  @Test("flushes queued cold-launch URLs once via didBecomeActive fallback and suppresses later JS-load duplicate")
  func activeFallbackFlushesOnceWithoutDoubleDelivery() {
    var replay = SceneLinkReplay()
    _ = replay.enqueueColdLaunchURLs(["elviptv://play/vod/7"])
    #expect(replay.hasPendingColdLaunchURLs == true)

    let flushed = replay.flushPendingForActiveFallback()
    #expect(flushed == ["elviptv://play/vod/7"])
    #expect(replay.hasPendingColdLaunchURLs == false)

    // Subsequent fallback or late RCTJavaScriptDidLoadNotification must not re-emit the same URL
    #expect(replay.flushPendingForActiveFallback() == [])
    #expect(replay.markJavaScriptLoaded() == [])
  }

  @Test("delivers warm URLs directly across repeated activations and clears matching pending cold-launch entry")
  func warmUrlsDeliverDirectlyAndClearPendingDuplicate() {
    var replay = SceneLinkReplay()
    _ = replay.enqueueColdLaunchURLs(["elviptv://channel/1", "elviptv://channel/2"])

    // Warm delivery of a still-pending URL emits immediately and prevents duplicate cold-launch replay
    let warmBatch = replay.prepareWarmURLs(["elviptv://channel/1", "elviptv://channel/1", ""])
    #expect(warmBatch == ["elviptv://channel/1"])
    #expect(replay.pendingColdLaunchURLs == ["elviptv://channel/2"])

    // Remaining pending URL still replays when JS finishes loading
    let replayed = replay.markJavaScriptLoaded()
    #expect(replayed == ["elviptv://channel/2"])

    // Re-opening the same deep link in a separate warm activation delivers again
    let warmAgain = replay.prepareWarmURLs(["elviptv://channel/1"])
    #expect(warmAgain == ["elviptv://channel/1"])
  }

  @Test("extracts universal link URLs strictly for NSUserActivityTypeBrowsingWeb")
  func extractsUniversalLinkFromBrowsingWebActivityOnly() {
    let url = URL(string: "https://elv.example/channel/101")
    #expect(
      SceneLinkReplay.extractBrowsingWebURL(
        activityType: NSUserActivityTypeBrowsingWeb,
        webpageURL: url
      ) == "https://elv.example/channel/101"
    )
    #expect(
      SceneLinkReplay.extractBrowsingWebURL(
        activityType: "com.elv.iptv.handoff",
        webpageURL: url
      ) == nil
    )
    #expect(
      SceneLinkReplay.extractBrowsingWebURL(
        activityType: NSUserActivityTypeBrowsingWeb,
        webpageURL: nil
      ) == nil
    )
  }
}

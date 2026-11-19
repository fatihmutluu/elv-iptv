import ElvAetherCore
import Testing

@Suite("CommandFence")
struct CommandFenceTests {
  @Test("synchronous recreate(t) followed by load(...) preserves rebuildFirst on the load epoch")
  func recreateFollowedByLoadPreservesRebuild() throws {
    let fence = CommandFence()
    let recreateEpoch = try #require(fence.recordRecreate(attempt: 5))
    let loadEpoch = try #require(fence.recordLoad(attempt: 5))

    // Main queue drains FIFO: recreate block runs first, sees newer loadEpoch, defers rebuild to load.
    #expect(fence.beginRecreate(epoch: recreateEpoch) == .superseded)
    #expect(fence.beginMedia(epoch: loadEpoch) == .run(epoch: loadEpoch, rebuildFirst: true))

    // Subsequent load without another recreate does not rebuild again.
    let nextEpoch = try #require(fence.recordLoad(attempt: 6))
    #expect(fence.beginMedia(epoch: nextEpoch) == .run(epoch: nextEpoch, rebuildFirst: false))
  }

  @Test("superseded load before recreate+load never consumes pendingRebuild")
  func supersededLoadNeverConsumesPendingRebuild() throws {
    let fence = CommandFence()
    let staleLoad = try #require(fence.recordLoad(attempt: 1))
    let recreateEpoch = try #require(fence.recordRecreate(attempt: 2))
    let activeLoad = try #require(fence.recordLoad(attempt: 2))

    #expect(fence.beginMedia(epoch: staleLoad) == .superseded)
    #expect(fence.beginRecreate(epoch: recreateEpoch) == .superseded)
    #expect(fence.beginMedia(epoch: activeLoad) == .run(epoch: activeLoad, rebuildFirst: true))
  }

  @Test("standalone recreate executes immediately when no newer media superseded it")
  func standaloneRecreateExecutes() throws {
    let fence = CommandFence()
    let epoch = try #require(fence.recordRecreate(attempt: 3))
    #expect(fence.beginRecreate(epoch: epoch) == .run(epoch: epoch))

    // Once consumed, a subsequent load runs normally without rebuilding twice.
    let loadEpoch = try #require(fence.recordLoad(attempt: 4))
    #expect(fence.beginMedia(epoch: loadEpoch) == .run(epoch: loadEpoch, rebuildFirst: false))
  }

  @Test("tracks events fence by mediaEpoch and adopt latest in-epoch token while dropping stale epochs")
  func tracksFencedByMediaEpochNotExactToken() throws {
    let fence = CommandFence()
    let epoch1 = try #require(fence.recordLoad(attempt: 10))
    #expect(fence.beginMedia(epoch: epoch1) == .run(epoch: epoch1, rebuildFirst: false))

    // JS calls pause(11) synchronously before MainActor emits tracks(attempt: 10).
    let pauseEpoch = try #require(fence.recordInEpochCommand(attempt: 11))
    #expect(pauseEpoch == epoch1)

    let sample = MediaTracksOut(
      audio: [TrackInfoOut(id: "a:1", language: "eng", label: "English")],
      subtitles: [],
      selectedAudioId: "a:1",
      selectedSubtitleId: nil
    )

    // Tracks from epoch1 with older token 10 are NOT dropped; they adopt current token 11!
    let delivered = fence.filterOutbound(.tracks(attempt: 10, tracks: sample), driverEpoch: epoch1)
    #expect(delivered == .tracks(attempt: 11, tracks: sample))

    // Non-tracks events with stale token 10 are still dropped until EngineCore adopts 11.
    #expect(fence.filterOutbound(.state(attempt: 10, state: .playing), driverEpoch: epoch1) == nil)
    #expect(fence.filterOutbound(.state(attempt: 11, state: .paused), driverEpoch: epoch1) == .state(attempt: 11, state: .paused))

    // Once a new media loads (epoch2), tracks from epoch1 are strictly dropped.
    let epoch2 = try #require(fence.recordLoad(attempt: 12))
    #expect(fence.filterOutbound(.tracks(attempt: 11, tracks: sample), driverEpoch: epoch1) == nil)
    #expect(fence.filterOutbound(.tracks(attempt: 12, tracks: sample), driverEpoch: epoch1) == nil)
    #expect(fence.filterOutbound(.tracks(attempt: 12, tracks: sample), driverEpoch: epoch2) == .tracks(attempt: 12, tracks: sample))
  }

  @Test("dispose rejects all future commands and outbound events")
  func disposeRejectsEverything() throws {
    let fence = CommandFence()
    let epoch = try #require(fence.recordLoad(attempt: 1))
    #expect(fence.markDisposed())
    #expect(!fence.markDisposed())
    #expect(fence.isDisposedNow)
    #expect(fence.recordLoad(attempt: 2) == nil)
    #expect(fence.beginMedia(epoch: epoch) == .superseded)
    #expect(fence.filterOutbound(.surface(attempt: 1, change: .destroyed), driverEpoch: epoch) == nil)
  }
}

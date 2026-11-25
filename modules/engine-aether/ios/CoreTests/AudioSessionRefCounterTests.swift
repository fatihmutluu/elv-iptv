import ElvAetherCore
import Foundation
import Testing

@Suite("AetherAudioSessionRefCounter & NowPlayingOwnershipTracker (#34)")
struct AudioSessionRefCounterTests {
  @Test("ref-counter activates on 0 -> 1, deduplicates same owner, and deactivates strictly on 1 -> 0")
  func refCounterBalancesMultipleLiveEngines() {
    var counter = AetherAudioSessionRefCounter()
    #expect(counter.activeCount == 0)
    #expect(!counter.isOwned(by: 1))
    let releaseEmpty = counter.release(ownerId: 1)
    #expect(!releaseEmpty)

    // Primary engine acquires (0 -> 1)
    let firstAcquire = counter.acquire(ownerId: 1)
    #expect(firstAcquire)
    #expect(counter.activeCount == 1)
    #expect(counter.isOwned(by: 1))

    // Re-acquiring by same engine is idempotent and does not inflate count
    let dupAcquire = counter.acquire(ownerId: 1)
    #expect(!dupAcquire)
    #expect(counter.activeCount == 1)

    // Secondary Multi-View tile joins (1 -> 2)
    let secondAcquire = counter.acquire(ownerId: 2)
    #expect(!secondAcquire)
    #expect(counter.activeCount == 2)
    #expect(counter.isOwned(by: 2))

    // Secondary tile stops/disposes (2 -> 1): MUST NOT deactivate shared AVAudioSession!
    let releaseSecondary = counter.release(ownerId: 2)
    #expect(!releaseSecondary)
    #expect(counter.activeCount == 1)
    #expect(!counter.isOwned(by: 2))
    #expect(counter.isOwned(by: 1))

    // Duplicate release by secondary tile is a safe no-op
    let dupReleaseSecondary = counter.release(ownerId: 2)
    #expect(!dupReleaseSecondary)
    #expect(counter.activeCount == 1)

    // Primary engine stops/disposes (1 -> 0): MUST deactivate shared AVAudioSession!
    let releasePrimary = counter.release(ownerId: 1)
    #expect(releasePrimary)
    #expect(counter.activeCount == 0)
    #expect(!counter.isOwned(by: 1))

    // Subsequent release after 0 does not re-deactivate
    let releaseAgain = counter.release(ownerId: 1)
    #expect(!releaseAgain)
  }

  @Test("ref-counter keeps session active when primary closes during handoff to secondary tile")
  func refCounterSurvivesPrimaryToSecondaryHandoff() {
    var counter = AetherAudioSessionRefCounter()
    let acquire10 = counter.acquire(ownerId: 10)
    #expect(acquire10)
    let acquire20 = counter.acquire(ownerId: 20)
    #expect(!acquire20)
    #expect(counter.activeCount == 2)

    // Tile 1 closes while Tile 2 is still alive -> stays active
    let release10 = counter.release(ownerId: 10)
    #expect(!release10)
    #expect(counter.activeCount == 1)
    #expect(counter.isOwned(by: 20))

    // Tile 2 promoted and re-acquires -> idempotent
    let reAcquire20 = counter.acquire(ownerId: 20)
    #expect(!reAcquire20)
    #expect(counter.activeCount == 1)

    // Final tile closes -> deactivates
    let release20 = counter.release(ownerId: 20)
    #expect(release20)
    #expect(counter.activeCount == 0)

    _ = counter.acquire(ownerId: 30)
    counter.reset()
    #expect(counter.activeCount == 0)
  }

  @Test("NowPlayingOwnershipTracker prevents demoted or secondary tiles from clearing a promoted primary")
  func nowPlayingOwnershipHandoffIsolation() {
    var tracker = NowPlayingOwnershipTracker()
    #expect(tracker.activeOwnerId == nil)
    #expect(!tracker.isCurrentOwner(1))
    let releaseEmpty = tracker.releaseIfOwner(1)
    #expect(!releaseEmpty)

    // Tile 1 claims ownership
    tracker.claim(ownerId: 1)
    #expect(tracker.isCurrentOwner(1))
    #expect(!tracker.isCurrentOwner(2))

    // Secondary Tile 2 releasing on dispose never steals or clears Tile 1's ownership
    let releaseNonOwner = tracker.releaseIfOwner(2)
    #expect(!releaseNonOwner)
    #expect(tracker.isCurrentOwner(1))

    // Promote Tile 2 before Tile 1 demotes -> Tile 2 supersedes immediately
    tracker.claim(ownerId: 2)
    #expect(tracker.isCurrentOwner(2))
    #expect(!tracker.isCurrentOwner(1))

    // Demoting/disposing Tile 1 returns false so Tile 1 will NOT wipe Tile 2's MPNowPlayingInfoCenter
    let releaseDemoted = tracker.releaseIfOwner(1)
    #expect(!releaseDemoted)
    #expect(tracker.isCurrentOwner(2))

    // Disposing current owner Tile 2 returns true so it cleanly clears MPNowPlayingInfoCenter
    let releaseOwner = tracker.releaseIfOwner(2)
    #expect(releaseOwner)
    #expect(tracker.activeOwnerId == nil)
    let releaseAfterClear = tracker.releaseIfOwner(2)
    #expect(!releaseAfterClear)

    tracker.claim(ownerId: 3)
    tracker.reset()
    #expect(tracker.activeOwnerId == nil)
  }
}

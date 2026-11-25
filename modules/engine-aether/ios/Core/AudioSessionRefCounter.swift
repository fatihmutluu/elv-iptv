import Foundation

/// Pure ref-counting state tracking active `AVAudioSession` owners across live engines (`#34`).
/// Ensures `AVAudioSession.setActive(false)` is called strictly when the final active owner releases (`1 -> 0`).
public struct AetherAudioSessionRefCounter: Equatable, Sendable {
  private var activeOwners: Set<UInt64> = []

  public init() {}

  /// Number of distinct live engines currently holding an active `AVAudioSession` lease.
  public var activeCount: Int {
    activeOwners.count
  }

  /// Whether `ownerId` currently holds an active lease.
  public func isOwned(by ownerId: UInt64) -> Bool {
    activeOwners.contains(ownerId)
  }

  /// Acquires a lease for `ownerId` (idempotent). Returns `true` when active leases transition `0 -> 1`.
  @discardableResult
  public mutating func acquire(ownerId: UInt64) -> Bool {
    let wasEmpty = activeOwners.isEmpty
    activeOwners.insert(ownerId)
    return wasEmpty && !activeOwners.isEmpty
  }

  /// Releases the lease for `ownerId` (idempotent). Returns `true` strictly when active leases transition `1 -> 0`.
  @discardableResult
  public mutating func release(ownerId: UInt64) -> Bool {
    guard activeOwners.remove(ownerId) != nil else {
      return false
    }
    return activeOwners.isEmpty
  }

  /// Clears all tracked leases.
  public mutating func reset() {
    activeOwners.removeAll()
  }
}

/// Pure singleton ownership tracker coordinating `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter`
/// across concurrent Multi-View engines (`#34`).
public struct NowPlayingOwnershipTracker: Equatable, Sendable {
  public private(set) var activeOwnerId: UInt64?

  public init() {}

  /// Returns `true` strictly when `ownerId` is the currently active Now Playing owner.
  public func isCurrentOwner(_ ownerId: UInt64) -> Bool {
    activeOwnerId == ownerId
  }

  /// Claims singleton Now Playing ownership for `ownerId`, superseding any previous owner.
  public mutating func claim(ownerId: UInt64) {
    activeOwnerId = ownerId
  }

  /// Releases ownership if `ownerId` is still the active owner.
  /// Returns `true` iff `ownerId` was the active owner (safe to clear singleton Now Playing state).
  @discardableResult
  public mutating func releaseIfOwner(_ ownerId: UInt64) -> Bool {
    guard activeOwnerId == ownerId else {
      return false
    }
    activeOwnerId = nil
    return true
  }

  /// Clears active ownership.
  public mutating func reset() {
    activeOwnerId = nil
  }
}

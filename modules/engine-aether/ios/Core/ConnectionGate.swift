import Foundation

/// Media-boundary connection gate ensuring older media connections close before a newer media opens.
public final class ConnectionGate: @unchecked Sendable {
  private struct OpenSlot {
    var count: Int
    var forceCloses: [@Sendable () -> Void]
  }

  private enum WaitOutcome: Sendable {
    case acquired
    case superseded
    case forced([@Sendable () -> Void])
  }

  private struct Waiter {
    let generation: Int
    let acquiresSlot: Bool
    let forceClose: @Sendable () -> Void
    let continuation: CheckedContinuation<WaitOutcome, Never>
  }

  private let lock = NSLock()
  private let forceCloseAfterMs: Int
  private let settleAfterCloseMs: Int
  private let uptimeMs: @Sendable () -> Double
  private var currentGeneration = 0
  private var lastClosedDeadlineMs: Double = 0
  private var openSlots: [Int: OpenSlot] = [:]
  private var waiters: [UUID: Waiter] = [:]

  public init(
    forceCloseAfterMs: Int = 1_000,
    settleAfterCloseMs: Int = 0,
    uptimeMs: @escaping @Sendable () -> Double = { ProcessInfo.processInfo.systemUptime * 1_000.0 }
  ) {
    self.forceCloseAfterMs = max(1, forceCloseAfterMs)
    self.settleAfterCloseMs = max(0, settleAfterCloseMs)
    self.uptimeMs = uptimeMs
  }

  /// Advances the gate generation (for `stop`, `recreate`, or `dispose`) so older waiting opens abort immediately.
  public func advance(to generation: Int) {
    let supersededContinuations: [CheckedContinuation<WaitOutcome, Never>] = lock.withLock {
      guard generation > currentGeneration else { return [] }
      currentGeneration = generation
      return drainSupersededWaitersLocked()
    }
    for continuation in supersededContinuations {
      continuation.resume(returning: .superseded)
    }
  }

  /// Waits until all older generations closed and settled without acquiring an open slot; returns false if superseded.
  public func waitForClosed(before generation: Int) async -> Bool {
    await wait(generation: generation, acquiresSlot: false, forceClose: {})
  }

  /// Waits until all older generations closed (or force-closes them after `forceCloseAfterMs`); returns false if superseded.
  public func open(generation: Int, forceClose: @escaping @Sendable () -> Void) async -> Bool {
    await wait(generation: generation, acquiresSlot: true, forceClose: forceClose)
  }

  private func wait(
    generation: Int,
    acquiresSlot: Bool,
    forceClose: @escaping @Sendable () -> Void
  ) async -> Bool {
    let id = UUID()
    let timeoutNs = UInt64(forceCloseAfterMs) * 1_000_000

    let outcome: WaitOutcome = await withTaskCancellationHandler {
      await withCheckedContinuation { (continuation: CheckedContinuation<WaitOutcome, Never>) in
        var immediate: WaitOutcome?
        var supersededOthers: [CheckedContinuation<WaitOutcome, Never>] = []

        lock.withLock {
          if generation < currentGeneration {
            immediate = .superseded
            return
          }
          if generation > currentGeneration {
            currentGeneration = generation
            supersededOthers = drainSupersededWaitersLocked()
          }
          if !hasOpenOlderThanLocked(generation) {
            if acquiresSlot {
              recordOpenLocked(generation: generation, forceClose: forceClose)
            }
            immediate = .acquired
            return
          }
          waiters[id] = Waiter(
            generation: generation,
            acquiresSlot: acquiresSlot,
            forceClose: forceClose,
            continuation: continuation
          )
        }

        for other in supersededOthers {
          other.resume(returning: .superseded)
        }

        if let immediate {
          continuation.resume(returning: immediate)
          return
        }

        Task.detached { [weak self] in
          try? await Task.sleep(nanoseconds: timeoutNs)
          self?.handleTimeout(waiterId: id)
        }
      }
    } onCancel: {
      self.cancelWaiter(waiterId: id)
    }

    switch outcome {
    case .acquired:
      break
    case .superseded:
      return false
    case let .forced(closures):
      NSLog("ELV_AETHER gateForceClose count=%d afterMs=%d", closures.count, forceCloseAfterMs)
      for closure in closures {
        closure()
      }
      if settleAfterCloseMs > 0 {
        lock.withLock {
          lastClosedDeadlineMs = max(lastClosedDeadlineMs, uptimeMs() + Double(settleAfterCloseMs))
        }
      }
    }

    let remainingMs: Double = lock.withLock {
      settleAfterCloseMs > 0 ? max(0.0, lastClosedDeadlineMs - uptimeMs()) : 0.0
    }
    if remainingMs > 0 {
      try? await Task.sleep(nanoseconds: UInt64((remainingMs * 1_000_000.0).rounded(.up)))
    }

    var readyToWake: [(CheckedContinuation<WaitOutcome, Never>, WaitOutcome)] = []
    let stillValid: Bool = lock.withLock {
      if Task.isCancelled || generation < currentGeneration {
        if acquiresSlot {
          releaseSlotLocked(generation: generation)
          readyToWake = wakeEligibleWaitersLocked()
        }
        return false
      }
      return true
    }
    for (continuation, nextOutcome) in readyToWake {
      continuation.resume(returning: nextOutcome)
    }
    return stillValid
  }

  /// Reports one connection of `generation` closed and unblocks any waiting newer generation.
  public func closed(generation: Int) {
    let ready: [(CheckedContinuation<WaitOutcome, Never>, WaitOutcome)] = lock.withLock {
      if releaseSlotLocked(generation: generation), settleAfterCloseMs > 0 {
        lastClosedDeadlineMs = max(lastClosedDeadlineMs, uptimeMs() + Double(settleAfterCloseMs))
      }
      return wakeEligibleWaitersLocked()
    }
    for (continuation, outcome) in ready {
      continuation.resume(returning: outcome)
    }
  }

  private func handleTimeout(waiterId: UUID) {
    var resumed: (CheckedContinuation<WaitOutcome, Never>, WaitOutcome)?
    var wokeOthers: [(CheckedContinuation<WaitOutcome, Never>, WaitOutcome)] = []

    lock.withLock {
      guard let waiter = waiters.removeValue(forKey: waiterId) else { return }
      if waiter.generation < currentGeneration {
        resumed = (waiter.continuation, .superseded)
        return
      }
      let olderKeys = openSlots.keys.filter { $0 < waiter.generation }
      var closures: [@Sendable () -> Void] = []
      for key in olderKeys {
        if let removed = openSlots.removeValue(forKey: key) {
          closures.append(contentsOf: removed.forceCloses)
        }
      }
      if waiter.acquiresSlot {
        recordOpenLocked(generation: waiter.generation, forceClose: waiter.forceClose)
      }
      resumed = (waiter.continuation, closures.isEmpty ? .acquired : .forced(closures))
      wokeOthers = wakeEligibleWaitersLocked()
    }

    if let (continuation, outcome) = resumed {
      continuation.resume(returning: outcome)
    }
    for (continuation, outcome) in wokeOthers {
      continuation.resume(returning: outcome)
    }
  }

  private func cancelWaiter(waiterId: UUID) {
    let continuation: CheckedContinuation<WaitOutcome, Never>? = lock.withLock {
      waiters.removeValue(forKey: waiterId)?.continuation
    }
    continuation?.resume(returning: .superseded)
  }

  private func hasOpenOlderThanLocked(_ generation: Int) -> Bool {
    openSlots.keys.contains { $0 < generation }
  }

  private func recordOpenLocked(generation: Int, forceClose: @escaping @Sendable () -> Void) {
    if var existing = openSlots[generation] {
      existing.count += 1
      existing.forceCloses.append(forceClose)
      openSlots[generation] = existing
    } else {
      openSlots[generation] = OpenSlot(count: 1, forceCloses: [forceClose])
    }
  }

  @discardableResult
  private func releaseSlotLocked(generation: Int) -> Bool {
    guard var slot = openSlots[generation] else { return false }
    if slot.count <= 1 {
      openSlots.removeValue(forKey: generation)
    } else {
      slot.count -= 1
      openSlots[generation] = slot
    }
    return true
  }

  private func drainSupersededWaitersLocked() -> [CheckedContinuation<WaitOutcome, Never>] {
    let staleIds = waiters.compactMap { id, waiter in
      waiter.generation < currentGeneration ? id : nil
    }
    return staleIds.compactMap { waiters.removeValue(forKey: $0)?.continuation }
  }

  private func wakeEligibleWaitersLocked() -> [(CheckedContinuation<WaitOutcome, Never>, WaitOutcome)] {
    var results: [(CheckedContinuation<WaitOutcome, Never>, WaitOutcome)] = []
    let ids = Array(waiters.keys)
    for id in ids {
      guard let waiter = waiters[id] else { continue }
      if waiter.generation < currentGeneration {
        waiters.removeValue(forKey: id)
        results.append((waiter.continuation, .superseded))
      } else if !hasOpenOlderThanLocked(waiter.generation) {
        waiters.removeValue(forKey: id)
        if waiter.acquiresSlot {
          recordOpenLocked(generation: waiter.generation, forceClose: waiter.forceClose)
        }
        results.append((waiter.continuation, .acquired))
      }
    }
    return results
  }
}

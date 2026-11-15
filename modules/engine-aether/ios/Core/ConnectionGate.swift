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
    let forceClose: @Sendable () -> Void
    let continuation: CheckedContinuation<WaitOutcome, Never>
  }

  private let lock = NSLock()
  private let forceCloseAfterMs: Int
  private var currentGeneration = 0
  private var openSlots: [Int: OpenSlot] = [:]
  private var waiters: [UUID: Waiter] = [:]

  public init(forceCloseAfterMs: Int = 1_000) {
    self.forceCloseAfterMs = max(1, forceCloseAfterMs)
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

  /// Waits until all older generations closed (or force-closes them after `forceCloseAfterMs`); returns false if superseded.
  public func open(generation: Int, forceClose: @escaping @Sendable () -> Void) async -> Bool {
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
            recordOpenLocked(generation: generation, forceClose: forceClose)
            immediate = .acquired
            return
          }
          waiters[id] = Waiter(
            generation: generation,
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
      return true
    case .superseded:
      return false
    case let .forced(closures):
      NSLog("ELV_AETHER gateForceClose count=%d afterMs=%d", closures.count, forceCloseAfterMs)
      for closure in closures {
        closure()
      }
      return true
    }
  }

  /// Reports one connection of `generation` closed and unblocks any waiting newer generation.
  public func closed(generation: Int) {
    let ready: [(CheckedContinuation<WaitOutcome, Never>, WaitOutcome)] = lock.withLock {
      if var slot = openSlots[generation] {
        if slot.count <= 1 {
          openSlots.removeValue(forKey: generation)
        } else {
          slot.count -= 1
          openSlots[generation] = slot
        }
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
      recordOpenLocked(generation: waiter.generation, forceClose: waiter.forceClose)
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
        recordOpenLocked(generation: waiter.generation, forceClose: waiter.forceClose)
        results.append((waiter.continuation, .acquired))
      }
    }
    return results
  }
}

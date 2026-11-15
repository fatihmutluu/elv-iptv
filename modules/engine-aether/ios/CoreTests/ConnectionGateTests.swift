import ElvAetherCore
import Foundation
import Testing

private final class AtomicFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false

  func set(_ next: Bool = true) {
    lock.withLock { value = next }
  }

  func get() -> Bool {
    lock.withLock { value }
  }
}

@Suite("ConnectionGate")
struct ConnectionGateTests {
  @Test("a newer open waits until the older connection closed")
  func newerOpenWaitsUntilOlderClosed() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 1_000)
    let firstOpened = await gate.open(generation: 1, forceClose: {})
    #expect(firstOpened)

    let secondFinished = AtomicFlag()
    let secondTask = Task {
      let ok = await gate.open(generation: 2, forceClose: {})
      secondFinished.set(true)
      return ok
    }

    try await Task.sleep(nanoseconds: 50_000_000)
    #expect(!secondFinished.get())

    gate.closed(generation: 1)
    let secondOpened = await secondTask.value
    #expect(secondOpened)
    #expect(secondFinished.get())
    gate.closed(generation: 2)
  }

  @Test("force-closes an older connection after 1,000 ms")
  func forceClosesOlderConnectionAfterTimeout() async {
    let gate = ConnectionGate(forceCloseAfterMs: 80)
    let forced = AtomicFlag()

    let firstOpened = await gate.open(
      generation: 1,
      forceClose: { forced.set(true) }
    )
    #expect(firstOpened)

    let start = ProcessInfo.processInfo.systemUptime
    let secondOpened = await gate.open(generation: 2, forceClose: {})
    let elapsedMs = (ProcessInfo.processInfo.systemUptime - start) * 1_000.0

    #expect(secondOpened)
    #expect(forced.get())
    #expect(elapsedMs >= 60)
    gate.closed(generation: 1)
    gate.closed(generation: 2)
  }

  @Test("a superseded open returns false and opens nothing")
  func supersededOpenReturnsFalseAndOpensNothing() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 1_000)
    let firstOpened = await gate.open(generation: 1, forceClose: {})
    #expect(firstOpened)

    let staleForced = AtomicFlag()
    let secondTask = Task {
      await gate.open(generation: 2, forceClose: { staleForced.set(true) })
    }
    try await Task.sleep(nanoseconds: 30_000_000)

    let thirdTask = Task {
      await gate.open(generation: 3, forceClose: {})
    }

    let secondOpened = await secondTask.value
    #expect(!secondOpened)
    #expect(!staleForced.get())

    let staleZeroOpened = await gate.open(generation: 2, forceClose: { staleForced.set(true) })
    #expect(!staleZeroOpened)

    gate.closed(generation: 1)
    let thirdOpened = await thirdTask.value
    #expect(thirdOpened)
    gate.closed(generation: 3)
  }

  @Test("waits for settleAfterCloseMs after an older connection closes before opening the next")
  func waitsForSettleWindowAfterOlderConnectionCloses() async {
    let gate = ConnectionGate(forceCloseAfterMs: 1_000, settleAfterCloseMs: 40)

    let coldStart = ProcessInfo.processInfo.systemUptime
    let firstOpened = await gate.open(generation: 1, forceClose: {})
    let coldElapsedMs = (ProcessInfo.processInfo.systemUptime - coldStart) * 1_000.0
    #expect(firstOpened)
    #expect(coldElapsedMs < 20)

    let closeStart = ProcessInfo.processInfo.systemUptime
    gate.closed(generation: 1)
    let secondOpened = await gate.open(generation: 2, forceClose: {})
    let settleElapsedMs = (ProcessInfo.processInfo.systemUptime - closeStart) * 1_000.0

    #expect(secondOpened)
    #expect(settleElapsedMs >= 30)
    gate.closed(generation: 2)
  }

  @Test("a generation superseded during the close-settle window returns false and releases its slot")
  func generationSupersededDuringSettleReturnsFalse() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 1_000, settleAfterCloseMs: 80)
    let firstOpened = await gate.open(generation: 1, forceClose: {})
    #expect(firstOpened)
    gate.closed(generation: 1)

    let secondTask = Task {
      await gate.open(generation: 2, forceClose: {})
    }
    try await Task.sleep(nanoseconds: 15_000_000)
    gate.advance(to: 3)
    secondTask.cancel()

    let secondOpened = await secondTask.value
    #expect(!secondOpened)

    let thirdOpened = await gate.open(generation: 3, forceClose: {})
    #expect(thirdOpened)
    gate.closed(generation: 3)
  }
}

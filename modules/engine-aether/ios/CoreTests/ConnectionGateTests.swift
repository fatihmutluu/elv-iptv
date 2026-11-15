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

  @Test("waitForClosed waits for older open slot and settle window without acquiring an open slot")
  func waitForClosedWaitsForOlderAndSettleWithoutAcquiringSlot() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 1_000, settleAfterCloseMs: 40)

    let coldStart = ProcessInfo.processInfo.systemUptime
    let coldReady = await gate.waitForClosed(before: 1)
    let coldElapsedMs = (ProcessInfo.processInfo.systemUptime - coldStart) * 1_000.0
    #expect(coldReady)
    #expect(coldElapsedMs < 20)

    let tsOpened = await gate.open(generation: 2, forceClose: {})
    #expect(tsOpened)

    let hlsDone = AtomicFlag()
    let hlsTask = Task {
      let ok = await gate.waitForClosed(before: 3)
      hlsDone.set(true)
      return ok
    }
    try await Task.sleep(nanoseconds: 30_000_000)
    #expect(!hlsDone.get())

    let closeStart = ProcessInfo.processInfo.systemUptime
    gate.closed(generation: 2)
    let hlsReady = await hlsTask.value
    let settleElapsedMs = (ProcessInfo.processInfo.systemUptime - closeStart) * 1_000.0
    #expect(hlsReady)
    #expect(settleElapsedMs >= 30)

    // Generation 3 must NOT hold an open slot: generation 4 opens immediately without waiting 1,000 ms.
    let gen4Start = ProcessInfo.processInfo.systemUptime
    let gen4Opened = await gate.open(generation: 4, forceClose: {})
    let gen4ElapsedMs = (ProcessInfo.processInfo.systemUptime - gen4Start) * 1_000.0
    #expect(gen4Opened)
    #expect(gen4ElapsedMs < 50)
    gate.closed(generation: 4)
  }

  @Test("waitForClosed returns false immediately when superseded")
  func waitForClosedReturnsFalseWhenSuperseded() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 1_000, settleAfterCloseMs: 60)
    #expect(await gate.open(generation: 1, forceClose: {}))

    let waiterTask = Task {
      await gate.waitForClosed(before: 2)
    }
    try await Task.sleep(nanoseconds: 20_000_000)
    gate.advance(to: 3)

    #expect(await waiterTask.value == false)
    #expect(await gate.waitForClosed(before: 2) == false)

    gate.closed(generation: 1)
    #expect(await gate.waitForClosed(before: 3) == true)
  }

  @Test("advance(to: N) followed by waitForClosed(before: N) or open(generation: N) waits on N-1 and succeeds")
  func advanceThenWaitOrOpenSameGenerationSucceeds() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 1_000, settleAfterCloseMs: 25)
    gate.advance(to: 1)
    #expect(await gate.open(generation: 1, forceClose: {}))

    gate.advance(to: 2)
    let hlsTask = Task { await gate.waitForClosed(before: 2) }
    try await Task.sleep(nanoseconds: 15_000_000)
    gate.closed(generation: 1)
    #expect(await hlsTask.value == true)

    gate.advance(to: 3)
    #expect(await gate.open(generation: 3, forceClose: {}))
    gate.closed(generation: 3)
  }
}

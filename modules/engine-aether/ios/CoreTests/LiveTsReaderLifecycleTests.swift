import ElvAetherCore
import Foundation
import Testing

private final class LockedFlag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false

  func set(_ next: Bool = true) { lock.withLock { value = next } }
  func get() -> Bool { lock.withLock { value } }
}

private func makeLifecycleTsPackets(count: Int) -> Data {
  var data = Data(count: 188 * count)
  for i in 0..<count {
    data[i * 188] = 0x47
    data[i * 188 + 1] = UInt8(truncatingIfNeeded: i)
  }
  return data
}

@Suite("LiveTsReader async cancel lifecycle")
struct LiveTsReaderLifecycleTests {
  private let streamUrl = URL(string: "http://127.0.0.1:7878/live/demo/demo/1001.ts")!

  @Test("dropping LiveTsReader immediately after close() during open() waits for async transport completion and closes gate without timeout")
  func droppingReaderAfterCloseDuringOpenReleasesGateOnAsyncComplete() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 600)
    let forced = LockedFlag()
    let transport1 = FakeTransport()
    transport1.completeOnCancel = false

    weak var weakReader: LiveTsReader?
    var openTask: Task<ReaderOpen, Never>?

    do {
      let reader = LiveTsReader(
        url: streamUrl,
        headers: [:],
        generation: 1,
        gate: gate,
        makeTransport: { transport1 }
      )
      weakReader = reader
      openTask = Task { await reader.open() }
      try await Task.sleep(nanoseconds: 25_000_000)
      #expect(transport1.startCount == 1)

      reader.close()
      let verdict = await openTask!.value
      #expect(verdict == .superseded)
    }
    openTask = nil

    // Transport has not completed yet on URLSession's queue: reader must remain retained in-flight
    // and generation 2 must wait until the socket actually closes.
    #expect(weakReader != nil)

    let gen2Done = LockedFlag()
    let gen2Start = ProcessInfo.processInfo.systemUptime
    let gen2Task = Task {
      let ok = await gate.open(generation: 2, forceClose: { forced.set(true) })
      gen2Done.set(true)
      return ok
    }
    try await Task.sleep(nanoseconds: 25_000_000)
    #expect(!gen2Done.get())

    transport1.complete(
      error: .transport(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
    )

    let gen2Opened = await gen2Task.value
    let elapsedMs = (ProcessInfo.processInfo.systemUptime - gen2Start) * 1_000.0
    #expect(gen2Opened)
    #expect(!forced.get())
    #expect(elapsedMs < 200)
    try await Task.sleep(nanoseconds: 10_000_000)
    #expect(weakReader == nil)
    gate.closed(generation: 2)
  }

  @Test("dropping LiveTsReader immediately after HTTP 509 failure releases gate on async cancel completion")
  func droppingReaderAfterStatus509ReleasesGateOnAsyncComplete() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 600)
    let transport1 = FakeTransport()
    transport1.completeOnCancel = false
    transport1.onStart = { t in
      t.sendStatus(509, contentType: "text/plain")
    }

    weak var weakReader: LiveTsReader?
    do {
      let reader = LiveTsReader(
        url: streamUrl,
        headers: [:],
        generation: 1,
        gate: gate,
        makeTransport: { transport1 }
      )
      weakReader = reader
      let verdict = await reader.open()
      #expect(verdict == .failed(.status(509)))
      #expect(transport1.isCancelled)
    }

    #expect(weakReader != nil)

    let gen2Start = ProcessInfo.processInfo.systemUptime
    let gen2Task = Task { await gate.open(generation: 2, forceClose: {}) }
    try await Task.sleep(nanoseconds: 20_000_000)
    transport1.complete(
      error: .transport(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
    )

    let gen2Opened = await gen2Task.value
    let elapsedMs = (ProcessInfo.processInfo.systemUptime - gen2Start) * 1_000.0
    #expect(gen2Opened)
    #expect(elapsedMs < 200)
    try await Task.sleep(nanoseconds: 10_000_000)
    #expect(weakReader == nil)
    gate.closed(generation: 2)
  }

  @Test("dropping LiveTsReader immediately after close() during streaming releases gate on async cancel completion")
  func droppingReaderAfterCloseDuringStreamingReleasesGateOnAsyncComplete() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 600)
    let transport1 = FakeTransport()
    transport1.completeOnCancel = false
    transport1.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(makeLifecycleTsPackets(count: 6))
    }

    weak var weakReader: LiveTsReader?
    do {
      let reader = LiveTsReader(
        url: streamUrl,
        headers: [:],
        generation: 1,
        gate: gate,
        makeTransport: { transport1 }
      )
      weakReader = reader
      let verdict = await reader.open()
      #expect(verdict == .media(formatHint: "mpegts"))
      reader.close()
      #expect(transport1.isCancelled)
    }

    #expect(weakReader != nil)
    transport1.complete(
      error: .transport(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
    )

    let start = ProcessInfo.processInfo.systemUptime
    let gen2Opened = await gate.open(generation: 2, forceClose: {})
    let elapsedMs = (ProcessInfo.processInfo.systemUptime - start) * 1_000.0
    #expect(gen2Opened)
    #expect(elapsedMs < 200)
    try await Task.sleep(nanoseconds: 10_000_000)
    #expect(weakReader == nil)
    gate.closed(generation: 2)
  }

  @Test("playlist handoff waits on waitForClosed until async transport cancel and settle window finish")
  func playlistHandoffWaitsForAsyncCancelAndSettle() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 600, settleAfterCloseMs: 35)
    let transport1 = FakeTransport()
    transport1.completeOnCancel = false
    transport1.onStart = { t in
      t.sendStatus(200, contentType: "application/vnd.apple.mpegurl")
    }

    weak var weakReader: LiveTsReader?
    do {
      let reader = LiveTsReader(
        url: streamUrl,
        headers: [:],
        generation: 1,
        gate: gate,
        makeTransport: { transport1 }
      )
      weakReader = reader
      let verdict = await reader.open()
      #expect(verdict == .playlist)
      #expect(transport1.isCancelled)
      reader.close()
    }

    #expect(weakReader != nil)
    gate.advance(to: 2)
    let barrierDone = LockedFlag()
    let barrierTask = Task {
      let ok = await gate.waitForClosed(before: 2)
      barrierDone.set(true)
      return ok
    }
    try await Task.sleep(nanoseconds: 20_000_000)
    #expect(!barrierDone.get())

    let closeStart = ProcessInfo.processInfo.systemUptime
    transport1.complete(
      error: .transport(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
    )
    let ready = await barrierTask.value
    let settleMs = (ProcessInfo.processInfo.systemUptime - closeStart) * 1_000.0
    #expect(ready)
    #expect(settleMs >= 25)
    #expect(settleMs < 250)
    try await Task.sleep(nanoseconds: 10_000_000)
    #expect(weakReader == nil)
  }
}

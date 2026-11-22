import ElvAetherCore
import Foundation
import Testing

private func makeTsPackets(count: Int, seed: UInt8 = 0x10) -> Data {
  var data = Data(count: 188 * count)
  for i in 0..<count {
    data[i * 188] = 0x47
    data[i * 188 + 1] = seed &+ UInt8(truncatingIfNeeded: i)
  }
  return data
}

private func readChunk(_ reader: LiveTsReader, maxBytes: Int) -> (Int32, Data) {
  let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: maxBytes)
  defer { buf.deallocate() }
  let n = reader.read(into: buf, size: Int32(maxBytes))
  let out = n > 0 ? Data(bytes: buf, count: Int(n)) : Data()
  return (n, out)
}

@Suite("LiveTsReader")
struct LiveTsReaderTests {
  private let streamUrl = URL(string: "http://127.0.0.1:7878/live/demo/demo/1001.ts")!

  private func makeReader(
    headers: [String: String] = [:],
    generation: Int = 1,
    gate: ConnectionGate,
    maxReconnectsInWindow: Int = 3,
    reconnectWindowSeconds: TimeInterval = 60.0,
    stableStreamingResetSeconds: TimeInterval = 30.0,
    now: @escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
    makeTransport: @escaping @Sendable () -> ByteTransport
  ) -> LiveTsReader {
    LiveTsReader(
      url: streamUrl,
      headers: headers,
      generation: generation,
      gate: gate,
      makeTransport: makeTransport,
      maxReconnectsInWindow: maxReconnectsInWindow,
      reconnectWindowSeconds: reconnectWindowSeconds,
      stableStreamingResetSeconds: stableStreamingResetSeconds,
      now: now
    )
  }

  @Test("a 404 answer fails the open with status 404 and hands nothing to the engine")
  func status404FailsOpenAndClosesGate() async {
    let gate = ConnectionGate()
    let transport = FakeTransport()
    transport.onStart = { t in
      t.sendStatus(404, contentType: "text/plain")
      t.sendData(Data("Not Found".utf8))
      t.complete(error: nil)
    }

    let reader = makeReader(headers: ["User-Agent": "ELVTest"], gate: gate, makeTransport: { transport })

    let verdict = await reader.open()
    #expect(verdict == .failed(.status(404)))
    #expect(reader.lastFailure == .status(404))

    let (n, _) = readChunk(reader, maxBytes: 1_024)
    #expect(n == -1)

    // Gate must already be closed so generation 2 opens without waiting.
    let start = ProcessInfo.processInfo.systemUptime
    let nextOpened = await gate.open(generation: 2, forceClose: {})
    let elapsedMs = (ProcessInfo.processInfo.systemUptime - start) * 1_000.0
    #expect(nextOpened)
    #expect(elapsedMs < 200)
    gate.closed(generation: 2)
  }

  @Test("a notice at 200 fails with notice")
  func noticeAt200FailsWithNotice() async {
    let gate = ConnectionGate()
    let transport = FakeTransport()
    transport.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(Data("Max connections reached".utf8))
      t.complete(error: nil)
    }

    let reader = makeReader(gate: gate, makeTransport: { transport })

    let verdict = await reader.open()
    #expect(verdict == .failed(.notice))
    #expect(reader.lastFailure == .notice)

    let nextOpened = await gate.open(generation: 2, forceClose: {})
    #expect(nextOpened)
    gate.closed(generation: 2)
  }

  @Test("a playlist answer opens as playlist and closes its request")
  func playlistOpensAsPlaylistAndClosesRequest() async {
    let gate = ConnectionGate()
    let transport = FakeTransport()
    transport.onStart = { t in
      t.sendStatus(200, contentType: "application/octet-stream")
      t.sendData(Data("#EXTM3U\n#EXT-X-VERSION:3\n".utf8))
    }

    let reader = makeReader(gate: gate, makeTransport: { transport })

    let verdict = await reader.open()
    #expect(verdict == .playlist)
    #expect(transport.isCancelled)
    #expect(transport.cancelCount >= 1)

    let start = ProcessInfo.processInfo.systemUptime
    let nextOpened = await gate.open(generation: 2, forceClose: {})
    let elapsedMs = (ProcessInfo.processInfo.systemUptime - start) * 1_000.0
    #expect(nextOpened)
    #expect(elapsedMs < 200)
    gate.closed(generation: 2)
  }

  @Test("TS bytes open as mpegts and the sniffed bytes are read first")
  func tsBytesOpenAsMpegtsAndSniffedBytesReadFirst() async {
    let gate = ConnectionGate()
    let initial = makeTsPackets(count: 6, seed: 0x20) // 1,128 bytes (> 1,024 sniff window)
    let followUp = makeTsPackets(count: 2, seed: 0x90) // 376 bytes
    let transport = FakeTransport()
    transport.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(initial)
      t.sendData(followUp)
    }

    let reader = makeReader(headers: ["X-Test": "1"], gate: gate, makeTransport: { transport })

    let verdict = await reader.open()
    #expect(verdict == .media(formatHint: "mpegts"))
    #expect(transport.startedHeaders["X-Test"] == "1")

    var collected = Data()
    let expectedTotal = initial.count + followUp.count
    while collected.count < expectedTotal {
      let (n, chunk) = readChunk(reader, maxBytes: 400)
      #expect(n > 0)
      collected.append(chunk)
    }
    #expect(collected == initial + followUp)

    reader.close()
  }

  @Test("a load during the open hands the old reader to nobody and closes it")
  func loadDuringOpenSupersededAndClosesOldReader() async throws {
    let gate = ConnectionGate()
    let transport1 = FakeTransport()
    let reader1 = makeReader(gate: gate, makeTransport: { transport1 })

    let open1 = Task { await reader1.open() }
    try await Task.sleep(nanoseconds: 30_000_000)
    #expect(transport1.startCount == 1)

    // Simulate stopMedia() on the superseded load followed by generation 2 opening.
    reader1.close()
    #expect(transport1.isCancelled)

    let verdict1 = await open1.value
    #expect(verdict1 == .superseded)

    let transport2 = FakeTransport()
    transport2.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(makeTsPackets(count: 6, seed: 0x33))
    }
    let reader2 = makeReader(generation: 2, gate: gate, makeTransport: { transport2 })
    let verdict2 = await reader2.open()
    #expect(verdict2 == .media(formatHint: "mpegts"))
    reader2.close()
  }

  @Test("a mid-stream drop reconnects once after the dropped request completed")
  func midStreamDropReconnectsOnceAfterCompletion() async {
    let gate = ConnectionGate()
    let part1 = makeTsPackets(count: 6, seed: 0x11)
    let part2 = makeTsPackets(count: 4, seed: 0x55)

    let transport1 = FakeTransport()
    let transport2 = FakeTransport()
    let box = TransportSequence([transport1, transport2])

    transport1.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(part1)
    }
    transport2.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(part2)
    }

    let reader = makeReader(gate: gate, makeTransport: { box.next() })

    let verdict = await reader.open()
    #expect(verdict == .media(formatHint: "mpegts"))
    #expect(box.createdCount == 1)

    let (n1, data1) = readChunk(reader, maxBytes: part1.count)
    #expect(Int(n1) == part1.count)
    #expect(data1 == part1)
    #expect(transport2.startCount == 0)

    // Now transport1 drops and completes; only after completion does transport2 start.
    transport1.complete(error: .transport(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost))
    #expect(box.createdCount == 2)
    #expect(transport2.startCount == 1)

    let (n2, data2) = readChunk(reader, maxBytes: part2.count)
    #expect(Int(n2) == part2.count)
    #expect(data2 == part2)
    #expect(reader.lastFailure == nil)

    reader.close()
  }

  @Test("rapid drops exceeding reconnect budget within the window fail deterministically (#441)")
  func rapidDropsExceedingBudgetFailWithTransportError() async {
    let gate = ConnectionGate()
    let clock = VirtualClock(now: 100.0)
    let part1 = makeTsPackets(count: 6, seed: 0x11)
    let part2 = makeTsPackets(count: 6, seed: 0x22)
    let part3 = makeTsPackets(count: 6, seed: 0x33)
    let part4 = makeTsPackets(count: 6, seed: 0x44)

    let transport1 = FakeTransport()
    let transport2 = FakeTransport()
    let transport3 = FakeTransport()
    let transport4 = FakeTransport()
    let box = TransportSequence([transport1, transport2, transport3, transport4])

    transport1.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(part1)
    }
    transport2.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(part2)
    }
    transport3.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(part3)
    }
    transport4.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(part4)
    }

    let reader = makeReader(
      gate: gate,
      maxReconnectsInWindow: 3,
      reconnectWindowSeconds: 60.0,
      stableStreamingResetSeconds: 30.0,
      now: { clock.current() },
      makeTransport: { box.next() }
    )

    #expect(await reader.open() == .media(formatHint: "mpegts"))
    _ = readChunk(reader, maxBytes: part1.count)

    clock.advance(by: 5.0)
    transport1.complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
    #expect(box.createdCount == 2)
    _ = readChunk(reader, maxBytes: part2.count)

    clock.advance(by: 5.0)
    transport2.complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
    #expect(box.createdCount == 3)
    _ = readChunk(reader, maxBytes: part3.count)

    clock.advance(by: 5.0)
    transport3.complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
    #expect(box.createdCount == 4)
    _ = readChunk(reader, maxBytes: part4.count)

    // 4th drop within 60s window exceeds maxReconnectsInWindow == 3 and terminates cleanly.
    clock.advance(by: 5.0)
    let terminalError = ReaderFailure.transport(domain: NSURLErrorDomain, code: -1001)
    transport4.complete(error: terminalError)

    #expect(box.createdCount == 4)
    let (nEnd, _) = readChunk(reader, maxBytes: 1_024)
    #expect(nEnd == -1)
    #expect(reader.lastFailure == terminalError)

    let nextOpened = await gate.open(generation: 2, forceClose: {})
    #expect(nextOpened)
    gate.closed(generation: 2)
  }

  @Test("2nd, 3rd, and 4th drops after stable streaming windows reconnect cleanly (#441)")
  func dropsAfterStableStreamingWindowResetBudgetAndReconnect() async {
    let gate = ConnectionGate()
    let clock = VirtualClock(now: 500.0)
    let transports = (0..<5).map { _ in FakeTransport() }
    let box = TransportSequence(transports)

    for (index, transport) in transports.enumerated() {
      let seed = UInt8(0x10 + index * 0x10)
      transport.onStart = { t in
        t.sendStatus(200, contentType: "video/mp2t")
        t.sendData(makeTsPackets(count: 6, seed: seed))
      }
    }

    let reader = makeReader(
      gate: gate,
      maxReconnectsInWindow: 2,
      reconnectWindowSeconds: 60.0,
      stableStreamingResetSeconds: 30.0,
      now: { clock.current() },
      makeTransport: { box.next() }
    )

    #expect(await reader.open() == .media(formatHint: "mpegts"))
    _ = readChunk(reader, maxBytes: 188 * 6)

    for idx in 0..<4 {
      // Sustain streaming progress past stableStreamingResetSeconds before each drop.
      clock.advance(by: 31.0)
      let steadyChunk = makeTsPackets(count: 2, seed: UInt8(0xA0 + idx))
      transports[idx].sendData(steadyChunk)
      let (steadyRead, steadyData) = readChunk(reader, maxBytes: steadyChunk.count)
      #expect(Int(steadyRead) == steadyChunk.count)
      #expect(steadyData == steadyChunk)

      clock.advance(by: 1.0)
      transports[idx].complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
      #expect(box.createdCount == idx + 2)
      let (reconnectedRead, _) = readChunk(reader, maxBytes: 188 * 6)
      #expect(reconnectedRead == Int32(188 * 6))
      #expect(reader.lastFailure == nil)
    }

    reader.close()
  }

  @Test("expired reconnect timestamps outside the rolling window are pruned (#441)")
  func expiredReconnectTimestampsPrunedByRollingWindow() async {
    let gate = ConnectionGate()
    let clock = VirtualClock(now: 1_000.0)
    let transports = (0..<4).map { _ in FakeTransport() }
    let box = TransportSequence(transports)

    for (index, transport) in transports.enumerated() {
      let seed = UInt8(0x20 + index * 0x10)
      transport.onStart = { t in
        t.sendStatus(200, contentType: "video/mp2t")
        t.sendData(makeTsPackets(count: 6, seed: seed))
      }
    }

    let reader = makeReader(
      gate: gate,
      maxReconnectsInWindow: 2,
      reconnectWindowSeconds: 60.0,
      stableStreamingResetSeconds: 300.0,
      now: { clock.current() },
      makeTransport: { box.next() }
    )

    #expect(await reader.open() == .media(formatHint: "mpegts"))
    _ = readChunk(reader, maxBytes: 188 * 6)

    // Two drops at t=1010 and t=1020 fill the 2-reconnect budget.
    clock.advance(by: 10.0)
    transports[0].complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
    _ = readChunk(reader, maxBytes: 188 * 6)

    clock.advance(by: 10.0)
    transports[1].complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
    _ = readChunk(reader, maxBytes: 188 * 6)
    #expect(box.createdCount == 3)

    // Advance past t=1010 + 60s so the first reconnect timestamp ages out; 3rd drop reconnects cleanly.
    clock.advance(by: 55.0)
    transports[2].complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
    #expect(box.createdCount == 4)
    let (n, _) = readChunk(reader, maxBytes: 188 * 6)
    #expect(n == Int32(188 * 6))
    #expect(reader.lastFailure == nil)

    reader.close()
  }

  @Test("reconnect timestamp at exact 60.0 s window boundary is pruned cleanly (#441)")
  func exactWindowBoundaryTimestampIsPruned() async {
    let gate = ConnectionGate()
    let clock = VirtualClock(now: 2_000.0)
    let transports = (0..<3).map { _ in FakeTransport() }
    let box = TransportSequence(transports)

    for (index, transport) in transports.enumerated() {
      let seed = UInt8(0x40 + index * 0x10)
      transport.onStart = { t in
        t.sendStatus(200, contentType: "video/mp2t")
        t.sendData(makeTsPackets(count: 6, seed: seed))
      }
    }

    let reader = makeReader(
      gate: gate,
      maxReconnectsInWindow: 1,
      reconnectWindowSeconds: 60.0,
      stableStreamingResetSeconds: 300.0,
      now: { clock.current() },
      makeTransport: { box.next() }
    )

    #expect(await reader.open() == .media(formatHint: "mpegts"))
    _ = readChunk(reader, maxBytes: 188 * 6)

    // First drop at t=2000 fills the 1-reconnect window budget.
    transports[0].complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
    #expect(box.createdCount == 2)
    _ = readChunk(reader, maxBytes: 188 * 6)

    // Second drop at exact boundary t=2060.0 (2060.0 - 2000.0 == 60.0) prunes the expired entry and reconnects.
    clock.advance(by: 60.0)
    transports[1].complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
    #expect(box.createdCount == 3)
    let (n, _) = readChunk(reader, maxBytes: 188 * 6)
    #expect(n == Int32(188 * 6))
    #expect(reader.lastFailure == nil)

    reader.close()
  }

  @Test("MPEG-TS bytes labelled as mpegurl open as mpegts after sniffing")
  func tsBytesWithMpegurlContentTypeOpenAsMpegts() async {
    let gate = ConnectionGate()
    let packets = makeTsPackets(count: 6, seed: 0x31)
    let transport = FakeTransport()
    transport.onStart = { t in
      t.sendStatus(200, contentType: "application/vnd.apple.mpegurl")
      t.sendData(packets)
    }
    let reader = makeReader(gate: gate, makeTransport: { transport })
    #expect(await reader.open() == .media(formatHint: "mpegts"))
    #expect(!transport.isCancelled)
    let (n, chunk) = readChunk(reader, maxBytes: packets.count)
    #expect(Int(n) == packets.count && chunk == packets)
    reader.close()
  }
}

private final class TransportSequence: @unchecked Sendable {
  private let lock = NSLock()
  private let items: [FakeTransport]
  private var index = 0

  init(_ items: [FakeTransport]) {
    self.items = items
  }

  var createdCount: Int {
    lock.withLock { index }
  }

  func next() -> FakeTransport {
    lock.withLock {
      let item = items[min(index, items.count - 1)]
      index += 1
      return item
    }
  }
}

private final class VirtualClock: @unchecked Sendable {
  private let lock = NSLock()
  private var nowSeconds: TimeInterval

  init(now: TimeInterval) {
    self.nowSeconds = now
  }

  func current() -> TimeInterval {
    lock.withLock { nowSeconds }
  }

  func advance(by delta: TimeInterval) {
    lock.withLock { nowSeconds += delta }
  }
}

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

  @Test("a 404 answer fails the open with status 404 and hands nothing to the engine")
  func status404FailsOpenAndClosesGate() async {
    let gate = ConnectionGate()
    let transport = FakeTransport()
    transport.onStart = { t in
      t.sendStatus(404, contentType: "text/plain")
      t.sendData(Data("Not Found".utf8))
      t.complete(error: nil)
    }

    let reader = LiveTsReader(
      url: streamUrl,
      headers: ["User-Agent": "ELVTest"],
      generation: 1,
      gate: gate,
      makeTransport: { transport }
    )

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

    let reader = LiveTsReader(
      url: streamUrl,
      headers: [:],
      generation: 1,
      gate: gate,
      makeTransport: { transport }
    )

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

    let reader = LiveTsReader(
      url: streamUrl,
      headers: [:],
      generation: 1,
      gate: gate,
      makeTransport: { transport }
    )

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

    let reader = LiveTsReader(
      url: streamUrl,
      headers: ["X-Test": "1"],
      generation: 1,
      gate: gate,
      makeTransport: { transport }
    )

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
    let reader1 = LiveTsReader(
      url: streamUrl,
      headers: [:],
      generation: 1,
      gate: gate,
      makeTransport: { transport1 }
    )

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
    let reader2 = LiveTsReader(
      url: streamUrl,
      headers: [:],
      generation: 2,
      gate: gate,
      makeTransport: { transport2 }
    )
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

    let reader = LiveTsReader(
      url: streamUrl,
      headers: [:],
      generation: 1,
      gate: gate,
      makeTransport: { box.next() }
    )

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

  @Test("a second drop fails with the transport error")
  func secondDropFailsWithTransportError() async {
    let gate = ConnectionGate()
    let part1 = makeTsPackets(count: 6, seed: 0x11)
    let part2 = makeTsPackets(count: 3, seed: 0x22)

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

    let reader = LiveTsReader(
      url: streamUrl,
      headers: [:],
      generation: 1,
      gate: gate,
      makeTransport: { box.next() }
    )

    #expect(await reader.open() == .media(formatHint: "mpegts"))
    _ = readChunk(reader, maxBytes: part1.count)

    transport1.complete(error: .transport(domain: NSURLErrorDomain, code: -1005))
    _ = readChunk(reader, maxBytes: part2.count)

    let secondError = ReaderFailure.transport(domain: NSURLErrorDomain, code: -1001)
    transport2.complete(error: secondError)

    #expect(box.createdCount == 2)
    let (nEnd, _) = readChunk(reader, maxBytes: 1_024)
    #expect(nEnd == -1)
    #expect(reader.lastFailure == secondError)

    let nextOpened = await gate.open(generation: 2, forceClose: {})
    #expect(nextOpened)
    gate.closed(generation: 2)
  }

  @Test("close reports the connection closed to the gate and cancel wakes parked reads immediately")
  func closeReportsClosedToGateAndCancelWakesReads() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 1_000)
    let transport = FakeTransport()
    transport.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(makeTsPackets(count: 6, seed: 0x77))
    }

    let reader = LiveTsReader(
      url: streamUrl,
      headers: [:],
      generation: 1,
      gate: gate,
      makeTransport: { transport }
    )

    #expect(await reader.open() == .media(formatHint: "mpegts"))
    _ = readChunk(reader, maxBytes: 2_048)

    let parkedRead = Task.detached { () -> Int32 in
      readChunk(reader, maxBytes: 512).0
    }
    try await Task.sleep(nanoseconds: 30_000_000)

    reader.cancel()
    #expect(await parkedRead.value == -1)
    #expect(transport.isCancelled)

    reader.close()

    let start = ProcessInfo.processInfo.systemUptime
    let nextOpened = await gate.open(generation: 2, forceClose: {})
    let elapsedMs = (ProcessInfo.processInfo.systemUptime - start) * 1_000.0
    #expect(nextOpened)
    #expect(elapsedMs < 200)
    gate.closed(generation: 2)
  }

  @Test("a reader failure wins over the engine kind")
  @MainActor
  func readerFailureWinsOverEngineKind() {
    let backend = FakeBackend()
    let sink = RecordingSink()
    let clock = FakeClock()
    let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })

    core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 9)
    sink.events.removeAll()

    core.observe(.readerFault(.status(509)), serial: 1)
    core.observe(
      .failure(.engine(kind: "customSourceProbeFailed", underlyingDomain: nil, underlyingCode: nil)),
      serial: 1
    )

    #expect(sink.events.count == 1)
    if case let .error(attempt, mapped) = sink.events.first {
      #expect(attempt == 9)
      #expect(mapped.code == "http-509")
      #expect(mapped.httpStatus == 509)
    } else {
      Issue.record("expected reader status 509 to win over engine customSourceProbeFailed")
    }
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

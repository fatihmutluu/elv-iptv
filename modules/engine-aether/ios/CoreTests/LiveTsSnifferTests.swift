import ElvAetherCore
import Foundation
import Testing

private func makeSnifferTsPackets(count: Int, seed: UInt8 = 0x20) -> Data {
  var data = Data(count: 188 * count)
  for i in 0..<count {
    data[i * 188] = 0x47
    data[i * 188 + 1] = seed &+ UInt8(truncatingIfNeeded: i)
  }
  return data
}

private func readReaderBytes(_ reader: LiveTsReader, maxBytes: Int) -> (Int32, Data) {
  let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: maxBytes)
  defer { buf.deallocate() }
  let n = reader.read(into: buf, size: Int32(maxBytes))
  let out = n > 0 ? Data(bytes: buf, count: Int(n)) : Data()
  return (n, out)
}

private final class SniffTransportBox: @unchecked Sendable {
  private let lock = NSLock()
  private let items: [FakeTransport]
  private var index = 0

  init(_ items: [FakeTransport]) {
    self.items = items
  }

  func next() -> FakeTransport {
    lock.withLock {
      let item = items[min(index, items.count - 1)]
      index += 1
      return item
    }
  }
}

@Suite("LiveTsSniffer & Reconnect Sniffing")
struct LiveTsSnifferTests {
  private let streamUrl = URL(string: "http://127.0.0.1:7878/live/demo/demo/1001.ts")!

  @Test("mid-stream reconnect that answers 200 OK with an HTML/UTF-8 notice fails as notice without corrupting FIFO")
  func reconnect200NoticeFailsAsNotice() async {
    let gate = ConnectionGate()
    let part1 = makeSnifferTsPackets(count: 6, seed: 0x10)

    let transport1 = FakeTransport()
    let transport2 = FakeTransport()
    let box = SniffTransportBox([transport1, transport2])

    transport1.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(part1)
    }
    transport2.onStart = { t in
      t.sendStatus(200, contentType: "text/html")
      t.sendData(Data("<html><body>Max connections reached</body></html>".utf8))
      t.complete(error: nil)
    }

    let reader = LiveTsReader(
      url: streamUrl,
      headers: [:],
      generation: 1,
      gate: gate,
      makeTransport: { box.next() }
    )

    #expect(await reader.open() == .media(formatHint: "mpegts"))
    let (n1, data1) = readReaderBytes(reader, maxBytes: part1.count)
    #expect(Int(n1) == part1.count && data1 == part1)

    // Drop transport1 -> triggers reconnect onto transport2 which returns a 200 HTML notice.
    transport1.complete(error: .transport(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost))

    // Zero HTML bytes may leak into ByteFifo; read must fail with -1 and lastFailure == .notice!
    let (n2, data2) = readReaderBytes(reader, maxBytes: 1_024)
    #expect(n2 == -1)
    #expect(data2.isEmpty)
    #expect(reader.lastFailure == .notice)

    reader.close()
  }

  @Test("mid-stream reconnect delivering >= 1,024 B HTML notice without EOF cancels immediately as notice")
  func reconnectLongHtmlNoticeCancelsWithoutWaitingForEof() async {
    let gate = ConnectionGate()
    let part1 = makeSnifferTsPackets(count: 6, seed: 0x15)
    let longNotice = Data(String(repeating: "<p>Connection limit exceeded</p>", count: 40).utf8)

    let transport1 = FakeTransport()
    let transport2 = FakeTransport()
    let box = SniffTransportBox([transport1, transport2])

    transport1.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(part1)
    }
    transport2.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(longNotice)
    }

    let reader = LiveTsReader(
      url: streamUrl,
      headers: [:],
      generation: 1,
      gate: gate,
      makeTransport: { box.next() }
    )

    #expect(await reader.open() == .media(formatHint: "mpegts"))
    _ = readReaderBytes(reader, maxBytes: part1.count)

    transport1.complete(error: .transport(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost))

    #expect(transport2.isCancelled)
    #expect(reader.lastFailure == .notice)
    #expect(readReaderBytes(reader, maxBytes: 512).0 == -1)
    reader.close()
  }

  @Test("arriving >= 1,024 TS bytes before handleStatus drains all buffered bytes into FIFO without loss")
  func dataBeforeStatusDrainsAllSniffedBytes() async {
    let gate = ConnectionGate()
    let initial = makeSnifferTsPackets(count: 6, seed: 0x44)
    let transport = FakeTransport()
    transport.onStart = { t in
      t.sendData(initial)
      t.sendStatus(200, contentType: "video/mp2t")
    }

    let reader = LiveTsReader(url: streamUrl, headers: [:], generation: 1, gate: gate, makeTransport: { transport })
    #expect(await reader.open() == .media(formatHint: "mpegts"))

    let (n, data) = readReaderBytes(reader, maxBytes: initial.count + 256)
    #expect(Int(n) == initial.count)
    #expect(data == initial)
    reader.close()
  }

  @Test("MPEG-TS bytes labelled as text/html open as mpegts and survive a single-drop reconnect")
  func tsBytesWithHtmlContentTypeOpenAndReconnect() async {
    let gate = ConnectionGate()
    let part1 = makeSnifferTsPackets(count: 6, seed: 0x41)
    let part2 = makeSnifferTsPackets(count: 4, seed: 0x52)
    let transport1 = FakeTransport()
    let transport2 = FakeTransport()
    let box = SniffTransportBox([transport1, transport2])
    transport1.onStart = { t in
      t.sendStatus(200, contentType: "text/html; charset=utf-8")
      t.sendData(part1)
    }
    transport2.onStart = { t in
      t.sendStatus(200, contentType: "text/html")
      t.sendData(part2)
    }

    let reader = LiveTsReader(url: streamUrl, headers: [:], generation: 1, gate: gate, makeTransport: { box.next() })
    #expect(await reader.open() == .media(formatHint: "mpegts"))
    let (n1, data1) = readReaderBytes(reader, maxBytes: part1.count)
    #expect(Int(n1) == part1.count && data1 == part1)

    transport1.complete(error: .transport(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost))
    let (n2, data2) = readReaderBytes(reader, maxBytes: part2.count)
    #expect(Int(n2) == part2.count && data2 == part2)
    #expect(reader.lastFailure == nil)
    reader.close()
  }

  @Test("an empty 200 answer fails with notice on a notice label and transport EOF otherwise")
  func empty200FailsWithNoticeOrTransportEof() async {
    let gate = ConnectionGate()
    let htmlTransport = FakeTransport()
    htmlTransport.onStart = { t in
      t.sendStatus(200, contentType: "text/html")
      t.complete(error: nil)
    }
    let htmlReader = LiveTsReader(url: streamUrl, headers: [:], generation: 1, gate: gate, makeTransport: { htmlTransport })
    #expect(await htmlReader.open() == .failed(.notice))
    #expect(htmlReader.lastFailure == .notice)

    let tsTransport = FakeTransport()
    tsTransport.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.complete(error: nil)
    }
    let tsReader = LiveTsReader(url: streamUrl, headers: [:], generation: 2, gate: gate, makeTransport: { tsTransport })
    let expectedEof = ReaderFailure.transport(domain: NSURLErrorDomain, code: NSURLErrorZeroByteResource)
    #expect(await tsReader.open() == .failed(expectedEof))
    #expect(tsReader.lastFailure == expectedEof)
  }

  @Test("close reports connection closed to gate, cancel wakes parked reads, and reader fault wins over engine kind")
  func closeCancelAndReaderFaultPrecedence() async throws {
    let gate = ConnectionGate(forceCloseAfterMs: 1_000)
    let transport = FakeTransport()
    transport.onStart = { t in
      t.sendStatus(200, contentType: "video/mp2t")
      t.sendData(makeSnifferTsPackets(count: 6, seed: 0x77))
    }

    let reader = LiveTsReader(url: streamUrl, headers: [:], generation: 1, gate: gate, makeTransport: { transport })
    #expect(await reader.open() == .media(formatHint: "mpegts"))
    _ = readReaderBytes(reader, maxBytes: 2_048)

    let parkedRead = await BlockingCall.start(label: "elv.test.reader.parked") { () -> Int32 in
      readReaderBytes(reader, maxBytes: 512).0
    }
    try await Task.sleep(nanoseconds: 30_000_000)

    reader.cancel()
    #expect(await parkedRead.value() == -1)
    #expect(transport.isCancelled)

    reader.close()
    #expect(await gate.open(generation: 2, forceClose: {}))
    gate.closed(generation: 2)

    await MainActor.run {
      let backend = FakeBackend()
      let sink = RecordingSink()
      let clock = FakeClock()
      let core = EngineCore(backend: backend, sink: sink, uptimeMs: { clock.uptimeMs() })
      core.load(LoadRequest(url: "http://h:7878/live/demo/demo/1001.ts"), attempt: 9)
      sink.events.removeAll()
      core.observe(.readerFault(.status(509)), serial: 1)
      core.observe(.failure(.engine(kind: "customSourceProbeFailed", underlyingDomain: nil, underlyingCode: nil)), serial: 1)
      #expect(sink.events == [.error(attempt: 9, error: MappedError(code: "http-509", httpStatus: 509, detail: "status:509 http://h:7878/***/***/***/***.ts"))])
    }
  }
}

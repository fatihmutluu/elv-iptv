import ElvAetherCore
import Foundation
import Testing

@Suite("ByteFifo")
struct ByteFifoTests {
  @Test("a read returns the bytes available without waiting for the full size")
  func partialReadReturnsAvailableBytesImmediately() {
    let fifo = ByteFifo()
    let written = Data((0..<100).map { UInt8($0) })
    fifo.write(written)

    let requested = 262_144
    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: requested)
    defer { buf.deallocate() }

    let n = fifo.read(into: buf, size: Int32(requested))
    #expect(n == 100)
    #expect(Data(bytes: buf, count: Int(n)) == written)
  }

  @Test("a read parks until bytes, the end or cancel")
  func readParksUntilBytesArrive() async throws {
    let fifo = ByteFifo()
    let expected = Data("hello-live-ts".utf8)

    let readerCall = await BlockingCall.start(label: "elv.test.fifo.read") { () -> Data? in
      let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 1_024)
      defer { buf.deallocate() }
      let n = fifo.read(into: buf, size: 1_024)
      guard n > 0 else { return nil }
      return Data(bytes: buf, count: Int(n))
    }

    try await Task.sleep(nanoseconds: 30_000_000)
    fifo.write(expected)

    let got = await readerCall.value()
    #expect(got == expected)
  }

  @Test("cancel wakes a parked read with -1")
  func cancelWakesParkedReadWithMinusOne() async throws {
    let fifo = ByteFifo()

    let readerCall = await BlockingCall.start(label: "elv.test.fifo.cancel") { () -> Int32 in
      let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
      defer { buf.deallocate() }
      return fifo.read(into: buf, size: 64)
    }

    try await Task.sleep(nanoseconds: 30_000_000)
    fifo.cancel()

    let n = await readerCall.value()
    #expect(n == -1)

    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
    defer { buf.deallocate() }
    #expect(fifo.read(into: buf, size: 64) == -1)
  }

  @Test("the end reads 0 after the last byte")
  func endReadsZeroAfterLastByte() {
    let fifo = ByteFifo()
    let payload = Data([10, 20, 30, 40, 50])
    fifo.write(payload)
    fifo.finish(nil)

    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
    defer { buf.deallocate() }

    let first = fifo.read(into: buf, size: 64)
    #expect(first == 5)
    #expect(Data(bytes: buf, count: Int(first)) == payload)

    let second = fifo.read(into: buf, size: 64)
    #expect(second == 0)
  }

  @Test("suspends the transport above 8 MiB and resumes below 4 MiB")
  func suspendsAboveEightMibAndResumesBelowFourMib() {
    let transport = FakeTransport()
    let fifo = ByteFifo(transport: transport)
    let oneMib = Data(count: 1_024 * 1_024)

    for _ in 0..<8 {
      fifo.write(oneMib)
    }
    #expect(!transport.isSuspended)
    #expect(transport.suspendCount == 0)

    fifo.write(Data([0x47]))
    #expect(transport.isSuspended)
    #expect(transport.suspendCount == 1)

    let drainChunk = 1_024 * 1_024
    let buf = UnsafeMutablePointer<UInt8>.allocate(capacity: drainChunk)
    defer { buf.deallocate() }

    for _ in 0..<4 {
      let n = fifo.read(into: buf, size: Int32(drainChunk))
      #expect(n == Int32(drainChunk))
    }
    // Still 4 MiB + 1 byte queued (>= 4 MiB), so transport remains suspended.
    #expect(transport.isSuspended)
    #expect(transport.resumeCount == 0)

    // Draining 2 more bytes drops queued bytes to 4 MiB - 1 (< 4 MiB), resuming transport.
    let small = fifo.read(into: buf, size: 2)
    #expect(small == 2)
    #expect(!transport.isSuspended)
    #expect(transport.resumeCount == 1)
  }
}

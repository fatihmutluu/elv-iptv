import Foundation

/// Bounded-backpressure byte queue returning partial reads immediately for forward-only live streams.
public final class ByteFifo: @unchecked Sendable {
  public static let defaultHighWaterBytes = 8 * 1_024 * 1_024
  public static let defaultLowWaterBytes = 4 * 1_024 * 1_024

  private let condition = NSCondition()
  private let highWaterBytes: Int
  private let lowWaterBytes: Int

  private var chunks: [Data] = []
  private var headIndex = 0
  private var headOffset = 0
  private var queuedBytes = 0

  private var eof = false
  private var terminalFailure: ReaderFailure?
  private var isCancelled = false
  private var isBackpressured = false
  private var attachedTransport: ByteTransport?

  public init(
    transport: ByteTransport? = nil,
    highWaterBytes: Int = ByteFifo.defaultHighWaterBytes,
    lowWaterBytes: Int = ByteFifo.defaultLowWaterBytes
  ) {
    self.attachedTransport = transport
    self.highWaterBytes = highWaterBytes
    self.lowWaterBytes = lowWaterBytes
  }

  /// Updates the active transport receiving high/low-water `suspend()` and `resume()` signals.
  public func attachTransport(_ transport: ByteTransport?) {
    var shouldSuspend: ByteTransport?
    condition.lock()
    attachedTransport = transport
    if isBackpressured, !isCancelled, !eof, terminalFailure == nil {
      shouldSuspend = transport
    }
    condition.unlock()
    shouldSuspend?.suspend()
  }

  /// Appends `data` to the queue, waking any parked reader and suspending the transport above 8 MiB.
  public func write(_ data: Data) {
    guard !data.isEmpty else { return }
    var transportToSuspend: ByteTransport?

    condition.lock()
    if isCancelled || eof || terminalFailure != nil {
      condition.unlock()
      return
    }
    chunks.append(data)
    queuedBytes += data.count
    if !isBackpressured && queuedBytes > highWaterBytes {
      isBackpressured = true
      transportToSuspend = attachedTransport
    }
    condition.broadcast()
    condition.unlock()

    transportToSuspend?.suspend()
  }

  /// Marks the end of the byte stream (`nil` for clean EOF, or a `ReaderFailure`).
  public func finish(_ failure: ReaderFailure?) {
    condition.lock()
    if !isCancelled && !eof && terminalFailure == nil {
      attachedTransport = nil
      if let failure {
        terminalFailure = failure
      } else {
        eof = true
      }
      condition.broadcast()
    }
    condition.unlock()
  }

  /// Reads up to `size` bytes into `buffer`, returning immediately once `>= 1` byte is queued, `0` on EOF, or `-1` on cancel/error.
  public func read(into buffer: UnsafeMutablePointer<UInt8>, size: Int32) -> Int32 {
    guard size > 0 else { return 0 }
    var transportToResume: ByteTransport?
    var copiedTotal = 0

    condition.lock()
    while !isCancelled && queuedBytes == 0 && !eof && terminalFailure == nil {
      condition.wait()
    }

    if isCancelled {
      condition.unlock()
      return -1
    }

    if queuedBytes > 0 {
      let target = min(Int(size), queuedBytes)
      while copiedTotal < target && headIndex < chunks.count {
        let chunk = chunks[headIndex]
        let available = chunk.count - headOffset
        let take = min(target - copiedTotal, available)
        chunk.withUnsafeBytes { raw in
          guard let base = raw.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
          buffer.advanced(by: copiedTotal).update(from: base.advanced(by: headOffset), count: take)
        }
        copiedTotal += take
        headOffset += take
        queuedBytes -= take
        if headOffset >= chunk.count {
          chunks[headIndex] = Data()
          headIndex += 1
          headOffset = 0
        }
      }
      if headIndex >= chunks.count {
        chunks.removeAll(keepingCapacity: true)
        headIndex = 0
        headOffset = 0
      } else if headIndex >= 32 {
        chunks.removeFirst(headIndex)
        headIndex = 0
      }
      if isBackpressured && queuedBytes < lowWaterBytes {
        isBackpressured = false
        transportToResume = attachedTransport
      }
      condition.unlock()
      transportToResume?.resume()
      return Int32(copiedTotal)
    }

    let failed = terminalFailure != nil
    condition.unlock()
    return failed ? -1 : 0
  }

  /// Permanently cancels the queue, releases any attached transport, and wakes parked `read`s with `-1`.
  public func cancel() {
    condition.lock()
    attachedTransport = nil
    isBackpressured = false
    if !isCancelled {
      isCancelled = true
      chunks.removeAll(keepingCapacity: false)
      headIndex = 0
      headOffset = 0
      queuedBytes = 0
      condition.broadcast()
    }
    condition.unlock()
  }
}

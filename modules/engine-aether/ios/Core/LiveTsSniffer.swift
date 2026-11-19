import Foundation

/// Shared 1,024-byte progressive response sniffer used on both initial `LiveTsReader.open()` and mid-stream reconnects.
public struct LiveTsSniffer: Sendable {
  public enum Decision: Equatable, Sendable {
    case needMore
    case media(formatHint: String?, initialBytes: Data)
    case playlist
    case failed(ReaderFailure)
  }

  private var status: Int?
  private var contentType: String?
  private var buffer = Data()
  public private(set) var settled = false

  public init() {}

  public mutating func reset() {
    status = nil
    contentType = nil
    buffer.removeAll(keepingCapacity: false)
    settled = false
  }

  public mutating func onStatus(_ httpStatus: Int, contentType: String?) -> Decision {
    guard !settled else { return .needMore }
    self.status = httpStatus
    self.contentType = contentType
    guard (200...299).contains(httpStatus) else {
      settled = true
      buffer.removeAll(keepingCapacity: false)
      return .failed(.status(httpStatus))
    }
    return evaluateIfReady(completed: false, completedError: nil)
  }

  public mutating func onData(_ data: Data) -> Decision {
    guard !data.isEmpty, !settled else { return .needMore }
    buffer.append(data)
    return evaluateIfReady(completed: false, completedError: nil)
  }

  public mutating func onComplete(error: ReaderFailure?) -> Decision {
    guard !settled else { return .needMore }
    if let error, status == nil || buffer.isEmpty {
      settled = true
      buffer.removeAll(keepingCapacity: false)
      return .failed(error)
    }
    return evaluateIfReady(completed: true, completedError: error)
  }

  private mutating func evaluateIfReady(
    completed: Bool,
    completedError: ReaderFailure?
  ) -> Decision {
    guard status != nil else { return .needMore }

    if hasExtM3uSignature(buffer) {
      settled = true
      buffer.removeAll(keepingCapacity: false)
      return .playlist
    }

    // Three 188-byte MPEG-TS sync bytes prove mpegts media immediately without waiting for 1,024 bytes.
    if hasMpegTsSync(buffer) {
      settled = true
      let drained = drainBuffer()
      return .media(formatHint: "mpegts", initialBytes: drained)
    }

    guard completed || buffer.count >= sniffBytes else {
      return .needMore
    }

    settled = true
    let verdict = classifyProgressive(
      contentType: contentType,
      prefix: Data(buffer.prefix(sniffBytes))
    )
    switch verdict {
    case .playlist:
      buffer.removeAll(keepingCapacity: false)
      return .playlist
    case .notice:
      buffer.removeAll(keepingCapacity: false)
      return .failed(.notice)
    case let .media(hint):
      if buffer.isEmpty {
        let failure: ReaderFailure = isProgressiveNoticeContentType(contentType)
          ? .notice
          : (completedError ?? .transport(domain: NSURLErrorDomain, code: NSURLErrorZeroByteResource))
        return .failed(failure)
      }
      let drained = drainBuffer()
      return .media(formatHint: hint, initialBytes: drained)
    }
  }

  private mutating func drainBuffer() -> Data {
    let out = buffer
    buffer.removeAll(keepingCapacity: false)
    return out
  }
}

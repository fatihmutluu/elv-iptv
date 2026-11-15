import ElvAetherCore
import Foundation

final class FakeTransport: ByteTransport, @unchecked Sendable {
  private let lock = NSLock()
  private var delegate: ByteTransportDelegate?

  private(set) var startedUrl: URL?
  private(set) var startedHeaders: [String: String] = [:]
  private(set) var startCount = 0
  private(set) var cancelCount = 0
  private(set) var suspendCount = 0
  private(set) var resumeCount = 0
  private(set) var isCancelled = false
  private(set) var isSuspended = false
  private var didComplete = false

  var completeOnCancel = true
  var onStart: (@Sendable (FakeTransport) -> Void)?
  var onCancel: (@Sendable (FakeTransport) -> Void)?

  func start(url: URL, headers: [String: String], delegate: ByteTransportDelegate) {
    let hook: (@Sendable (FakeTransport) -> Void)? = lock.withLock {
      self.startedUrl = url
      self.startedHeaders = headers
      self.delegate = delegate
      self.startCount += 1
      return self.onStart
    }
    hook?(self)
  }

  func cancel() {
    let outcome: (hook: (@Sendable (FakeTransport) -> Void)?, del: ByteTransportDelegate?) = lock.withLock {
      self.cancelCount += 1
      self.isCancelled = true
      let shouldComplete = self.completeOnCancel && !self.didComplete
      if shouldComplete {
        self.didComplete = true
      }
      return (self.onCancel, shouldComplete ? self.delegate : nil)
    }
    outcome.hook?(self)
    outcome.del?.transportDidComplete(
      error: .transport(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
    )
  }

  func suspend() {
    lock.withLock {
      self.suspendCount += 1
      self.isSuspended = true
    }
  }

  func resume() {
    lock.withLock {
      self.resumeCount += 1
      self.isSuspended = false
    }
  }

  func sendStatus(_ status: Int, contentType: String? = nil) {
    let del: ByteTransportDelegate? = lock.withLock {
      guard !self.didComplete else { return nil }
      return self.delegate
    }
    del?.transportDidReceive(status: status, contentType: contentType)
  }

  func sendData(_ data: Data) {
    let del: ByteTransportDelegate? = lock.withLock {
      guard !self.didComplete else { return nil }
      return self.delegate
    }
    del?.transportDidReceive(data)
  }

  func complete(error: ReaderFailure? = nil) {
    let del: ByteTransportDelegate? = lock.withLock {
      guard !self.didComplete else { return nil }
      self.didComplete = true
      return self.delegate
    }
    del?.transportDidComplete(error: error)
  }
}

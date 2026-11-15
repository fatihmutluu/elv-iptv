import ElvAetherCore
import Foundation
import Testing

private final class MockHttpTask: HttpTaskControlling, @unchecked Sendable {
  let taskIdentifier: Int
  private let lock = NSLock()
  /// Mirrors NSURLSessionTask: created suspended (balance = 1); initial `resume()` brings balance to 0.
  private var suspendBalance = 1
  private(set) var resumeCalls = 0
  private(set) var suspendCalls = 0
  private(set) var cancelCalls = 0
  private(set) var minObservedBalance = 1
  private(set) var maxObservedBalance = 1
  var onSuspendEntered: (@Sendable () -> Void)?

  init(taskIdentifier: Int = 1) {
    self.taskIdentifier = taskIdentifier
  }

  var currentSuspendBalance: Int {
    lock.withLock { suspendBalance }
  }

  func resume() {
    lock.withLock {
      resumeCalls += 1
      suspendBalance -= 1
      minObservedBalance = min(minObservedBalance, suspendBalance)
    }
  }

  func suspend() {
    let hook = lock.withLock { onSuspendEntered }
    hook?()
    lock.withLock {
      suspendCalls += 1
      suspendBalance += 1
      maxObservedBalance = max(maxObservedBalance, suspendBalance)
    }
  }

  func cancel() {
    lock.withLock {
      cancelCalls += 1
    }
  }
}

private final class MockHttpSession: HttpTaskSession, @unchecked Sendable {
  private let lock = NSLock()
  private var nextId = 1
  private(set) var tasks: [MockHttpTask] = []
  var onMakeTask: (@Sendable (MockHttpTask) -> Void)?

  func makeDataTask(
    for request: URLRequest,
    origin: StreamOrigin?,
    transport: URLSessionTransport
  ) -> HttpTaskControlling? {
    let task: MockHttpTask = lock.withLock {
      let t = MockHttpTask(taskIdentifier: nextId)
      nextId += 1
      tasks.append(t)
      return t
    }
    onMakeTask?(task)
    return task
  }

  func unregister(taskId: Int) {}
}

private final class NoopTransportDelegate: ByteTransportDelegate, @unchecked Sendable {
  func transportDidReceive(status: Int, contentType: String?) {}
  func transportDidReceive(_ data: Data) {}
  func transportDidComplete(error: ReaderFailure?) {}
}

@Suite("URLSessionTransport")
struct URLSessionTransportTests {
  private let streamUrl = URL(string: "http://127.0.0.1:7878/live/demo/demo/1001.ts")!

  @Test("suspend() called before start() launches the URLSession task in suspended state until resume()")
  func preStartSuspendStartsTaskSuspended() {
    let session = MockHttpSession()
    let transport = URLSessionTransport(session: session)
    let delegate = NoopTransportDelegate()

    // Exact sequence when ByteFifo (> 8 MiB) attaches a reconnect transport before start():
    transport.suspend()
    transport.start(url: streamUrl, headers: [:], delegate: delegate)

    let task = session.tasks[0]
    #expect(task.resumeCalls == 1)
    #expect(task.suspendCalls == 1)
    #expect(task.currentSuspendBalance == 1)

    transport.resume()
    #expect(task.resumeCalls == 2)
    #expect(task.currentSuspendBalance == 0)

    transport.cancel()
    #expect(task.cancelCalls == 1)
    #expect(task.currentSuspendBalance == 0)
  }

  @Test("concurrent resume() while suspend() is in progress cannot invert task suspend order")
  func concurrentSuspendAndResumeSerializeUnderLock() async throws {
    let session = MockHttpSession()
    let transport = URLSessionTransport(session: session)
    let delegate = NoopTransportDelegate()
    transport.start(url: streamUrl, headers: [:], delegate: delegate)

    let task = session.tasks[0]
    #expect(task.currentSuspendBalance == 0)

    let resumeFinished = NSLock()
    var didFinishResume = false

    // When suspend() enters MockHttpTask.suspend(), spawn a racing thread calling transport.resume().
    // If suspend() released URLSessionTransport's lock before calling task.suspend(), resume() runs first
    // (dropping balance to -1!) and suspend() runs second (leaving balance stuck at 0 or deadlocked at 1).
    // With task.suspend() / task.resume() inside URLSessionTransport's lock, resume() blocks until suspend() finishes.
    task.onSuspendEntered = {
      let waiter = DispatchSemaphore(value: 0)
      DispatchQueue.global().async {
        waiter.signal()
        transport.resume()
        resumeFinished.withLock { didFinishResume = true }
      }
      waiter.wait()
      Thread.sleep(forTimeInterval: 0.02)
    }

    transport.suspend()
    for _ in 0..<50 {
      if resumeFinished.withLock({ didFinishResume }) { break }
      try await Task.sleep(nanoseconds: 2_000_000)
    }

    #expect(resumeFinished.withLock { didFinishResume })
    #expect(task.minObservedBalance >= 0)
    #expect(task.maxObservedBalance <= 1)
    #expect(task.currentSuspendBalance == 0)
  }

  @Test("cancel() while suspended balances task suspend count back to zero")
  func cancelWhileSuspendedBalancesTask() {
    let session = MockHttpSession()
    let transport = URLSessionTransport(session: session)
    let delegate = NoopTransportDelegate()

    transport.start(url: streamUrl, headers: [:], delegate: delegate)
    let task = session.tasks[0]
    transport.suspend()
    #expect(task.currentSuspendBalance == 1)

    transport.cancel()
    #expect(task.cancelCalls == 1)
    #expect(task.currentSuspendBalance == 0)
  }

  @Test("real EngineHttpSession completes cleanly when suspended task is cancelled or invalidated")
  func realUrlSessionHandlesSuspendedCancelAndDispose() async throws {
    final class CompletionRecorder: ByteTransportDelegate, @unchecked Sendable {
      private let lock = NSLock()
      private var continuation: CheckedContinuation<ReaderFailure?, Never>?
      private var completed: ReaderFailure??

      func transportDidReceive(status: Int, contentType: String?) {}
      func transportDidReceive(_ data: Data) {}
      func transportDidComplete(error: ReaderFailure?) {
        let cont: CheckedContinuation<ReaderFailure?, Never>? = lock.withLock {
          if let c = continuation {
            continuation = nil
            return c
          }
          completed = .some(error)
          return nil
        }
        cont?.resume(returning: error)
      }

      func wait(timeoutMs: UInt64 = 2_000) async -> ReaderFailure?? {
        await withTaskGroup(of: ReaderFailure??.self) { group in
          group.addTask {
            let err = await withCheckedContinuation { cont in
              let ready: ReaderFailure?? = self.lock.withLock {
                if let done = self.completed { return done }
                self.continuation = cont
                return nil
              }
              if let ready { cont.resume(returning: ready) }
            }
            return .some(err)
          }
          group.addTask {
            try? await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
            let pending: CheckedContinuation<ReaderFailure?, Never>? = self.lock.withLock {
              let c = self.continuation
              self.continuation = nil
              return c
            }
            pending?.resume(returning: nil)
            return nil
          }
          let first = await group.next() ?? nil
          group.cancelAll()
          return first
        }
      }
    }

    let listenFd = socket(AF_INET, SOCK_STREAM, 0)
    #expect(listenFd >= 0)
    defer { Darwin.close(listenFd) }

    var addr = sockaddr_in()
    addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = 0
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bindRc = withUnsafePointer(to: &addr) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.bind(listenFd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    #expect(bindRc == 0)
    #expect(Darwin.listen(listenFd, 4) == 0)

    var bound = sockaddr_in()
    var len = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafeMutablePointer(to: &bound) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        getsockname(listenFd, $0, &len)
      }
    }
    let port = Int(UInt16(bigEndian: bound.sin_port))
    let localUrl = URL(string: "http://127.0.0.1:\(port)/live/demo/demo/1.ts")!

    // Case 1: start -> suspend -> cancel delivers cancelled completion without URLSession fault.
    let session1 = EngineHttpSession()
    let transport1 = URLSessionTransport(session: session1)
    let recorder1 = CompletionRecorder()
    transport1.start(url: localUrl, headers: [:], delegate: recorder1)
    transport1.suspend()
    transport1.cancel()
    let err1 = await recorder1.wait()
    #expect(err1 == .some(.transport(domain: NSURLErrorDomain, code: NSURLErrorCancelled)))
    session1.dispose()

    // Case 2: pre-start suspend -> start -> session.dispose() cancels + balances suspended tasks
    // synchronously before invalidateAndCancel() so macOS 26 URLSession never hangs waiting on suspendCount == 1.
    let session2 = EngineHttpSession()
    let transport2 = URLSessionTransport(session: session2)
    let recorder2 = CompletionRecorder()
    transport2.suspend()
    transport2.start(url: localUrl, headers: [:], delegate: recorder2)
    session2.dispose()
    #expect(transport2.isCancelledByCaller)
    let err2 = await recorder2.wait()
    #expect(err2 != nil)
    if let unwrapped = err2 {
      #expect(unwrapped != nil)
    }
  }
}

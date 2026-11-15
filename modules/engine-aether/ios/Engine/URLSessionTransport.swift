import Foundation

/// Per-`EngineObject` ephemeral `URLSession` (`httpMaximumConnectionsPerHost = 1`, no cache, origin-scoped redirects).
final class EngineHttpSession: @unchecked Sendable {
  fileprivate final class DelegateMux: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private struct TaskEntry {
      let transport: URLSessionTransport
      let origin: StreamOrigin?
    }

    private let lock = NSLock()
    private var entries: [Int: TaskEntry] = [:]

    func register(taskId: Int, transport: URLSessionTransport, origin: StreamOrigin?) {
      lock.withLock {
        entries[taskId] = TaskEntry(transport: transport, origin: origin)
      }
    }

    func unregister(taskId: Int) {
      _ = lock.withLock {
        entries.removeValue(forKey: taskId)
      }
    }

    private func lookup(_ taskId: Int) -> TaskEntry? {
      lock.withLock { entries[taskId] }
    }

    func urlSession(
      _ session: URLSession,
      task: URLSessionTask,
      willPerformHTTPRedirection response: HTTPURLResponse,
      newRequest request: URLRequest,
      completionHandler: @escaping (URLRequest?) -> Void
    ) {
      let origin = lookup(task.taskIdentifier)?.origin
      completionHandler(sanitizeRedirectRequest(request, origin: origin))
    }

    func urlSession(
      _ session: URLSession,
      dataTask: URLSessionDataTask,
      didReceive response: URLResponse,
      completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
      if let entry = lookup(dataTask.taskIdentifier) {
        let http = response as? HTTPURLResponse
        let status = http?.statusCode ?? 200
        let contentType = http?.value(forHTTPHeaderField: "Content-Type")
        entry.transport.didReceiveResponse(status: status, contentType: contentType)
      }
      completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
      lookup(dataTask.taskIdentifier)?.transport.didReceiveData(data)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
      let entry: TaskEntry? = lock.withLock {
        entries.removeValue(forKey: task.taskIdentifier)
      }
      guard let entry else { return }
      if let error {
        let nsError = error as NSError
        entry.transport.didComplete(error: .transport(domain: nsError.domain, code: nsError.code))
      } else {
        entry.transport.didComplete(error: nil)
      }
    }
  }

  fileprivate let mux = DelegateMux()
  fileprivate let urlSession: URLSession

  init() {
    let config = URLSessionConfiguration.ephemeral
    config.httpMaximumConnectionsPerHost = 1
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.timeoutIntervalForRequest = 10
    config.waitsForConnectivity = false

    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.name = "io.github.fatihmutluu.elv.aether.http"

    self.urlSession = URLSession(configuration: config, delegate: mux, delegateQueue: queue)
  }

  func dispose() {
    urlSession.invalidateAndCancel()
  }
}

/// `URLSessionDataTask`-backed `ByteTransport` with immediate cancellation and balanced suspend/resume.
final class URLSessionTransport: ByteTransport, @unchecked Sendable {
  private let session: EngineHttpSession
  private let lock = NSLock()
  private var task: URLSessionDataTask?
  private var delegate: ByteTransportDelegate?
  private var isCancelled = false
  private var isCompleted = false
  private var isTaskSuspended = false

  init(session: EngineHttpSession) {
    self.session = session
  }

  func start(url: URL, headers: [String: String], delegate: ByteTransportDelegate) {
    var request = URLRequest(
      url: url,
      cachePolicy: .reloadIgnoringLocalCacheData,
      timeoutInterval: 10
    )
    for (key, value) in headers {
      request.setValue(value, forHTTPHeaderField: key)
    }

    let dataTask = session.urlSession.dataTask(with: request)
    let taskId = dataTask.taskIdentifier
    let origin = StreamOrigin(url: url)

    let cancelledBeforeStart: Bool = lock.withLock {
      if isCancelled {
        isCompleted = true
        return true
      }
      self.delegate = delegate
      self.task = dataTask
      return false
    }

    if cancelledBeforeStart {
      dataTask.cancel()
      delegate.transportDidComplete(
        error: .transport(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
      )
      return
    }

    session.mux.register(taskId: taskId, transport: self, origin: origin)
    dataTask.resume()
  }

  func cancel() {
    let currentTask: URLSessionDataTask? = lock.withLock {
      guard !isCancelled else { return nil }
      isCancelled = true
      isTaskSuspended = false
      return task
    }
    currentTask?.cancel()
  }

  func suspend() {
    let currentTask: URLSessionDataTask? = lock.withLock {
      guard !isCancelled, !isCompleted, !isTaskSuspended else { return nil }
      isTaskSuspended = true
      return task
    }
    currentTask?.suspend()
  }

  func resume() {
    let currentTask: URLSessionDataTask? = lock.withLock {
      guard !isCancelled, !isCompleted, isTaskSuspended else { return nil }
      isTaskSuspended = false
      return task
    }
    currentTask?.resume()
  }

  fileprivate func didReceiveResponse(status: Int, contentType: String?) {
    let del: ByteTransportDelegate? = lock.withLock {
      guard !isCompleted else { return nil }
      return delegate
    }
    del?.transportDidReceive(status: status, contentType: contentType)
  }

  fileprivate func didReceiveData(_ data: Data) {
    let del: ByteTransportDelegate? = lock.withLock {
      guard !isCompleted else { return nil }
      return delegate
    }
    del?.transportDidReceive(data)
  }

  fileprivate func didComplete(error: ReaderFailure?) {
    let del: ByteTransportDelegate? = lock.withLock {
      guard !isCompleted else { return nil }
      isCompleted = true
      isTaskSuspended = false
      let d = delegate
      delegate = nil
      task = nil
      return d
    }
    del?.transportDidComplete(error: error)
  }
}

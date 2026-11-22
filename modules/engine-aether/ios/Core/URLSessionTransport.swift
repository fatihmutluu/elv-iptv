import Foundation

/// Minimal task lifecycle seam over `URLSessionDataTask` so unit tests can verify lock-serialized suspend/resume/cancel.
public protocol HttpTaskControlling: AnyObject, Sendable {
  var taskIdentifier: Int { get }
  func resume()
  func suspend()
  func cancel()
}

extension URLSessionDataTask: HttpTaskControlling {}

/// Session seam creating and tracking `HttpTaskControlling` instances for `URLSessionTransport`.
public protocol HttpTaskSession: AnyObject, Sendable {
  func makeDataTask(
    for request: URLRequest,
    origin: StreamOrigin?,
    transport: URLSessionTransport
  ) -> HttpTaskControlling?
  func unregister(taskId: Int)
}

/// Per-`EngineObject` ephemeral `URLSession` (`httpMaximumConnectionsPerHost = 1`, no cache, origin-scoped redirects).
public final class EngineHttpSession: HttpTaskSession, @unchecked Sendable {
  fileprivate final class DelegateMux: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private struct TaskEntry {
      let transport: URLSessionTransport
      var redirectState: RedirectScopeState
    }

    private let lock = NSLock()
    private var entries: [Int: TaskEntry] = [:]
    private let cookieJar: OriginCookieJar

    init(cookieJar: OriginCookieJar) {
      self.cookieJar = cookieJar
    }

    func register(taskId: Int, transport: URLSessionTransport, redirectState: RedirectScopeState) {
      lock.withLock {
        entries[taskId] = TaskEntry(transport: transport, redirectState: redirectState)
      }
    }

    func unregister(taskId: Int) {
      _ = lock.withLock {
        entries.removeValue(forKey: taskId)
      }
    }

    func snapshotTransports() -> [URLSessionTransport] {
      lock.withLock {
        entries.values.map(\.transport)
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
      var state = lookup(task.taskIdentifier)?.redirectState ?? RedirectScopeState(initialOrigin: nil, callerCookie: nil)
      let scoped = scopeRedirectRequest(request, state: &state, response: response, cookieJar: cookieJar)
      lock.withLock {
        if var entry = entries[task.taskIdentifier] {
          entry.redirectState = state
          entries[task.taskIdentifier] = entry
        }
      }
      completionHandler(scoped)
    }

    func urlSession(
      _ session: URLSession,
      dataTask: URLSessionDataTask,
      didReceive response: URLResponse,
      completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
      let http = response as? HTTPURLResponse
      if let http, let url = http.url, let setCookie = http.value(forHTTPHeaderField: "Set-Cookie") {
        cookieJar.store(url: url, setCookieHeader: setCookie)
      }
      if let entry = lookup(dataTask.taskIdentifier) {
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

  private let stateLock = NSLock()
  private var invalidated = false
  private let cookieJar: OriginCookieJar
  private let mux: DelegateMux
  private let urlSession: URLSession

  public init(cookieJar: OriginCookieJar = OriginCookieJar()) {
    self.cookieJar = cookieJar
    let mux = DelegateMux(cookieJar: cookieJar)
    self.mux = mux

    let config = URLSessionConfiguration.ephemeral
    config.httpMaximumConnectionsPerHost = 1
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.httpShouldSetCookies = false
    config.httpCookieStorage = nil
    config.timeoutIntervalForRequest = 10
    config.waitsForConnectivity = false

    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    queue.name = "io.github.fatihmutluu.elv.aether.http"

    self.urlSession = URLSession(configuration: config, delegate: mux, delegateQueue: queue)
  }

  public func makeDataTask(
    for request: URLRequest,
    origin: StreamOrigin?,
    transport: URLSessionTransport
  ) -> HttpTaskControlling? {
    stateLock.withLock {
      guard !invalidated else { return nil }
      let initialOrigin = origin ?? request.url.flatMap(StreamOrigin.init(url:))
      var redirectState = RedirectScopeState(
        initialOrigin: initialOrigin,
        callerCookie: request.value(forHTTPHeaderField: "Cookie")
      )
      let outbound = scopeRedirectRequest(request, state: &redirectState, cookieJar: cookieJar)
      let dataTask = urlSession.dataTask(with: outbound)
      mux.register(taskId: dataTask.taskIdentifier, transport: transport, redirectState: redirectState)
      return dataTask
    }
  }

  public func unregister(taskId: Int) {
    mux.unregister(taskId: taskId)
  }

  public func dispose() {
    let shouldInvalidate: Bool = stateLock.withLock {
      if invalidated { return false }
      invalidated = true
      return true
    }
    guard shouldInvalidate else { return }
    cookieJar.clear()
    for transport in mux.snapshotTransports() {
      transport.cancel()
    }
    urlSession.invalidateAndCancel()
  }
}

/// `URLSessionDataTask`-backed `ByteTransport` with lock-serialized cancellation and balanced suspend/resume.
public final class URLSessionTransport: ByteTransport, @unchecked Sendable {
  private let session: HttpTaskSession
  private let lock = NSLock()
  private var task: HttpTaskControlling?
  private var delegate: ByteTransportDelegate?
  private var isCancelled = false
  private var isCompleted = false
  private var isTaskSuspended = false

  public init(session: HttpTaskSession) {
    self.session = session
  }

  public var isCancelledByCaller: Bool {
    lock.withLock { isCancelled }
  }

  public func start(url: URL, headers: [String: String], delegate: ByteTransportDelegate) {
    var request = URLRequest(
      url: url,
      cachePolicy: .reloadIgnoringLocalCacheData,
      timeoutInterval: 10
    )
    for (key, value) in sanitizeRequestHeaders(headers) {
      request.setValue(value, forHTTPHeaderField: key)
    }
    if request.value(forHTTPHeaderField: "Connection") == nil {
      request.setValue("close", forHTTPHeaderField: "Connection")
    }

    guard let dataTask = session.makeDataTask(
      for: request,
      origin: StreamOrigin(url: url),
      transport: self
    ) else {
      delegate.transportDidComplete(
        error: .transport(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
      )
      return
    }

    let cancelledBeforeStart: Bool = lock.withLock {
      if isCancelled {
        isCompleted = true
        dataTask.cancel()
        return true
      }
      self.delegate = delegate
      self.task = dataTask
      dataTask.resume()
      if isTaskSuspended {
        dataTask.suspend()
      }
      return false
    }

    if cancelledBeforeStart {
      session.unregister(taskId: dataTask.taskIdentifier)
      delegate.transportDidComplete(
        error: .transport(domain: NSURLErrorDomain, code: NSURLErrorCancelled)
      )
    }
  }

  public func cancel() {
    lock.withLock {
      guard !isCancelled else { return }
      let wasSuspended = isTaskSuspended
      isCancelled = true
      isTaskSuspended = false
      task?.cancel()
      if wasSuspended {
        task?.resume()
      }
    }
  }

  public func suspend() {
    lock.withLock {
      guard !isCancelled, !isCompleted, !isTaskSuspended else { return }
      isTaskSuspended = true
      task?.suspend()
    }
  }

  public func resume() {
    lock.withLock {
      guard !isCancelled, !isCompleted, isTaskSuspended else { return }
      isTaskSuspended = false
      task?.resume()
    }
  }

  public func didReceiveResponse(status: Int, contentType: String?) {
    let del: ByteTransportDelegate? = lock.withLock {
      guard !isCompleted else { return nil }
      return delegate
    }
    del?.transportDidReceive(status: status, contentType: contentType)
  }

  public func didReceiveData(_ data: Data) {
    let del: ByteTransportDelegate? = lock.withLock {
      guard !isCompleted else { return nil }
      return delegate
    }
    del?.transportDidReceive(data)
  }

  public func didComplete(error: ReaderFailure?) {
    let del: ByteTransportDelegate? = lock.withLock {
      guard !isCompleted else { return nil }
      let wasSuspended = isTaskSuspended
      isCompleted = true
      isTaskSuspended = false
      if wasSuspended {
        task?.resume()
      }
      task = nil
      let d = delegate
      delegate = nil
      return d
    }
    del?.transportDidComplete(error: error)
  }
}

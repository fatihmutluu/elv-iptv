@preconcurrency import ExpoModulesCore
import Foundation

private struct SendablePromiseBox: @unchecked Sendable {
  let promise: Promise
}

private struct NativeStageJobRequest: Sendable {
  let jobId: String
  let url: URL
  let dbPath: String
  let sourceId: String
  let runId: Int64
  let fromMs: Int64
  let toMs: Int64
  let headers: [String: String]
  let ifNoneMatch: String?
  let ifModifiedSince: String?
  let defaultTimeZone: String?
  let timeoutSeconds: TimeInterval
}

private final class StreamingXmltvJob: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private static let maxRedirects = 5

  private let request: NativeStageJobRequest
  private let workQueue: DispatchQueue
  private let onFinish: ([String: Any]) -> Void
  private let stateLock = NSLock()

  private var session: URLSession?
  private var task: URLSessionDataTask?
  private var cancelled = false
  private var finished = false
  private var redirectCount = 0

  private var etag: String?
  private var lastModified: String?
  private var gzipDecoder: StreamingGzipDecoder?
  private var scanner: XmltvByteScanner?
  private var writer: XmltvSqliteWriter?
  private var streamError: [String: Any]?

  init(request: NativeStageJobRequest, onFinish: @escaping ([String: Any]) -> Void) {
    self.request = request
    self.workQueue = DispatchQueue(label: "elv.xmltv.stage.\(request.jobId)", qos: .utility)
    self.onFinish = onFinish
    super.init()
  }

  func start() {
    var urlReq = URLRequest(url: request.url)
    urlReq.httpMethod = "GET"
    urlReq.cachePolicy = .reloadIgnoringLocalCacheData
    urlReq.timeoutInterval = request.timeoutSeconds
    urlReq.setValue("gzip", forHTTPHeaderField: "Accept-Encoding")
    for (k, v) in request.headers where k.lowercased() != "accept-encoding" {
      urlReq.setValue(v, forHTTPHeaderField: k)
    }
    if let etag = request.ifNoneMatch, !etag.isEmpty {
      urlReq.setValue(etag, forHTTPHeaderField: "If-None-Match")
    }
    if let ims = request.ifModifiedSince, !ims.isEmpty {
      urlReq.setValue(ims, forHTTPHeaderField: "If-Modified-Since")
    }

    let config = URLSessionConfiguration.ephemeral
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.urlCache = nil
    config.timeoutIntervalForRequest = request.timeoutSeconds
    config.timeoutIntervalForResource = max(request.timeoutSeconds, 300)

    let delegateQueue = OperationQueue()
    delegateQueue.maxConcurrentOperationCount = 1
    delegateQueue.underlyingQueue = workQueue

    let createdSession = URLSession(configuration: config, delegate: self, delegateQueue: delegateQueue)
    let createdTask = createdSession.dataTask(with: urlReq)

    stateLock.lock()
    if cancelled {
      stateLock.unlock()
      createdSession.invalidateAndCancel()
      completeOnce(["kind": "http-error", "status": 0, "retryable": false, "code": "aborted"])
      return
    }
    self.session = createdSession
    self.task = createdTask
    stateLock.unlock()

    createdTask.resume()
  }

  func cancel() {
    stateLock.lock()
    cancelled = true
    let activeTask = task
    stateLock.unlock()
    activeTask?.cancel()
  }

  private func isCancelled() -> Bool {
    stateLock.lock()
    defer { stateLock.unlock() }
    return cancelled
  }

  private func completeOnce(_ payload: [String: Any]) {
    stateLock.lock()
    if finished {
      stateLock.unlock()
      return
    }
    finished = true
    let activeSession = session
    session = nil
    task = nil
    stateLock.unlock()

    writer?.abort()
    writer = nil
    gzipDecoder = nil
    scanner = nil
    activeSession?.invalidateAndCancel()
    onFinish(payload)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    if isCancelled() || redirectCount >= Self.maxRedirects {
      completionHandler(nil)
      return
    }
    guard let scheme = request.url?.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
      completionHandler(nil)
      return
    }
    redirectCount += 1
    completionHandler(request)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    if isCancelled() {
      completionHandler(.cancel)
      completeOnce(["kind": "http-error", "status": 0, "retryable": false, "code": "aborted"])
      return
    }
    guard let http = response as? HTTPURLResponse else {
      completionHandler(.cancel)
      completeOnce(["kind": "http-error", "status": 0, "retryable": true, "code": "request-failed"])
      return
    }
    let status = http.statusCode
    self.etag = http.value(forHTTPHeaderField: "ETag")
    self.lastModified = http.value(forHTTPHeaderField: "Last-Modified")

    if status == 304 {
      completionHandler(.cancel)
      var result: [String: Any] = ["kind": "not-modified"]
      if let etag, !etag.isEmpty { result["etag"] = etag }
      if let lastModified, !lastModified.isEmpty { result["lastModified"] = lastModified }
      completeOnce(result)
      return
    }

    if status < 200 || status >= 300 {
      completionHandler(.cancel)
      let retryable = status == 408 || (status >= 500 && status <= 599 && status != 509)
      completeOnce([
        "kind": "http-error",
        "status": status,
        "retryable": retryable,
        "code": "http-\(status)",
      ])
      return
    }

    do {
      self.writer = try XmltvSqliteWriter(dbPath: request.dbPath)
      self.gzipDecoder = StreamingGzipDecoder()
      self.scanner = XmltvByteScanner(
        sourceId: request.sourceId,
        runId: request.runId,
        fromMs: request.fromMs,
        toMs: request.toMs,
        defaultTimeZone: request.defaultTimeZone
      )
      completionHandler(.allow)
    } catch {
      completionHandler(.cancel)
      completeOnce(["kind": "http-error", "status": 0, "retryable": false, "code": "native-sqlite-failed"])
    }
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard streamError == nil else { return }
    if isCancelled() {
      streamError = ["kind": "http-error", "status": 0, "retryable": false, "code": "aborted"]
      dataTask.cancel()
      return
    }
    guard let gzip = gzipDecoder, let scanner = scanner, let writer = writer else { return }
    do {
      try data.withUnsafeBytes { rawBuf in
        let typed = rawBuf.bindMemory(to: UInt8.self)
        try gzip.feed(typed) { xmlChunk in
          try scanner.feed(xmlChunk) { row in
            try writer.write(row)
          }
        }
      }
    } catch XmltvStreamError.gzipCorrupt, XmltvStreamError.gzipInitFailed {
      streamError = ["kind": "http-error", "status": 0, "retryable": false, "code": "gzip-corrupt"]
      dataTask.cancel()
    } catch {
      streamError = ["kind": "http-error", "status": 0, "retryable": false, "code": "native-stage-failed"]
      dataTask.cancel()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if let streamError {
      completeOnce(streamError)
      return
    }
    if isCancelled() {
      completeOnce(["kind": "http-error", "status": 0, "retryable": false, "code": "aborted"])
      return
    }
    if let nsError = error as NSError? {
      if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled {
        completeOnce(["kind": "http-error", "status": 0, "retryable": false, "code": "aborted"])
        return
      }
      if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorTimedOut {
        completeOnce(["kind": "http-error", "status": 0, "retryable": true, "code": "timeout"])
        return
      }
      completeOnce(["kind": "http-error", "status": 0, "retryable": true, "code": "request-failed"])
      return
    }
    guard let gzip = gzipDecoder, let scanner = scanner, let writer = writer else {
      completeOnce(["kind": "http-error", "status": 0, "retryable": false, "code": "native-stage-failed"])
      return
    }
    do {
      try gzip.finish { xmlChunk in
        try scanner.feed(xmlChunk) { row in
          try writer.write(row)
        }
      }
      let summary = try scanner.finish { row in
        try writer.write(row)
      }
      try writer.finish()
      self.writer = nil

      let channels: [[String: Any]] = summary.channels.map { ch in
        var dict: [String: Any] = ["id": ch.id, "names": ch.names]
        if let icon = ch.icon, !icon.isEmpty { dict["icon"] = icon }
        if let lcn = ch.lcn, !lcn.isEmpty { dict["lcn"] = lcn }
        return dict
      }
      var result: [String: Any] = [
        "kind": "staged",
        "channels": channels,
        "stagedCounts": summary.stagedCounts,
        "seenProgrammes": summary.seenProgrammes,
        "stagedProgrammes": summary.stagedProgrammes,
        "warnings": summary.warnings,
        "warningCodes": summary.warningCodes,
      ]
      if let etag, !etag.isEmpty { result["etag"] = etag }
      if let lastModified, !lastModified.isEmpty { result["lastModified"] = lastModified }
      completeOnce(result)
    } catch {
      completeOnce(["kind": "http-error", "status": 0, "retryable": false, "code": "native-stage-failed"])
    }
  }
}

/// Expo native module streaming HTTP(S) XMLTV guides directly into SQLite `programmes_next`
/// off the Hermes JS thread (`#478`). Never logs URLs, headers, or credentials.
public final class ElvXmltvNativeModule: Module, @unchecked Sendable {
  private let jobsLock = NSLock()
  private var activeJobs: [String: StreamingXmltvJob] = [:]

  public func definition() -> ModuleDefinition {
    Name("ElvXmltvNative")

    AsyncFunction("stageXmltv") { (options: [String: Any], promise: Promise) in
      guard let jobId = options["jobId"] as? String, !jobId.isEmpty,
            let urlStr = options["url"] as? String,
            let url = URL(string: urlStr),
            let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
            let dbPath = options["dbPath"] as? String, !dbPath.isEmpty,
            let sourceId = options["sourceId"] as? String, !sourceId.isEmpty,
            let runIdNum = options["runId"] as? NSNumber,
            let fromNum = options["fromMs"] as? NSNumber,
            let toNum = options["toMs"] as? NSNumber else {
        promise.reject("E_XMLTV_INVALID_REQUEST", "Missing required XMLTV stage parameters")
        return
      }

      var headers: [String: String] = [:]
      if let rawHeaders = options["headers"] as? [String: Any] {
        for (k, v) in rawHeaders {
          if let sv = v as? String { headers[k] = sv }
        }
      }
      let timeoutMs = min(max((options["timeoutMs"] as? NSNumber)?.doubleValue ?? 180_000, 1_000), 600_000)

      let req = NativeStageJobRequest(
        jobId: jobId,
        url: url,
        dbPath: dbPath,
        sourceId: sourceId,
        runId: runIdNum.int64Value,
        fromMs: fromNum.int64Value,
        toMs: toNum.int64Value,
        headers: headers,
        ifNoneMatch: options["ifNoneMatch"] as? String,
        ifModifiedSince: options["ifModifiedSince"] as? String,
        defaultTimeZone: options["defaultTimeZone"] as? String,
        timeoutSeconds: timeoutMs / 1000.0
      )

      let promiseBox = SendablePromiseBox(promise: promise)
      let job = StreamingXmltvJob(request: req) { [weak self] result in
        self?.removeJob(jobId)
        promiseBox.promise.resolve(result)
      }
      self.registerJob(job, id: jobId)
      job.start()
    }

    Function("cancelXmltvStage") { (jobId: String) in
      self.cancelJob(jobId)
    }

    OnDestroy {
      self.cancelAllJobs()
    }
  }

  private func registerJob(_ job: StreamingXmltvJob, id: String) {
    jobsLock.lock()
    let previous = activeJobs.updateValue(job, forKey: id)
    jobsLock.unlock()
    previous?.cancel()
  }

  private func removeJob(_ id: String) {
    jobsLock.lock()
    activeJobs.removeValue(forKey: id)
    jobsLock.unlock()
  }

  private func cancelJob(_ id: String) {
    jobsLock.lock()
    let job = activeJobs[id]
    jobsLock.unlock()
    job?.cancel()
  }

  private func cancelAllJobs() {
    jobsLock.lock()
    let jobs = Array(activeJobs.values)
    activeJobs.removeAll()
    jobsLock.unlock()
    for job in jobs {
      job.cancel()
    }
  }
}

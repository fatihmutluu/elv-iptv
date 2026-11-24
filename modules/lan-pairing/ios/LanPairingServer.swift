import Foundation
import Network

/// Active endpoint metadata returned once the ephemeral pairing listener binds.
public struct LanPairingServerInfo: Sendable {
  public let host: String
  public let port: Int
  public let url: String
  public let expiresAtMs: Double
}

/// Errors emitted while configuring or starting the ephemeral LAN pairing server.
public enum LanPairingServerError: Error, LocalizedError, Sendable {
  case invalidOptions(String)
  case noPrivateLanAddress
  case listenerFailed

  public var errorDescription: String? {
    switch self {
    case let .invalidOptions(reason):
      return reason
    case .noPrivateLanAddress:
      return "No private LAN IPv4 address available"
    case .listenerFailed:
      return "Failed to bind ephemeral LAN pairing listener"
    }
  }
}

/// Ephemeral single-use `Network.framework` HTTP/1.1 server for phone-to-TV LAN pairing (`#50`).
/// Enforces private-LAN/loopback peer validation, exact `Host` and same-origin `Origin` checks,
/// constant-time token path matching, 16 KiB body cap, 5-attempt lockout, and `Cache-Control: no-store`.
/// Never logs request bodies, headers, tokens, or URLs.
public final class LanPairingServer: @unchecked Sendable {
  public static let defaultMaxBodyBytes = 16_384
  public static let defaultMaxFailedAttempts = 5
  private static let hardMaxBodyBytes = 65_536
  private static let maxHeaderBytes = 8_192
  private static let minTtlMs = 1_000
  private static let maxTtlMs = 600_000
  private static let connectionTimeoutSeconds: TimeInterval = 5.0
  private static let headerDelimiter = Data([0x0d, 0x0a, 0x0d, 0x0a])

  private let token: String
  private let htmlData: Data
  private let ttlMs: Int
  private let maxBodyBytes: Int
  private let maxFailedAttempts: Int
  private let onSubmission: @Sendable (String, String?) -> Void

  private let queue = DispatchQueue(label: "io.github.fatihmutluu.elv.lanpairing.server")
  private var listener: NWListener?
  private var ttlWorkItem: DispatchWorkItem?
  private var startCompletion: (@Sendable (Result<LanPairingServerInfo, Error>) -> Void)?
  private var activeConnections: [ObjectIdentifier: NWConnection] = [:]
  private var connectionTimeouts: [ObjectIdentifier: DispatchWorkItem] = [:]
  private var isRunning = false
  private var hasSubmitted = false
  private var failedAttempts = 0
  private var boundHost = ""
  private var boundPort = 0

  public init(
    token: String,
    html: String,
    ttlMs: Int,
    maxBodyBytes: Int = LanPairingServer.defaultMaxBodyBytes,
    maxFailedAttempts: Int = LanPairingServer.defaultMaxFailedAttempts,
    onSubmission: @escaping @Sendable (String, String?) -> Void
  ) {
    self.token = token
    self.htmlData = Data(html.utf8)
    self.ttlMs = ttlMs
    self.maxBodyBytes = maxBodyBytes
    self.maxFailedAttempts = maxFailedAttempts
    self.onSubmission = onSubmission
  }

  deinit {
    listener?.cancel()
    ttlWorkItem?.cancel()
    for timeout in connectionTimeouts.values {
      timeout.cancel()
    }
    for connection in activeConnections.values {
      connection.cancel()
    }
  }

  /// Starts the ephemeral TCP listener on a free port and resolves with endpoint metadata.
  public func start(completion: @escaping @Sendable (Result<LanPairingServerInfo, Error>) -> Void) {
    guard LanPairingValidation.isValidToken(token) else {
      completion(.failure(LanPairingServerError.invalidOptions("Invalid pairing token")))
      return
    }
    guard ttlMs >= Self.minTtlMs && ttlMs <= Self.maxTtlMs else {
      completion(.failure(LanPairingServerError.invalidOptions("Invalid pairing TTL")))
      return
    }
    guard maxBodyBytes >= 256 && maxBodyBytes <= Self.hardMaxBodyBytes else {
      completion(.failure(LanPairingServerError.invalidOptions("Invalid maxBodyBytes")))
      return
    }
    guard maxFailedAttempts >= 1 && maxFailedAttempts <= 20 else {
      completion(.failure(LanPairingServerError.invalidOptions("Invalid maxFailedAttempts")))
      return
    }
    guard let host = LanPairingValidation.discoverPreferredLanIpv4() else {
      completion(.failure(LanPairingServerError.noPrivateLanAddress))
      return
    }

    queue.async { [weak self] in
      guard let self else {
        completion(.failure(LanPairingServerError.listenerFailed))
        return
      }
      if self.isRunning {
        completion(.failure(LanPairingServerError.invalidOptions("Server already running")))
        return
      }

      let nwListener: NWListener
      do {
        nwListener = try NWListener(using: .tcp)
      } catch {
        completion(.failure(LanPairingServerError.listenerFailed))
        return
      }

      self.listener = nwListener
      self.boundHost = host
      self.isRunning = true
      self.startCompletion = completion

      nwListener.stateUpdateHandler = { [weak self] state in
        guard let self else { return }
        switch state {
        case .ready:
          guard let rawPort = nwListener.port?.rawValue, rawPort > 0 else {
            self.finishStartOnQueue(.failure(LanPairingServerError.listenerFailed))
            self.stopOnQueue()
            return
          }
          let port = Int(rawPort)
          self.boundPort = port
          let expiresAtMs = Date().timeIntervalSince1970 * 1_000.0 + Double(self.ttlMs)
          let authorityHost = LanPairingValidation.formatHostForAuthority(host)
          let url = "http://\(authorityHost):\(port)/pair/\(self.token)"
          self.scheduleTtlOnQueue()
          self.finishStartOnQueue(.success(LanPairingServerInfo(
            host: host,
            port: port,
            url: url,
            expiresAtMs: expiresAtMs
          )))
        case .failed, .cancelled:
          self.finishStartOnQueue(.failure(LanPairingServerError.listenerFailed))
          self.stopOnQueue()
        default:
          break
        }
      }

      nwListener.newConnectionHandler = { [weak self] connection in
        self?.handleConnectionOnQueue(connection)
      }

      nwListener.start(queue: self.queue)
    }
  }

  /// Idempotently closes the listening socket, cancels TTL timer, and tears down active peers.
  public func stop() {
    queue.async { [weak self] in
      self?.stopOnQueue()
    }
  }

  private func scheduleTtlOnQueue() {
    ttlWorkItem?.cancel()
    let item = DispatchWorkItem { [weak self] in
      self?.stopOnQueue()
    }
    ttlWorkItem = item
    queue.asyncAfter(deadline: .now() + .milliseconds(ttlMs), execute: item)
  }

  private func finishStartOnQueue(_ result: Result<LanPairingServerInfo, Error>) {
    guard let callback = startCompletion else { return }
    startCompletion = nil
    callback(result)
  }

  private func stopOnQueue() {
    isRunning = false
    finishStartOnQueue(.failure(LanPairingServerError.listenerFailed))
    ttlWorkItem?.cancel()
    ttlWorkItem = nil
    listener?.stateUpdateHandler = nil
    listener?.newConnectionHandler = nil
    listener?.cancel()
    listener = nil
    let timeouts = Array(connectionTimeouts.values)
    connectionTimeouts.removeAll()
    for timeout in timeouts {
      timeout.cancel()
    }
    let connections = Array(activeConnections.values)
    activeConnections.removeAll()
    for conn in connections {
      conn.cancel()
    }
  }

  private func handleConnectionOnQueue(_ connection: NWConnection) {
    guard isRunning else {
      connection.cancel()
      return
    }

    let connId = ObjectIdentifier(connection)
    activeConnections[connId] = connection

    let timeoutItem = DispatchWorkItem { [weak self, weak connection] in
      guard let self, let connection else { return }
      self.closeConnectionOnQueue(connection)
    }
    connectionTimeouts[connId] = timeoutItem
    queue.asyncAfter(deadline: .now() + Self.connectionTimeoutSeconds, execute: timeoutItem)

    connection.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection else { return }
      switch state {
      case .ready:
        if !LanPairingValidation.isPrivateLanEndpoint(connection.endpoint) {
          self.sendResponseAndCloseOnQueue(
            connection,
            status: 403,
            reason: "Forbidden",
            contentType: "text/plain; charset=utf-8",
            body: Data("Forbidden".utf8),
            recordFailure: true
          )
          return
        }
        self.receiveHeadersOnQueue(connection, buffer: Data())
      case .failed, .cancelled:
        self.connectionTimeouts.removeValue(forKey: connId)?.cancel()
        self.activeConnections.removeValue(forKey: connId)
      default:
        break
      }
    }

    connection.start(queue: queue)
  }

  private func receiveHeadersOnQueue(
    _ connection: NWConnection,
    buffer: Data
  ) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 4_096) { [weak self] data, _, isComplete, error in
      guard let self else { return }
      if error != nil {
        self.closeConnectionOnQueue(connection)
        return
      }
      var nextBuffer = buffer
      if let data, !data.isEmpty {
        nextBuffer.append(data)
      }

      if let range = nextBuffer.range(of: Self.headerDelimiter) {
        if range.lowerBound > Self.maxHeaderBytes {
          self.sendResponseAndCloseOnQueue(
            connection,
            status: 431,
            reason: "Request Header Fields Too Large",
            contentType: "text/plain; charset=utf-8",
            body: Data("Headers Too Large".utf8),
            recordFailure: true
          )
          return
        }
        let headerData = nextBuffer.subdata(in: 0..<range.lowerBound)
        let initialBody = nextBuffer.subdata(in: range.upperBound..<nextBuffer.count)
        self.processRequestHeadersOnQueue(
          connection,
          headerData: headerData,
          initialBody: initialBody
        )
        return
      }

      if nextBuffer.count > Self.maxHeaderBytes {
        self.sendResponseAndCloseOnQueue(
          connection,
          status: 431,
          reason: "Request Header Fields Too Large",
          contentType: "text/plain; charset=utf-8",
          body: Data("Headers Too Large".utf8),
          recordFailure: true
        )
        return
      }

      if isComplete {
        self.sendResponseAndCloseOnQueue(
          connection,
          status: 400,
          reason: "Bad Request",
          contentType: "text/plain; charset=utf-8",
          body: Data("Bad Request".utf8),
          recordFailure: true
        )
        return
      }

      self.receiveHeadersOnQueue(connection, buffer: nextBuffer)
    }
  }

  private struct ParsedHeaders {
    let method: String
    let path: String
    let headers: [String: String]
  }

  private func parseHeaders(_ headerData: Data) -> ParsedHeaders? {
    guard let text = String(data: headerData, encoding: .isoLatin1) else { return nil }
    let lines = text.components(separatedBy: "\r\n")
    guard let requestLine = lines.first, !requestLine.isEmpty else { return nil }
    let parts = requestLine.split(separator: " ", omittingEmptySubsequences: false)
    guard parts.count == 3 else { return nil }
    let method = parts[0].trimmingCharacters(in: .whitespaces).uppercased()
    let path = String(parts[1]).trimmingCharacters(in: .whitespaces)
    let version = String(parts[2]).trimmingCharacters(in: .whitespaces)
    guard version.hasPrefix("HTTP/1.") else { return nil }

    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      if line.isEmpty { continue }
      guard let colon = line.firstIndex(of: ":") else { return nil }
      let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
      guard !name.isEmpty else { return nil }
      let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
      if (name == "host" || name == "content-length"), headers[name] != nil {
        return nil
      }
      headers[name] = value
    }

    return ParsedHeaders(method: method, path: path, headers: headers)
  }

  private func processRequestHeadersOnQueue(
    _ connection: NWConnection,
    headerData: Data,
    initialBody: Data
  ) {
    guard let parsed = parseHeaders(headerData) else {
      sendResponseAndCloseOnQueue(
        connection,
        status: 400,
        reason: "Bad Request",
        contentType: "text/plain; charset=utf-8",
        body: Data("Bad Request".utf8),
        recordFailure: true
      )
      return
    }

    guard LanPairingValidation.isValidHostHeader(
      parsed.headers["host"],
      expectedHost: boundHost,
      expectedPort: boundPort
    ) else {
      sendResponseAndCloseOnQueue(
        connection,
        status: 403,
        reason: "Forbidden",
        contentType: "text/plain; charset=utf-8",
        body: Data("Forbidden".utf8),
        recordFailure: true
      )
      return
    }

    guard LanPairingValidation.isValidPairingPath(parsed.path, expectedToken: token) else {
      sendResponseAndCloseOnQueue(
        connection,
        status: 404,
        reason: "Not Found",
        contentType: "text/plain; charset=utf-8",
        body: Data("Not Found".utf8),
        recordFailure: true
      )
      return
    }

    if parsed.method == "GET" {
      sendResponseAndCloseOnQueue(
        connection,
        status: 200,
        reason: "OK",
        contentType: "text/html; charset=utf-8",
        body: htmlData,
        includeHtmlCsp: true,
        recordFailure: false
      )
      return
    }

    guard parsed.method == "POST" else {
      sendResponseAndCloseOnQueue(
        connection,
        status: 405,
        reason: "Method Not Allowed",
        contentType: "text/plain; charset=utf-8",
        body: Data("Method Not Allowed".utf8),
        recordFailure: true
      )
      return
    }

    guard LanPairingValidation.isValidOriginHeader(
      parsed.headers["origin"],
      expectedHost: boundHost,
      expectedPort: boundPort
    ) else {
      sendResponseAndCloseOnQueue(
        connection,
        status: 403,
        reason: "Forbidden",
        contentType: "text/plain; charset=utf-8",
        body: Data("Forbidden".utf8),
        recordFailure: true
      )
      return
    }

    if parsed.headers["transfer-encoding"] != nil {
      sendResponseAndCloseOnQueue(
        connection,
        status: 411,
        reason: "Length Required",
        contentType: "text/plain; charset=utf-8",
        body: Data("Length Required".utf8),
        recordFailure: true
      )
      return
    }

    guard let rawLength = parsed.headers["content-length"],
          let contentLength = Int(rawLength.trimmingCharacters(in: .whitespaces)),
          contentLength >= 0
    else {
      sendResponseAndCloseOnQueue(
        connection,
        status: 411,
        reason: "Length Required",
        contentType: "text/plain; charset=utf-8",
        body: Data("Length Required".utf8),
        recordFailure: true
      )
      return
    }

    if contentLength == 0 {
      sendResponseAndCloseOnQueue(
        connection,
        status: 400,
        reason: "Bad Request",
        contentType: "application/json; charset=utf-8",
        body: Data("{\"error\":\"invalid-payload\"}".utf8),
        recordFailure: true
      )
      return
    }

    if contentLength > maxBodyBytes {
      sendResponseAndCloseOnQueue(
        connection,
        status: 413,
        reason: "Payload Too Large",
        contentType: "text/plain; charset=utf-8",
        body: Data("Payload Too Large".utf8),
        recordFailure: true
      )
      return
    }

    receiveBodyOnQueue(
      connection,
      buffer: initialBody,
      expectedLength: contentLength,
      contentType: parsed.headers["content-type"]
    )
  }

  private func receiveBodyOnQueue(
    _ connection: NWConnection,
    buffer: Data,
    expectedLength: Int,
    contentType: String?
  ) {
    if buffer.count >= expectedLength {
      completePostOnQueue(
        connection,
        bodyData: Data(buffer.prefix(expectedLength)),
        contentType: contentType
      )
      return
    }

    let remaining = expectedLength - buffer.count
    connection.receive(minimumIncompleteLength: 1, maximumLength: min(remaining, 4_096)) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }
      if error != nil {
        self.closeConnectionOnQueue(connection)
        return
      }
      var nextBuffer = buffer
      if let data, !data.isEmpty {
        nextBuffer.append(data)
      }
      if nextBuffer.count >= expectedLength {
        self.completePostOnQueue(
          connection,
          bodyData: Data(nextBuffer.prefix(expectedLength)),
          contentType: contentType
        )
        return
      }
      if isComplete {
        self.sendResponseAndCloseOnQueue(
          connection,
          status: 400,
          reason: "Bad Request",
          contentType: "text/plain; charset=utf-8",
          body: Data("Incomplete Body".utf8),
          recordFailure: true
        )
        return
      }
      self.receiveBodyOnQueue(
        connection,
        buffer: nextBuffer,
        expectedLength: expectedLength,
        contentType: contentType
      )
    }
  }

  private func completePostOnQueue(
    _ connection: NWConnection,
    bodyData: Data,
    contentType: String?
  ) {
    if hasSubmitted {
      sendResponseAndCloseOnQueue(
        connection,
        status: 410,
        reason: "Gone",
        contentType: "text/plain; charset=utf-8",
        body: Data("Expired".utf8),
        recordFailure: false,
        stopServerAfter: true
      )
      return
    }

    guard let bodyText = String(data: bodyData, encoding: .utf8),
          LanPairingValidation.isValidSubmissionPayload(bodyData, contentType: contentType)
    else {
      sendResponseAndCloseOnQueue(
        connection,
        status: 400,
        reason: "Bad Request",
        contentType: "application/json; charset=utf-8",
        body: Data("{\"error\":\"invalid-payload\"}".utf8),
        recordFailure: true
      )
      return
    }

    hasSubmitted = true
    let callback = onSubmission
    let responseData = Self.buildHttpResponse(
      status: 200,
      reason: "OK",
      contentType: "application/json; charset=utf-8",
      body: Data("{\"ok\":true}".utf8),
      includeHtmlCsp: false
    )

    connectionTimeouts.removeValue(forKey: ObjectIdentifier(connection))?.cancel()
    connection.send(content: responseData, completion: .contentProcessed { [weak self] _ in
      guard let self else { return }
      self.closeConnectionOnQueue(connection)
      self.stopOnQueue()
      DispatchQueue.global(qos: .userInitiated).async {
        callback(bodyText, contentType)
      }
    })
  }

  private func sendResponseAndCloseOnQueue(
    _ connection: NWConnection,
    status: Int,
    reason: String,
    contentType: String,
    body: Data,
    includeHtmlCsp: Bool = false,
    recordFailure: Bool,
    stopServerAfter: Bool = false
  ) {
    connectionTimeouts.removeValue(forKey: ObjectIdentifier(connection))?.cancel()
    var shouldStop = stopServerAfter
    if recordFailure {
      failedAttempts += 1
      if failedAttempts >= maxFailedAttempts {
        shouldStop = true
      }
    }
    let stopAfter = shouldStop

    let responseData = Self.buildHttpResponse(
      status: status,
      reason: reason,
      contentType: contentType,
      body: body,
      includeHtmlCsp: includeHtmlCsp
    )
    connection.send(content: responseData, completion: .contentProcessed { [weak self] _ in
      guard let self else { return }
      self.closeConnectionOnQueue(connection)
      if stopAfter {
        self.stopOnQueue()
      }
    })
  }

  private func closeConnectionOnQueue(_ connection: NWConnection) {
    let connId = ObjectIdentifier(connection)
    connectionTimeouts.removeValue(forKey: connId)?.cancel()
    activeConnections.removeValue(forKey: connId)
    connection.cancel()
  }

  private static func buildHttpResponse(
    status: Int,
    reason: String,
    contentType: String,
    body: Data,
    includeHtmlCsp: Bool
  ) -> Data {
    var headers = "HTTP/1.1 \(status) \(reason)\r\n"
    headers += "Content-Type: \(contentType)\r\n"
    headers += "Content-Length: \(body.count)\r\n"
    headers += "Cache-Control: no-store\r\n"
    headers += "Pragma: no-cache\r\n"
    headers += "X-Content-Type-Options: nosniff\r\n"
    headers += "X-Frame-Options: DENY\r\n"
    headers += "Referrer-Policy: no-referrer\r\n"
    if includeHtmlCsp {
      headers += "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; "
      headers += "script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'\r\n"
    }
    headers += "Connection: close\r\n\r\n"
    var payload = Data(headers.utf8)
    payload.append(body)
    return payload
  }
}

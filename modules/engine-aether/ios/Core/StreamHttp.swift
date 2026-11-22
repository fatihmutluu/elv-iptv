import Foundation

private let sensitiveHeaders: Set<String> = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]

private let tokenPunctuation: Set<UInt8> = Set("!#$%&'*+-.^_`|~".utf8)

/// Origin `(scheme, host, effectivePort)` that sensitive stream headers and cookies are scoped to.
public struct StreamOrigin: Equatable, Hashable, Sendable {
  public let scheme: String
  public let host: String
  public let port: Int

  public init?(url: URL) {
    guard
      let rawScheme = url.scheme?.lowercased(),
      !rawScheme.isEmpty,
      let rawHost = url.host?.lowercased(),
      !rawHost.isEmpty
    else {
      return nil
    }
    self.scheme = rawScheme
    self.host = rawHost
    if let explicitPort = url.port {
      self.port = explicitPort
    } else if rawScheme == "https" {
      self.port = 443
    } else if rawScheme == "http" {
      self.port = 80
    } else {
      self.port = -1
    }
  }
}

/// Validates RFC 7230 header names and strips CR, LF, NUL, and ASCII control characters from header values.
public func sanitizeRequestHeaders(_ headers: [String: String]) -> [String: String] {
  var out: [String: String] = [:]
  for (rawKey, rawValue) in headers {
    guard let cleanName = sanitizeHeaderName(rawKey) else { continue }
    let cleanValue = sanitizeHeaderValue(rawValue)
    guard !cleanValue.isEmpty else { continue }
    out[cleanName] = cleanValue
  }
  return out
}

/// Strips sensitive auth/session headers when `targetUrl` leaves `origin`, after sanitizing header fields.
public func sanitizeHeaders(
  _ headers: [String: String],
  for targetUrl: URL,
  origin: StreamOrigin?
) -> [String: String] {
  let cleaned = sanitizeRequestHeaders(headers)
  if let origin, let targetOrigin = StreamOrigin(url: targetUrl), origin == targetOrigin {
    return cleaned
  }
  return cleaned.filter { key, _ in
    !sensitiveHeaders.contains(key.lowercased())
  }
}

/// Strips sensitive headers from a redirect `URLRequest` when its URL leaves `origin`.
public func sanitizeRedirectRequest(_ request: URLRequest, origin: StreamOrigin?) -> URLRequest {
  if let url = request.url, let origin, let targetOrigin = StreamOrigin(url: url), origin == targetOrigin {
    return request
  }
  var copy = request
  if let existing = copy.allHTTPHeaderFields {
    for key in existing.keys where sensitiveHeaders.contains(key.lowercased()) {
      copy.setValue(nil, forHTTPHeaderField: key)
    }
  }
  copy.setValue(nil, forHTTPHeaderField: "Authorization")
  copy.setValue(nil, forHTTPHeaderField: "Cookie")
  copy.setValue(nil, forHTTPHeaderField: "Proxy-Authorization")
  copy.setValue(nil, forHTTPHeaderField: "X-Api-Key")
  copy.setValue(nil, forHTTPHeaderField: "X-Auth-Token")
  return copy
}

private func sanitizeHeaderName(_ raw: String) -> String? {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }
  for byte in trimmed.utf8 {
    let isDigit = byte >= 0x30 && byte <= 0x39
    let isUpper = byte >= 0x41 && byte <= 0x5A
    let isLower = byte >= 0x61 && byte <= 0x7A
    guard isDigit || isUpper || isLower || tokenPunctuation.contains(byte) else {
      return nil
    }
  }
  return trimmed
}

private func sanitizeHeaderValue(_ raw: String) -> String {
  var scalars = String.UnicodeScalarView()
  scalars.reserveCapacity(raw.unicodeScalars.count)
  for scalar in raw.unicodeScalars {
    let v = scalar.value
    if v <= 0x1F || v == 0x7F {
      continue
    }
    scalars.append(scalar)
  }
  return String(scalars).trimmingCharacters(in: .whitespacesAndNewlines)
}

private let httpDateMonths: [String: Int] = [
  "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
  "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
]

private struct CookieKey: Hashable, Sendable {
  let origin: StreamOrigin
  let path: String
  let name: String
}

private struct StoredCookie: Sendable {
  let origin: StreamOrigin
  let path: String
  let name: String
  let value: String
  let secure: Bool
  let expiresAt: TimeInterval?
  let createdAt: UInt64
}

private func normalizedRequestPath(for url: URL) -> String {
  if let path = URLComponents(url: url, resolvingAgainstBaseURL: true)?.percentEncodedPath, path.hasPrefix("/") {
    return path
  }
  return "/"
}

private func defaultCookiePath(for url: URL) -> String {
  let path = normalizedRequestPath(for: url)
  guard let lastSlash = path.lastIndex(of: "/"), lastSlash != path.startIndex else { return "/" }
  return String(path[..<lastSlash])
}

private func cookiePathMatches(requestPath: String, cookiePath: String) -> Bool {
  if requestPath == cookiePath { return true }
  guard requestPath.hasPrefix(cookiePath) else { return false }
  if cookiePath.hasSuffix("/") { return true }
  return requestPath[requestPath.index(requestPath.startIndex, offsetBy: cookiePath.count)] == "/"
}

private func startsWithCookiePair(_ segment: Substring) -> Bool {
  guard let eqIdx = segment.firstIndex(of: "=") else { return false }
  return sanitizeHeaderName(String(segment[..<eqIdx])) != nil
}

/// Splits a comma-joined `Set-Cookie` header without splitting inside `Expires=` HTTP dates or quoted values.
private func splitSetCookieHeader(_ raw: String) -> [String] {
  var result: [String] = []
  var start = raw.startIndex
  var inQuotes = false
  var idx = raw.startIndex
  while idx < raw.endIndex {
    let ch = raw[idx]
    if ch == "\"" {
      inQuotes.toggle()
    } else if ch == "," && !inQuotes {
      var j = raw.index(after: idx)
      while j < raw.endIndex && (raw[j] == " " || raw[j] == "\t") { j = raw.index(after: j) }
      var k = j
      while k < raw.endIndex && raw[k] != ";" && raw[k] != "," { k = raw.index(after: k) }
      if startsWithCookiePair(raw[j..<k]) {
        let piece = raw[start..<idx].trimmingCharacters(in: .whitespacesAndNewlines)
        if !piece.isEmpty { result.append(piece) }
        start = raw.index(after: idx)
      }
    }
    idx = raw.index(after: idx)
  }
  let tail = raw[start..<raw.endIndex].trimmingCharacters(in: .whitespacesAndNewlines)
  if !tail.isEmpty { result.append(tail) }
  return result
}

private func utcEpochSeconds(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int) -> TimeInterval? {
  guard (1...12).contains(month), (1...31).contains(day),
        (0...23).contains(hour), (0...59).contains(minute), (0...59).contains(second) else { return nil }
  let y = month <= 2 ? year - 1 : year
  let era = (y >= 0 ? y : y - 399) / 400
  let yoe = y - era * 400
  let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
  let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
  let days = Int64(era) * 146_097 + Int64(doe) - 719_468
  return TimeInterval(days * 86_400 + Int64(hour) * 3_600 + Int64(minute) * 60 + Int64(second))
}

private func expandTwoDigitYear(_ y: Int) -> Int {
  (0...69).contains(y) ? 2000 + y : ((70...99).contains(y) ? 1900 + y : y)
}

private func parseTimeComponents(_ token: String) -> (Int, Int, Int)? {
  let p = token.split(separator: ":", omittingEmptySubsequences: false)
  guard p.count == 3, let h = Int(p[0]), let m = Int(p[1]), let s = Int(p[2]) else { return nil }
  return (h, m, s)
}

/// Parses RFC 7231 IMF-fixdate, RFC 850, and ANSI C asctime HTTP dates to UTC Unix seconds.
public func parseHttpDate(_ raw: String) -> TimeInterval? {
  let tokens = raw.replacingOccurrences(of: ",", with: " ").split(whereSeparator: { $0 == " " || $0 == "\t" }).map(String.init)
  guard tokens.count >= 4 else { return nil }
  let start = (tokens[0].count >= 3 && tokens[0].first?.isLetter == true && httpDateMonths[tokens[0].lowercased()] == nil) ? 1 : 0
  guard tokens.count - start >= 4 else { return nil }
  let (t0, t1, t2, t3) = (tokens[start], tokens[start + 1], tokens[start + 2], tokens[start + 3])

  let rfc850 = t0.split(separator: "-")
  if rfc850.count == 3, let d = Int(rfc850[0]), let m = httpDateMonths[String(rfc850[1]).lowercased()],
     let y = Int(rfc850[2]), let (h, mi, s) = parseTimeComponents(t1) {
    return utcEpochSeconds(year: expandTwoDigitYear(y), month: m, day: d, hour: h, minute: mi, second: s)
  }
  if let d = Int(t0), let m = httpDateMonths[t1.lowercased()], let y = Int(t2), let (h, mi, s) = parseTimeComponents(t3) {
    return utcEpochSeconds(year: expandTwoDigitYear(y), month: m, day: d, hour: h, minute: mi, second: s)
  }
  if let m = httpDateMonths[t0.lowercased()], let d = Int(t1), let (h, mi, s) = parseTimeComponents(t2), let y = Int(t3) {
    return utcEpochSeconds(year: expandTwoDigitYear(y), month: m, day: d, hour: h, minute: mi, second: s)
  }
  return nil
}

/// Bounded, in-memory, exact-origin RFC 6265 cookie jar (#171).
public final class OriginCookieJar: @unchecked Sendable {
  private let lock = NSLock()
  private let cap: Int
  private let now: @Sendable () -> Date
  private var entries: [CookieKey: StoredCookie] = [:]
  private var insertionOrder: [CookieKey] = []
  private var seq: UInt64 = 0

  public init(maxCookies: Int = 128, now: @escaping @Sendable () -> Date = { Date() }) {
    self.cap = max(1, maxCookies)
    self.now = now
  }

  public var count: Int { lock.withLock { entries.count } }

  public func clear() {
    lock.withLock {
      entries.removeAll()
      insertionOrder.removeAll()
    }
  }

  public func store(url: URL, setCookieHeader: String) {
    store(url: url, setCookieHeaders: splitSetCookieHeader(setCookieHeader))
  }

  public func store(url: URL, setCookieHeaders: [String]) {
    guard !setCookieHeaders.isEmpty, let origin = StreamOrigin(url: url) else { return }
    let defPath = defaultCookiePath(for: url)
    let nowSec = now().timeIntervalSince1970
    lock.withLock {
      for raw in setCookieHeaders where !raw.isEmpty {
        storeOneLocked(origin: origin, defaultPath: defPath, rawHeader: raw, nowSec: nowSec)
      }
    }
  }

  public func header(for url: URL) -> String? {
    guard let origin = StreamOrigin(url: url) else { return nil }
    let isHttps = origin.scheme == "https"
    let reqPath = normalizedRequestPath(for: url)
    let nowSec = now().timeIntervalSince1970
    return lock.withLock {
      purgeExpiredLocked(nowSec: nowSec)
      let matched = entries.values
        .filter { $0.origin == origin && (!$0.secure || isHttps) && cookiePathMatches(requestPath: reqPath, cookiePath: $0.path) }
        .sorted { $0.path.count != $1.path.count ? $0.path.count > $1.path.count : $0.createdAt < $1.createdAt }
      return matched.isEmpty ? nil : matched.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
    }
  }

  private func storeOneLocked(origin: StreamOrigin, defaultPath: String, rawHeader: String, nowSec: TimeInterval) {
    let parts = rawHeader.split(separator: ";", omittingEmptySubsequences: false)
    guard let first = parts.first, let eqIdx = first.firstIndex(of: "="),
          let name = sanitizeHeaderName(String(first[..<eqIdx])) else { return }
    let value = sanitizeHeaderValue(String(first[first.index(after: eqIdx)...]))
    var path = defaultPath
    var secure = false
    var hasMaxAge = false
    var maxAgeExpiresAt: TimeInterval?
    var expiresHeaderAt: TimeInterval?

    for attrSub in parts.dropFirst() {
      let attr = attrSub.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !attr.isEmpty else { continue }
      let attrEq = attr.firstIndex(of: "=")
      let attrName = (attrEq.map { String(attr[..<$0]) } ?? attr).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
      let attrVal = attrEq.map { attr[attr.index(after: $0)...].trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
      switch attrName {
      case "secure": secure = true
      case "path": path = attrVal.hasPrefix("/") ? attrVal : defaultPath
      case "max-age":
        if isStrictInteger(attrVal) {
          hasMaxAge = true
          if attrVal.first == "-" {
            maxAgeExpiresAt = -TimeInterval.infinity
          } else if let delta = Int64(attrVal) {
            maxAgeExpiresAt = delta <= 0 ? -TimeInterval.infinity : nowSec + TimeInterval(delta)
          } else {
            maxAgeExpiresAt = TimeInterval.greatestFiniteMagnitude
          }
        }
      case "expires": if let parsed = parseHttpDate(attrVal) { expiresHeaderAt = parsed }
      default: break // `Domain` is intentionally ignored to prevent cross-origin widening.
      }
    }

    let expiresAt = hasMaxAge ? maxAgeExpiresAt : expiresHeaderAt
    let key = CookieKey(origin: origin, path: path, name: name)
    if let exp = expiresAt, exp <= nowSec {
      entries.removeValue(forKey: key)
      insertionOrder.removeAll { $0 == key }
      return
    }
    seq &+= 1
    entries[key] = StoredCookie(origin: origin, path: path, name: name, value: value, secure: secure, expiresAt: expiresAt, createdAt: seq)
    insertionOrder.removeAll { $0 == key }
    insertionOrder.append(key)
    if entries.count > cap {
      purgeExpiredLocked(nowSec: nowSec)
      while entries.count > cap, !insertionOrder.isEmpty {
        entries.removeValue(forKey: insertionOrder.removeFirst())
      }
    }
  }

  private func purgeExpiredLocked(nowSec: TimeInterval) {
    let expired = Set(entries.compactMap { key, val in (val.expiresAt.map { $0 <= nowSec } ?? false) ? key : nil })
    guard !expired.isEmpty else { return }
    for key in expired { entries.removeValue(forKey: key) }
    insertionOrder.removeAll { expired.contains($0) }
  }
}

private func isStrictInteger(_ raw: String) -> Bool {
  guard !raw.isEmpty else { return false }
  let start = raw.first == "-" ? raw.index(after: raw.startIndex) : raw.startIndex
  return start < raw.endIndex && raw[start...].allSatisfy { $0.isASCII && $0.isNumber }
}

private func mergeCookieHeader(existing: String?, jarCookie: String) -> String {
  guard let existing, !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return jarCookie }
  let jarNames = Set(jarCookie.split(separator: ";").compactMap { part -> String? in
    guard let eq = part.firstIndex(of: "=") else { return nil }
    return part[..<eq].trimmingCharacters(in: .whitespacesAndNewlines)
  })
  let kept = existing.split(separator: ";").compactMap { part -> String? in
    let trimmed = part.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    if let eq = trimmed.firstIndex(of: "=") {
      let name = trimmed[..<eq].trimmingCharacters(in: .whitespacesAndNewlines)
      if !name.isEmpty && jarNames.contains(name) { return nil }
    }
    return trimmed
  }
  return kept.isEmpty ? jarCookie : "\(kept.joined(separator: "; ")); \(jarCookie)"
}

/// Tracks initial origin, caller-provided `Cookie`, and whether a redirect chain ever left `initialOrigin` (#171).
public struct RedirectScopeState: Sendable {
  public let initialOrigin: StreamOrigin?
  public let callerCookie: String?
  public private(set) var leftOrigin: Bool

  public init(initialOrigin: StreamOrigin?, callerCookie: String?, leftOrigin: Bool = false) {
    self.initialOrigin = initialOrigin
    self.callerCookie = callerCookie
    self.leftOrigin = leftOrigin
  }

  public mutating func noteTarget(_ url: URL?) {
    guard let initialOrigin, let url, let targetOrigin = StreamOrigin(url: url), initialOrigin == targetOrigin else {
      leftOrigin = true
      return
    }
  }
}

/// Applies exact-origin scoping and jar cookies for one request/redirect hop (#171):
/// strips carried `Cookie` headers unconditionally (preventing cross-origin bounce, `Secure` downgrade,
/// path escape, and `Max-Age=0` carry-over), restores `state.callerCookie` only while on `initialOrigin`
/// (`!state.leftOrigin`), strips all sensitive headers once `leftOrigin` latches, and merges `cookieJar.header(for:)`.
public func scopeRedirectRequest(
  _ request: URLRequest,
  state: inout RedirectScopeState,
  response: HTTPURLResponse? = nil,
  cookieJar: OriginCookieJar
) -> URLRequest {
  if let response, let responseUrl = response.url, let rawSetCookie = response.value(forHTTPHeaderField: "Set-Cookie") {
    cookieJar.store(url: responseUrl, setCookieHeader: rawSetCookie)
  }
  state.noteTarget(request.url)
  var copy = request
  if let existing = copy.allHTTPHeaderFields {
    for key in existing.keys {
      let lower = key.lowercased()
      if lower == "cookie" || (state.leftOrigin && sensitiveHeaders.contains(lower)) {
        copy.setValue(nil, forHTTPHeaderField: key)
      }
    }
  }
  copy.setValue(nil, forHTTPHeaderField: "Cookie")
  if state.leftOrigin {
    copy.setValue(nil, forHTTPHeaderField: "Authorization")
    copy.setValue(nil, forHTTPHeaderField: "Proxy-Authorization")
    copy.setValue(nil, forHTTPHeaderField: "X-Api-Key")
    copy.setValue(nil, forHTTPHeaderField: "X-Auth-Token")
  }
  let callerCookie = state.leftOrigin ? nil : state.callerCookie
  let jarCookie = copy.url.flatMap { cookieJar.header(for: $0) }
  if let jarCookie {
    copy.setValue(mergeCookieHeader(existing: callerCookie, jarCookie: jarCookie), forHTTPHeaderField: "Cookie")
  } else if let callerCookie, !callerCookie.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    copy.setValue(callerCookie, forHTTPHeaderField: "Cookie")
  }
  return copy
}

/// Applies exact-origin cookies from `cookieJar` onto `request`, merging with any existing `Cookie` header.
public func applyOriginCookies(to request: URLRequest, cookieJar: OriginCookieJar) -> URLRequest {
  var state = RedirectScopeState(
    initialOrigin: request.url.flatMap(StreamOrigin.init(url:)),
    callerCookie: request.value(forHTTPHeaderField: "Cookie")
  )
  return scopeRedirectRequest(request, state: &state, cookieJar: cookieJar)
}

/// Single-hop wrapper capturing `Set-Cookie` from `response` and scoping `request` against `origin` and `cookieJar`.
public func sanitizeRedirectRequest(
  _ request: URLRequest,
  origin: StreamOrigin?,
  response: HTTPURLResponse,
  cookieJar: OriginCookieJar
) -> URLRequest {
  var state = RedirectScopeState(initialOrigin: origin, callerCookie: request.value(forHTTPHeaderField: "Cookie"))
  return scopeRedirectRequest(request, state: &state, response: response, cookieJar: cookieJar)
}

import Foundation

private let sensitiveHeaders: Set<String> = [
  "authorization",
  "cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
]

private let tokenPunctuation: Set<UInt8> = Set("!#$%&'*+-.^_`|~".utf8)

/// Origin `(scheme, host, effectivePort)` that sensitive stream headers are scoped to.
public struct StreamOrigin: Equatable, Sendable {
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

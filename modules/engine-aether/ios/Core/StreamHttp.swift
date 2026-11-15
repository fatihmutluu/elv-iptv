import Foundation

private let sensitiveHeaders: Set<String> = [
  "authorization",
  "cookie",
  "proxy-authorization",
]

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

/// Strips `Authorization`, `Cookie`, and `Proxy-Authorization` when `targetUrl` leaves `origin`.
public func sanitizeHeaders(
  _ headers: [String: String],
  for targetUrl: URL,
  origin: StreamOrigin?
) -> [String: String] {
  if let origin, let targetOrigin = StreamOrigin(url: targetUrl), origin == targetOrigin {
    return headers
  }
  return headers.filter { key, _ in
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
  return copy
}

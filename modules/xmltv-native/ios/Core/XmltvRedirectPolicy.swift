import Foundation

/// Cross-origin redirect header sanitization helpers for `ElvXmltvNativeModule`.
public enum XmltvRedirectPolicy {
  private static let sensitiveHeaders: Set<String> = [
    "authorization",
    "proxy-authorization",
    "cookie",
  ]

  public static func effectivePort(for url: URL) -> Int? {
    if let port = url.port { return port }
    switch url.scheme?.lowercased() {
    case "https": return 443
    case "http": return 80
    default: return nil
    }
  }

  public static func isSameOrigin(_ a: URL, _ b: URL) -> Bool {
    guard let schemeA = a.scheme?.lowercased(),
          let schemeB = b.scheme?.lowercased(),
          schemeA == schemeB,
          let hostA = a.host?.lowercased(),
          let hostB = b.host?.lowercased(),
          hostA == hostB else {
      return false
    }
    return effectivePort(for: a) == effectivePort(for: b)
  }

  /// Strips sensitive auth and cookie headers when the redirect target origin differs from `originalUrl`.
  public static func sanitizedRedirectRequest(originalUrl: URL, newRequest: URLRequest) -> URLRequest {
    guard let targetUrl = newRequest.url, !isSameOrigin(originalUrl, targetUrl) else {
      return newRequest
    }
    var sanitized = newRequest
    sanitized.httpShouldHandleCookies = false
    if let existing = sanitized.allHTTPHeaderFields {
      for key in existing.keys where sensitiveHeaders.contains(key.lowercased()) {
        sanitized.setValue(nil, forHTTPHeaderField: key)
      }
    }
    for header in ["Authorization", "Proxy-Authorization", "Cookie"] {
      sanitized.setValue(nil, forHTTPHeaderField: header)
    }
    return sanitized
  }
}

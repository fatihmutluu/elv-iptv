import ElvAetherCore
import Foundation
import Testing

@Suite("StreamHttp")
struct StreamHttpTests {
  @Test("keeps sensitive headers on same origin including default ports")
  func keepsSameOrigin() throws {
    let originUrl = try #require(URL(string: "http://Provider.Example/live/demo/demo/1001.ts"))
    let sameDefaultPort = try #require(URL(string: "http://provider.example:80/live/demo/demo/1002.ts"))
    let origin = try #require(StreamOrigin(url: originUrl))
    let headers = [
      "Authorization": "Bearer secret-token",
      "Cookie": "sid=secret-cookie",
      "Proxy-Authorization": "Basic c2VjcmV0",
      "X-Api-Key": "secret-key",
      "User-Agent": "Provider/1.0",
    ]
    let sanitized = sanitizeHeaders(headers, for: sameDefaultPort, origin: origin)
    #expect(sanitized == headers)
  }

  @Test("strips sensitive headers on cross-host or port redirects")
  func stripsCrossHostAndPort() throws {
    let originUrl = try #require(URL(string: "http://127.0.0.1:8080/live/demo/demo/1001.ts"))
    let origin = try #require(StreamOrigin(url: originUrl))
    let headers = [
      "authorization": "Bearer secret-token",
      "Cookie": "sid=secret-cookie",
      "Proxy-Authorization": "Basic c2VjcmV0",
      "X-Auth-Token": "tok-123",
      "User-Agent": "Provider/1.0",
      "Referer": "http://panel.example/",
    ]

    let crossHost = try #require(URL(string: "http://cdn.example:8080/seg.ts"))
    let strippedHost = sanitizeHeaders(headers, for: crossHost, origin: origin)
    #expect(strippedHost == ["User-Agent": "Provider/1.0", "Referer": "http://panel.example/"])

    let crossPort = try #require(URL(string: "http://127.0.0.1:9090/seg.ts"))
    let strippedPort = sanitizeHeaders(headers, for: crossPort, origin: origin)
    #expect(strippedPort == ["User-Agent": "Provider/1.0", "Referer": "http://panel.example/"])
  }

  @Test("strips sensitive headers on https to http downgrade")
  func stripsSchemeDowngrade() throws {
    let originUrl = try #require(URL(string: "https://provider.example:8443/live/1.m3u8"))
    let downgradeUrl = try #require(URL(string: "http://provider.example:8443/seg1.ts"))
    let origin = try #require(StreamOrigin(url: originUrl))

    var redirect = URLRequest(url: downgradeUrl)
    redirect.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
    redirect.setValue("sid=1", forHTTPHeaderField: "Cookie")
    redirect.setValue("Basic xyz", forHTTPHeaderField: "Proxy-Authorization")
    redirect.setValue("secret", forHTTPHeaderField: "X-Api-Key")
    redirect.setValue("Provider/1.0", forHTTPHeaderField: "User-Agent")

    let cleaned = sanitizeRedirectRequest(redirect, origin: origin)
    #expect(cleaned.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(cleaned.value(forHTTPHeaderField: "Cookie") == nil)
    #expect(cleaned.value(forHTTPHeaderField: "Proxy-Authorization") == nil)
    #expect(cleaned.value(forHTTPHeaderField: "X-Api-Key") == nil)
    #expect(cleaned.value(forHTTPHeaderField: "User-Agent") == "Provider/1.0")
  }

  @Test("sanitizeRequestHeaders strips CRLF/NUL control chars and drops invalid or empty header names")
  func stripsControlCharsAndInvalidHeaderNames() {
    let raw: [String: String] = [
      "User-Agent": "Player/1.0\r\nX-Injected: evil\0",
      "  Referer  ": "  http://panel.example/live\n  ",
      "": "ignored",
      "Bad Name": "ignored",
      "Bad:Name": "ignored",
      "Header\r\nInject": "ignored",
      "Empty-After-Clean": "\r\n\0   ",
    ]
    let cleaned = sanitizeRequestHeaders(raw)
    #expect(
      cleaned == [
        "User-Agent": "Player/1.0X-Injected: evil",
        "Referer": "http://panel.example/live",
      ]
    )
  }
}

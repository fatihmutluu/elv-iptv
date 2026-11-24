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

  @Test("OriginCookieJar enforces exact origin, path matching, Secure guard, Max-Age precedence, and bounded eviction (#171)")
  func originCookieJarContract() throws {
    final class MutableClock: @unchecked Sendable {
      private let lock = NSLock()
      private var date: Date
      init(_ epoch: TimeInterval) { self.date = Date(timeIntervalSince1970: epoch) }
      func now() -> Date { lock.withLock { date } }
      func set(_ epoch: TimeInterval) { lock.withLock { date = Date(timeIntervalSince1970: epoch) } }
    }

    let clock = MutableClock(1_790_812_800) // 2026-10-01T00:00:00Z
    let jar = OriginCookieJar(maxCookies: 3, now: { clock.now() })
    let baseUrl = try #require(URL(string: "https://panel.example:443/live/hd/index.m3u8"))

    jar.store(
      url: baseUrl,
      setCookieHeader:
        "sid=abc; Domain=.example; Path=/; Secure, hd=1, exp=ok; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/live"
    )

    let hdSeg = try #require(URL(string: "https://panel.example/live/hd/seg1.ts"))
    let sdSeg = try #require(URL(string: "https://panel.example/live/sd/seg1.ts"))
    let otherPrefix = try #require(URL(string: "https://panel.example/live2/seg1.ts"))
    #expect(jar.header(for: hdSeg) == "hd=1; exp=ok; sid=abc")
    #expect(jar.header(for: sdSeg) == "exp=ok; sid=abc")
    #expect(jar.header(for: otherPrefix) == "sid=abc")

    // Exact-origin isolation: subdomain, port change, scheme downgrade never echo
    #expect(jar.header(for: try #require(URL(string: "https://cdn.panel.example/live/hd/seg1.ts"))) == nil)
    #expect(jar.header(for: try #require(URL(string: "https://panel.example:8443/live/hd/seg1.ts"))) == nil)
    #expect(jar.header(for: try #require(URL(string: "http://panel.example/live/hd/seg1.ts"))) == nil)

    // Bounded cap evicts oldest (sid)
    jar.store(url: baseUrl, setCookieHeader: "extra=4; Path=/")
    #expect(jar.count == 3)
    #expect(jar.header(for: hdSeg) == "hd=1; exp=ok; extra=4")

    // Max-Age=0 wins over future Expires and deletes immediately
    jar.store(
      url: baseUrl,
      setCookieHeader: "exp=gone; Path=/live; Max-Age=0; Expires=Wed, 21 Oct 2030 07:28:00 GMT"
    )
    #expect(jar.header(for: hdSeg) == "hd=1; extra=4")

    // Secure cookie over http:// is never emitted
    let httpJar = OriginCookieJar(now: { clock.now() })
    let httpUrl = try #require(URL(string: "http://panel.example/live/1"))
    httpJar.store(url: httpUrl, setCookieHeaders: ["sec=no; Path=/; Secure", "plain=yes; Path=/"])
    #expect(httpJar.header(for: try #require(URL(string: "http://panel.example/live/2"))) == "plain=yes")

    // Expires drops cookie when clock advances
    let expJar = OriginCookieJar(now: { clock.now() })
    expJar.store(url: baseUrl, setCookieHeader: "dated=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT")
    #expect(expJar.header(for: hdSeg) == "dated=1")
    let expEpoch = try #require(parseHttpDate("Wed, 21 Oct 2026 07:28:00 GMT"))
    clock.set(expEpoch)
    #expect(expJar.header(for: hdSeg) == nil)
  }

  @Test("sanitizeRedirectRequest captures 302 Set-Cookie, merges same-origin Cookie, and strips cross-origin credentials (#171)")
  func redirectCapturesAndScopesCookies() throws {
    let jar = OriginCookieJar()
    let originUrl = try #require(URL(string: "https://origin.example/live/start"))
    let sameOriginNext = try #require(URL(string: "https://origin.example/live/seg1.ts"))
    let crossOriginNext = try #require(URL(string: "https://cdn.example/live/seg1.ts"))
    let origin = try #require(StreamOrigin(url: originUrl))

    let redirectResp = try #require(
      HTTPURLResponse(
        url: originUrl,
        statusCode: 302,
        httpVersion: "HTTP/1.1",
        headerFields: [
          "Location": sameOriginNext.absoluteString,
          "Set-Cookie": "edge=tok1; Path=/live; Secure, sid=updated; Path=/; Domain=.example",
        ]
      )
    )

    var sameReq = URLRequest(url: sameOriginNext)
    sameReq.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
    sameReq.setValue("caller=keep; sid=old", forHTTPHeaderField: "Cookie")
    let sameOut = sanitizeRedirectRequest(sameReq, origin: origin, response: redirectResp, cookieJar: jar)
    #expect(sameOut.value(forHTTPHeaderField: "Authorization") == "Bearer secret")
    #expect(sameOut.value(forHTTPHeaderField: "Cookie") == "caller=keep; edge=tok1; sid=updated")

    var crossReq = URLRequest(url: crossOriginNext)
    crossReq.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
    crossReq.setValue("caller=keep", forHTTPHeaderField: "Cookie")
    crossReq.setValue("ELV/1.0", forHTTPHeaderField: "User-Agent")
    let crossOut = sanitizeRedirectRequest(crossReq, origin: origin, response: redirectResp, cookieJar: jar)
    #expect(crossOut.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(crossOut.value(forHTTPHeaderField: "Cookie") == nil)
    #expect(crossOut.value(forHTTPHeaderField: "User-Agent") == "ELV/1.0")
  }

  @Test("OriginCookieJar clamps >Int64.max Max-Age digit strings per RFC 6265 §5.2.2 (#171)")
  func clampsHugeMaxAge() throws {
    let jar = OriginCookieJar()
    let url = try #require(URL(string: "https://panel.example/live/1"))
    jar.store(
      url: url,
      setCookieHeaders: [
        "intmax=ok; Path=/; Max-Age=\(Int64.max)",
        "over64=ok; Path=/; Max-Age=999999999999999999999999999999",
        "negover64=drop; Path=/; Max-Age=-999999999999999999999999999999",
      ]
    )
    #expect(jar.header(for: url) == "intmax=ok; over64=ok")
  }

  @Test("scopeRedirectRequest prevents cross-origin bounce, Secure downgrade, path escape, and Max-Age=0 leaks (#171)")
  func multiHopRedirectCookieIsolation() throws {
    let jar = OriginCookieJar()
    let aSecret = try #require(URL(string: "https://origin.example/secret/start"))
    let aSecret2 = try #require(URL(string: "https://origin.example/secret/step2"))
    let aPublic = try #require(URL(string: "https://origin.example/public/step3"))
    let bHop1 = try #require(URL(string: "https://cdn.example/hop1"))
    let bHop2 = try #require(URL(string: "https://cdn.example/hop2"))
    let aBounce = try #require(URL(string: "https://origin.example/final"))

    var state = RedirectScopeState(initialOrigin: StreamOrigin(url: aSecret), callerCookie: "caller=keep")

    // Hop 1: A/secret/start -> A/secret/step2 sets Path=/secret + del=1
    let r1 = try #require(HTTPURLResponse(
      url: aSecret, statusCode: 302, httpVersion: "HTTP/1.1",
      headerFields: ["Set-Cookie": "sec_p=1; Path=/secret, del=1; Path=/"]
    ))
    var req1 = URLRequest(url: aSecret2)
    req1.setValue("Bearer secret", forHTTPHeaderField: "Authorization")
    req1.setValue("caller=keep", forHTTPHeaderField: "Cookie")
    let out1 = scopeRedirectRequest(req1, state: &state, response: r1, cookieJar: jar)
    #expect(out1.value(forHTTPHeaderField: "Cookie") == "caller=keep; sec_p=1; del=1")

    // Hop 2: A/secret/step2 -> A/public/step3 deletes del via Max-Age=0; URLSession carries out1's Cookie!
    let r2 = try #require(HTTPURLResponse(
      url: aSecret2, statusCode: 302, httpVersion: "HTTP/1.1",
      headerFields: ["Set-Cookie": "del=; Path=/; Max-Age=0"]
    ))
    var req2 = out1
    req2.url = aPublic
    let out2 = scopeRedirectRequest(req2, state: &state, response: r2, cookieJar: jar)
    // sec_p=1 (Path=/secret) must NOT leak to /public; del=1 (Max-Age=0) must be GONE; caller=keep stays
    #expect(out2.value(forHTTPHeaderField: "Cookie") == "caller=keep")
    #expect(out2.value(forHTTPHeaderField: "Authorization") == "Bearer secret")

    // Hop 3: A/public/step3 -> B/hop1 (cross-origin)
    var req3 = out2
    req3.url = bHop1
    let out3 = scopeRedirectRequest(req3, state: &state, cookieJar: jar)
    #expect(out3.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(out3.value(forHTTPHeaderField: "Cookie") == nil)

    // Hop 4: B/hop1 -> B/hop2 sets cdn_tok=99
    let r4 = try #require(HTTPURLResponse(
      url: bHop1, statusCode: 302, httpVersion: "HTTP/1.1",
      headerFields: ["Set-Cookie": "cdn_tok=99; Path=/"]
    ))
    var req4 = out3
    req4.url = bHop2
    let out4 = scopeRedirectRequest(req4, state: &state, response: r4, cookieJar: jar)
    #expect(out4.value(forHTTPHeaderField: "Cookie") == "cdn_tok=99")

    // Hop 5: B/hop2 -> A/final (bounce back to A carrying out4's Cookie: cdn_tok=99!)
    var req5 = out4
    req5.url = aBounce
    let out5 = scopeRedirectRequest(req5, state: &state, cookieJar: jar)
    #expect(out5.value(forHTTPHeaderField: "Cookie") == nil)
    #expect(out5.value(forHTTPHeaderField: "Authorization") == nil)

    // Secure downgrade chain: http://A -> https://A (Secure cookie) -> https://A -> http://A
    let secJar = OriginCookieJar()
    let httpStart = try #require(URL(string: "http://panel.example/start"))
    let httpsStep1 = try #require(URL(string: "https://panel.example/s1"))
    let httpsStep2 = try #require(URL(string: "https://panel.example/s2"))
    let httpEnd = try #require(URL(string: "http://panel.example/end"))
    var secState = RedirectScopeState(initialOrigin: StreamOrigin(url: httpStart), callerCookie: "caller=1")
    let rs = try #require(HTTPURLResponse(
      url: httpsStep1, statusCode: 302, httpVersion: "HTTP/1.1",
      headerFields: ["Set-Cookie": "sec=topsecret; Path=/; Secure"]
    ))
    var secReq1 = URLRequest(url: httpsStep2)
    secReq1.setValue("caller=1", forHTTPHeaderField: "Cookie")
    let secOut1 = scopeRedirectRequest(secReq1, state: &secState, response: rs, cookieJar: secJar)
    #expect(secOut1.value(forHTTPHeaderField: "Cookie") == "sec=topsecret")

    // Downgrade redirect back to http:// carrying secOut1's Cookie: sec=topsecret
    var secReq2 = secOut1
    secReq2.url = httpEnd
    let secOut2 = scopeRedirectRequest(secReq2, state: &secState, cookieJar: secJar)
    #expect(secOut2.value(forHTTPHeaderField: "Cookie") == nil)
  }

  @Test("makeStreamSessionConfiguration keeps modern TLS by default and enables TLS 1.0 only on explicit opt-in (#182)")
  func legacyTlsSessionConfigurationIsOptIn() {
    let modern = makeStreamSessionConfiguration()
    let legacy = makeStreamSessionConfiguration(allowLegacyTls: true)

    #expect(modern.httpMaximumConnectionsPerHost == 1)
    #expect(legacy.httpMaximumConnectionsPerHost == 1)
    #expect(modern.urlCache == nil)
    #expect(legacy.urlCache == nil)
    #if canImport(Darwin)
    #expect(modern.tlsMinimumSupportedProtocolVersion != .TLSv10)
    #expect(legacy.tlsMinimumSupportedProtocolVersion == .TLSv10)
    #endif
  }

  @Test("StreamHttp.subtitleSessionConfiguration isolates cookies, cache, and additional headers (#308)")
  func subtitleSessionConfigurationIsIsolated() {
    let config = StreamHttp.subtitleSessionConfiguration(
      headers: ["Authorization": "Bearer sub-token"],
      allowLegacyTls: false
    )
    #expect(config.httpShouldSetCookies == false)
    #expect(config.httpCookieStorage == nil)
    #expect(config.urlCache == nil)
    #expect(config.httpAdditionalHeaders == nil)
    #expect(config.requestCachePolicy == .reloadIgnoringLocalCacheData)
    #if canImport(Darwin)
    #expect(config.tlsMinimumSupportedProtocolVersion != .TLSv10)
    #endif

    let legacyConfig = StreamHttp.subtitleSessionConfiguration(allowLegacyTls: true)
    #expect(legacyConfig.httpAdditionalHeaders == nil)
    #expect(legacyConfig.httpCookieStorage == nil)
    #if canImport(Darwin)
    #expect(legacyConfig.tlsMinimumSupportedProtocolVersion == .TLSv10)
    #endif

    let session = StreamHttp.makeSubtitleSession(headers: ["X-Custom": "1"])
    defer { session.invalidateAndCancel() }
    #expect(session.configuration.httpShouldSetCookies == false)
    #expect(session.configuration.httpCookieStorage == nil)
    #expect(session.configuration.urlCache == nil)
    #expect(session.configuration.httpAdditionalHeaders == nil)
  }

  @Test("StreamHttp.makeSubtitleRequest scopes only explicit subtitle headers and strips credentials on cross-origin redirect (#308)")
  func subtitleRequestAndRedirectIsolation() throws {
    let subUrl = try #require(URL(string: "https://subs.example/en.srt"))
    let sameOriginRedirect = try #require(URL(string: "https://subs.example/cdn/en.srt"))
    let crossOriginRedirect = try #require(URL(string: "https://other-cdn.example/en.srt"))
    let fileRedirect = try #require(URL(string: "file:///etc/passwd"))

    // Empty subtitle headers must never inject any default Authorization/Cookie header.
    let plainReq = StreamHttp.makeSubtitleRequest(url: subUrl, headers: [:])
    #expect(plainReq.httpShouldHandleCookies == false)
    #expect(plainReq.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(plainReq.value(forHTTPHeaderField: "Cookie") == nil)
    #expect((plainReq.allHTTPHeaderFields ?? [:]).isEmpty)

    // Scoped headers stay on same-origin redirects and are stripped on cross-origin redirects.
    let scopedReq = StreamHttp.makeSubtitleRequest(
      url: subUrl,
      headers: [
        "Authorization": "Bearer sub-only",
        "Cookie": "sub_sid=1",
        "X-Sub-Header": "ok\r\nEvil: 1",
      ]
    )
    #expect(scopedReq.value(forHTTPHeaderField: "Authorization") == "Bearer sub-only")
    #expect(scopedReq.value(forHTTPHeaderField: "Cookie") == "sub_sid=1")
    #expect(scopedReq.value(forHTTPHeaderField: "X-Sub-Header") == "okEvil: 1")

    let initialOrigin = try #require(StreamOrigin(url: subUrl))
    var leftOrigin = false

    var sameReq = scopedReq
    sameReq.url = sameOriginRedirect
    let sameScoped = try #require(
      IsolatedSubtitleRedirectDelegate.scopeSubtitleRedirect(sameReq, initialOrigin: initialOrigin, leftOrigin: &leftOrigin)
    )
    #expect(leftOrigin == false)
    #expect(sameScoped.value(forHTTPHeaderField: "Authorization") == "Bearer sub-only")
    #expect(sameScoped.value(forHTTPHeaderField: "Cookie") == "sub_sid=1")

    var crossReq = sameScoped
    crossReq.url = crossOriginRedirect
    let crossScoped = try #require(
      IsolatedSubtitleRedirectDelegate.scopeSubtitleRedirect(crossReq, initialOrigin: initialOrigin, leftOrigin: &leftOrigin)
    )
    #expect(leftOrigin == true)
    #expect(crossScoped.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(crossScoped.value(forHTTPHeaderField: "Cookie") == nil)
    #expect(crossScoped.value(forHTTPHeaderField: "X-Sub-Header") == "okEvil: 1")

    // Bounce back to initial origin after leaving must remain stripped.
    var bounceReq = sameScoped
    bounceReq.url = subUrl
    let bounceScoped = try #require(
      IsolatedSubtitleRedirectDelegate.scopeSubtitleRedirect(bounceReq, initialOrigin: initialOrigin, leftOrigin: &leftOrigin)
    )
    #expect(bounceScoped.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(bounceScoped.value(forHTTPHeaderField: "Cookie") == nil)

    // Non-HTTP(S) redirect targets are rejected outright.
    let badSchemeReq = URLRequest(url: fileRedirect)
    #expect(
      IsolatedSubtitleRedirectDelegate.scopeSubtitleRedirect(badSchemeReq, initialOrigin: initialOrigin, leftOrigin: &leftOrigin) == nil
    )
  }
}

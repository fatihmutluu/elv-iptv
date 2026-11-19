import ElvAetherCore
import Testing

@Suite("UrlRedaction")
struct RedactionTests {
  @Test("uses strict allowlist redaction: keeps scheme, host(:port) and safe final extension only")
  func strictAllowlistMasksAllPathSegments() {
    #expect(redactUrl("http://h/live/u/p/1.ts?token=x") == "http://h/***/***/***/***.ts")
    #expect(redactUrl("http://user:pw@h:8080/movie/u/p/5.mp4#t=10") == "http://h:8080/***/***/***/***.mp4")
    #expect(redactUrl("https://h/series/u/p/9.mkv?q=1") == "https://h/***/***/***/***.mkv")
    #expect(
      redactUrl("http://h/timeshift/u/p/60/2026-11-14:10-00/7.ts")
        == "http://h/***/***/***/***/***/***.ts"
    )
    #expect(redactUrl("http://h/panel/LIVE/u/p/3.m3u8") == "http://h/***/***/***/***/***.m3u8")
    #expect(redactUrl("https://cdn.example/hls/token123/seg.ts") == "https://cdn.example/***/***/***.ts")
    #expect(redactUrl("http://h/playlists/demo.m3u?x=1") == "http://h/***/***.m3u")
  }

  @Test("masks double-slash paths and strips matrix parameters without leaking credentials")
  func doubleSlashesAndMatrixParameters() {
    #expect(redactUrl("http://h/live//user/pass/1.ts") == "http://h/***/ /***/***/***.ts".replacingOccurrences(of: " ", with: ""))
    #expect(redactUrl("http://h/live/u/p/stream.m3u8;token=secret?x=1") == "http://h/***/***/***/***.m3u8")
    #expect(redactUrl("http://h/play/tok123;jsessionid=abc/1.ts;sig=xyz") == "http://h/***/***/***.ts")
    #expect(redactUrl("http://h/;token=secret") == "http://h/***")
    #expect(redactUrl("http://user:p;ass@h:8080;sid=1/live/1.ts") == "http://h:8080/***/***.ts")
    #expect(redactUrl("http://u:p@[2001:db8::1]:8080/live/u/p/1.ts") == "http://[2001:db8::1]:8080/***/***/***/***.ts")
  }

  @Test("masks extensionless segments, bare Xtream IDs, and JWT-like dotted tokens")
  func masksExtensionlessAndJwtTokens() {
    #expect(redactUrl("http://h/u/p/1001") == "http://h/***/***/***")
    #expect(redactUrl("http://h/play/AbC123tok") == "http://h/***/***")
    #expect(redactUrl("http://h/a/b/") == "http://h/***/***/")
    #expect(
      redactUrl("https://cdn.example.com/play/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_part_here")
        == "https://cdn.example.com/***/***"
    )
  }

  @Test("handles non-HTTP schemes, bare origins, and scheme-less paths")
  func nonHttpBareOriginsAndRelativePaths() {
    #expect(redactUrl("tls://u:p@stream.example.com:443/secret/1.ts?auth=9") == "tls://stream.example.com:443/***/***.ts")
    #expect(redactUrl("rtsp://admin:secret@cam.local:554/h264Preview_01_main") == "rtsp://cam.local:554/***")
    #expect(redactUrl("rtmp://ingest.local/live/secret_stream_key") == "rtmp://ingest.local/***/***")
    #expect(redactUrl("tcp://127.0.0.1:7878") == "tcp://127.0.0.1:7878")
    #expect(redactUrl("http://h") == "http://h")
    #expect(redactUrl("http://h/") == "http://h/")
    #expect(redactUrl("/live/u/p/1.ts?password=p") == "/***/***/***/***.ts")
    #expect(redactUrl("") == "")
  }
}

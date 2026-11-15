import ElvAetherCore
import Testing

@Suite("UrlRedaction")
struct RedactionTests {
  @Test("live credentials and the query are removed")
  func liveCredentialsAndQuery() {
    #expect(redactUrl("http://h/live/u/p/1.ts?token=x") == "http://h/live/***/***/1.ts")
  }

  @Test("user-info, port and fragment are handled")
  func userInfoPortAndFragment() {
    #expect(
      redactUrl("http://user:pw@h:8080/movie/u/p/5.mp4#t=10") == "http://h:8080/movie/***/***/5.mp4"
    )
  }

  @Test("series and timeshift paths hide user and password only")
  func seriesAndTimeshift() {
    #expect(redactUrl("https://h/series/u/p/9.mkv") == "https://h/series/***/***/9.mkv")
    #expect(
      redactUrl("http://h/timeshift/u/p/60/2026-11-14:10-00/7.ts")
        == "http://h/timeshift/***/***/60/2026-11-14:10-00/7.ts"
    )
  }

  @Test("the marker is found after a path prefix and in any case")
  func markerBehindPrefixCaseInsensitive() {
    #expect(redactUrl("http://h/panel/LIVE/u/p/3.m3u8") == "http://h/panel/LIVE/***/***/3.m3u8")
  }

  @Test("a short credential path is still hidden")
  func shortCredentialPath() {
    #expect(redactUrl("http://h/live/u") == "http://h/live/***")
  }

  @Test("the bare Xtream form user, password, id is hidden")
  func bareXtreamForm() {
    #expect(redactUrl("http://h/u/p/1001") == "http://h/***/***/1001")
    #expect(redactUrl("http://h/u/p/1001.ts") == "http://h/***/***/1001.ts")
  }

  @Test("the bare Xtream form behind a path prefix is hidden")
  func bareXtreamBehindPrefix() {
    #expect(redactUrl("http://h/panel/u/p/1001.ts") == "http://h/panel/***/***/1001.ts")
    #expect(redactUrl("http://h/a/b/u/p/1001") == "http://h/a/b/***/***/1001")
  }

  @Test("a play token is hidden")
  func playTokenHidden() {
    #expect(redactUrl("http://h/play/AbC123tok") == "http://h/play/***")
    #expect(redactUrl("http://h/play/AbC123tok/ts") == "http://h/play/***/ts")
    #expect(redactUrl("http://h/panel/Play/AbC123tok/m3u8?x=1") == "http://h/panel/Play/***/m3u8")
  }

  @Test("paths without credential positions stay")
  func nonCredentialPathsStay() {
    #expect(redactUrl("https://cdn.example/hls/abc/seg.ts") == "https://cdn.example/hls/abc/seg.ts")
    #expect(redactUrl("http://h/playlists/demo.m3u?x=1") == "http://h/playlists/demo.m3u")
  }

  @Test("a string without a scheme is redacted as a path")
  func pathWithoutScheme() {
    #expect(redactUrl("/live/u/p/1.ts?password=p") == "/live/***/***/1.ts")
  }
}

package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Test

class UrlRedactionTest {
  @Test
  fun `live credentials and the query are removed`() {
    assertEquals("http://h/live/***/***/1.ts", redactUrl("http://h/live/u/p/1.ts?token=x"))
  }

  @Test
  fun `user-info, port and fragment are handled`() {
    assertEquals(
      "http://h:8080/movie/***/***/5.mp4",
      redactUrl("http://user:pw@h:8080/movie/u/p/5.mp4#t=10"),
    )
  }

  @Test
  fun `series and timeshift paths hide user and password only`() {
    assertEquals("https://h/series/***/***/9.mkv", redactUrl("https://h/series/u/p/9.mkv"))
    assertEquals(
      "http://h/timeshift/***/***/60/2026-11-14:10-00/7.ts",
      redactUrl("http://h/timeshift/u/p/60/2026-11-14:10-00/7.ts"),
    )
  }

  @Test
  fun `the marker is found after a path prefix and in any case`() {
    assertEquals("http://h/panel/LIVE/***/***/3.m3u8", redactUrl("http://h/panel/LIVE/u/p/3.m3u8"))
  }

  @Test
  fun `a short credential path is still hidden`() {
    assertEquals("http://h/live/***", redactUrl("http://h/live/u"))
  }

  @Test
  fun `the bare Xtream form user, password, id is hidden`() {
    assertEquals("http://h/***/***/1001", redactUrl("http://h/u/p/1001"))
    assertEquals("http://h/***/***/1001.ts", redactUrl("http://h/u/p/1001.ts"))
  }

  @Test
  fun `the bare Xtream form behind a path prefix is hidden`() {
    assertEquals("http://h/panel/***/***/1001.ts", redactUrl("http://h/panel/u/p/1001.ts"))
    assertEquals("http://h/a/b/***/***/1001", redactUrl("http://h/a/b/u/p/1001"))
  }

  @Test
  fun `a play token is hidden`() {
    assertEquals("http://h/play/***", redactUrl("http://h/play/AbC123tok"))
    assertEquals("http://h/play/***/ts", redactUrl("http://h/play/AbC123tok/ts"))
    assertEquals("http://h/panel/Play/***/m3u8", redactUrl("http://h/panel/Play/AbC123tok/m3u8?x=1"))
  }

  @Test
  fun `paths without credential positions stay`() {
    assertEquals("https://cdn.example/hls/abc/seg.ts", redactUrl("https://cdn.example/hls/abc/seg.ts"))
    assertEquals("http://h/playlists/demo.m3u", redactUrl("http://h/playlists/demo.m3u?x=1"))
  }

  @Test
  fun `a string without a scheme is redacted as a path`() {
    assertEquals("/live/***/***/1.ts", redactUrl("/live/u/p/1.ts?password=p"))
  }
}

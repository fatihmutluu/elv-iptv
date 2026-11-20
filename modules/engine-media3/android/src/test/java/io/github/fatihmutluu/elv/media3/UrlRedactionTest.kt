package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class UrlRedactionTest {
  @Test
  fun `strict allowlist redaction keeps only scheme, host and safe media extension (#82)`() {
    assertEquals("http://h/***/***/***/***.ts", redactUrl("http://u:p@h/live/u/p/1.ts?token=x#f"))
    assertEquals("http://h:8080/***/***/***/***.mp4", redactUrl("http://user:pw@h:8080/movie/u/p/5.mp4#t=10"))
    assertEquals("https://h/***/***/***/***.mkv", redactUrl("https://h/series/u/p/9.mkv"))
    assertEquals(
      "http://h/***/***/***/***/***/***.ts",
      redactUrl("http://h/timeshift/u/p/60/2026-11-14:10-00/7.ts"),
    )
    assertEquals("http://h/***/***/***.ts", redactUrl("http://h/u/p/1001.ts"))
    assertEquals("http://h/***/***/***", redactUrl("http://h/u/p/1001"))
    assertEquals("http://h/***/***/", redactUrl("http://h/a/b/"))
  }

  @Test
  fun `double slashes, nested markers and redirected CDN segment tokens never leak (#82)`() {
    val doubleSlash = redactUrl("http://h/live//user/password/1001.ts")
    assertFalse(doubleSlash, doubleSlash.contains("user") || doubleSlash.contains("password"))
    assertEquals("http://h/***//***/***/***.ts", doubleSlash)

    val nested = redactUrl("http://h/play/live/user/password/1001.ts")
    assertFalse(nested, nested.contains("user") || nested.contains("password"))
    assertEquals("http://h/***/***/***/***/***.ts", nested)

    val cdnToken = redactUrl("https://cdn.example/hls/tokHeader.payload.sig/seg_001.ts;token=demo?k=v")
    assertFalse(cdnToken, cdnToken.contains("tokHeader") || cdnToken.contains("seg_001") || cdnToken.contains("demo"))
    assertEquals("https://cdn.example/***/***/***.ts", cdnToken)

    val jwtFinal = redactUrl("https://cdn.example/play/tokHeader.tokPayload.sig_part_here")
    assertEquals("https://cdn.example/***/***", jwtFinal)
  }

  @Test
  fun `bare hosts and scheme-less paths are handled safely`() {
    assertEquals("http://h", redactUrl("http://u:p@h?token=abc"))
    assertEquals("http://h/", redactUrl("http://h/?token=abc"))
    assertEquals("/***/***/***/***.ts", redactUrl("/live/u/p/1.ts?password=p"))
    assertEquals("", redactUrl(""))
  }
}

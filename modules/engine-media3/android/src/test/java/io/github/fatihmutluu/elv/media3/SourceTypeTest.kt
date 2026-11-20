package io.github.fatihmutluu.elv.media3

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Test

class SourceTypeTest {
  @After
  fun tearDown() {
    resetHlsUrlCacheForTest()
  }

  @Test
  fun `m3u8 and m3u paths are HLS for live and VOD including matrix params`() {
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/live/u/p/1.m3u8", live = true))
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/live/u/p/1.m3u8;token=abc", live = true))
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/movie/u/p/1.M3U8?token=x", live = false))
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/x/index.m3u", live = true))
  }

  @Test
  fun `ts paths use the TS extractor`() {
    assertEquals(SourceType.TS, sourceTypeFor("http://h/live/u/p/1.ts", live = true))
    assertEquals(SourceType.TS, sourceTypeFor("http://h/timeshift/u/p/60/start/1.ts#x", live = false))
  }

  @Test
  fun `extensionless and dotted-slug or script live URLs default to TS`() {
    assertEquals(SourceType.TS, sourceTypeFor("http://h/u/p/1001", live = true))
    assertEquals(SourceType.TS, sourceTypeFor("http://h/u/p/1001/", live = true))
    assertEquals(SourceType.TS, sourceTypeFor("http://h:8080", live = true))
    assertEquals(SourceType.TS, sourceTypeFor("http://h/live/bbc.one", live = true))
    assertEquals(SourceType.TS, sourceTypeFor("http://h/live/sports.hd", live = true))
    assertEquals(SourceType.TS, sourceTypeFor("http://h/play/stream.php?id=101", live = true))
  }

  @Test
  fun `container files and unknown VOD URLs sniff the container`() {
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://h/movie/u/p/5.mp4", live = false))
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://h/series/u/p/9.mkv", live = false))
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://h/movie/u/p/5", live = false))
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://h/live/u/p/5.mp4", live = true))
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://h/live/u/p/radio.aac", live = true))
  }

  @Test
  fun `a playlist detected in the response or remembered in the LRU cache makes any URL HLS (#122)`() {
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/play/abc", live = true, playlistDetected = true))
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/u/p/1001.ts", live = true, playlistDetected = true))
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/movie/u/p/5", live = false, playlistDetected = true))

    val extensionless = "http://h/live/u/p/2001"
    assertEquals(SourceType.TS, sourceTypeFor(extensionless, live = true))
    rememberHlsUrl("$extensionless#frag")
    assertEquals(SourceType.HLS, sourceTypeFor(extensionless, live = true))

    for (i in 0 until 260) rememberHlsUrl("http://h/live/u/p/ch-$i")
    assertEquals(SourceType.TS, sourceTypeFor(extensionless, live = true))
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/live/u/p/ch-259", live = true))
  }

  @Test
  fun `the query and a dot in the host do not count as an extension`() {
    assertEquals(SourceType.TS, sourceTypeFor("http://provider.example/u/p/7?ext=.mp4", live = true))
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://provider.example/get?x=1.m3u8", live = false))
  }
}

package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Test

class SourceTypeTest {
  @Test
  fun `m3u8 and m3u paths are HLS for live and VOD`() {
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/live/u/p/1.m3u8", live = true))
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/movie/u/p/1.M3U8?token=x", live = false))
    assertEquals(SourceType.HLS, sourceTypeFor("http://h/x/index.m3u", live = true))
  }

  @Test
  fun `ts paths use the TS extractor`() {
    assertEquals(SourceType.TS, sourceTypeFor("http://h/live/u/p/1.ts", live = true))
    assertEquals(SourceType.TS, sourceTypeFor("http://h/timeshift/u/p/60/start/1.ts#x", live = false))
  }

  @Test
  fun `extensionless live URLs default to TS`() {
    assertEquals(SourceType.TS, sourceTypeFor("http://h/u/p/1001", live = true))
    assertEquals(SourceType.TS, sourceTypeFor("http://h/u/p/1001/", live = true))
    assertEquals(SourceType.TS, sourceTypeFor("http://h:8080", live = true))
  }

  @Test
  fun `container files and unknown VOD URLs sniff the container`() {
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://h/movie/u/p/5.mp4", live = false))
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://h/series/u/p/9.mkv", live = false))
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://h/movie/u/p/5", live = false))
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://h/live/u/p/5.mp4", live = true))
  }

  @Test
  fun `the query and a dot in the host do not count as an extension`() {
    assertEquals(SourceType.TS, sourceTypeFor("http://provider.example/u/p/7?ext=.mp4", live = true))
    assertEquals(SourceType.PROGRESSIVE, sourceTypeFor("http://provider.example/get?x=1.m3u8", live = false))
  }
}

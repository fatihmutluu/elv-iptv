package io.github.fatihmutluu.elv.media3

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadRequestTest {
  private val guess = LoadRequest(
    url = "http://h/play/abc",
    headers = mapOf("User-Agent" to "ua"),
    live = true,
    startMs = null,
    softwareAudio = false,
  )

  @Test
  fun `a detected playlist keeps the original URL, so retries follow a fresh redirect`() {
    val detected = guess.asDetectedPlaylist()
    assertEquals(guess.url, detected.url)
    assertEquals(guess.headers, detected.headers)
    assertTrue(detected.playlistDetected)
    assertEquals(guess, detected.copy(playlistDetected = false))
  }

  @Test
  fun `its text carries no URL and no header value`() {
    val secret = guess.copy(
      url = "http://user:pass@h/live/user/pass/1001.ts?token=tk9",
      headers = mapOf("Authorization" to "Bearer s3cret", "Referer" to "http://r/user/pass"),
    )
    val text = secret.toString()
    for (leak in listOf("user", "pass", "tk9", "s3cret", "Bearer", "http", "/live", "Referer")) {
      assertFalse(text, text.contains(leak))
    }
    assertEquals("LoadRequest(live=true, startMs=null, softwareAudio=false, playlistDetected=false, headers=2)", text)

    val withPreset = secret.copy(bufferPreset = BufferPreset.LARGE).toString()
    for (leak in listOf("user", "pass", "tk9", "s3cret", "Bearer", "http", "/live", "Referer")) {
      assertFalse(withPreset, withPreset.contains(leak))
    }
    assertTrue(withPreset.contains("bufferPreset=large"))

    val withSoftwareDecoder = secret.copy(decoderMode = VideoDecoderMode.SOFTWARE).toString()
    for (leak in listOf("user", "pass", "tk9", "s3cret", "Bearer", "http", "/live", "Referer")) {
      assertFalse(withSoftwareDecoder, withSoftwareDecoder.contains(leak))
    }
    assertTrue(withSoftwareDecoder.contains(", decoderMode=software"))

    val withHardwareDecoder = secret.copy(decoderMode = VideoDecoderMode.HARDWARE).toString()
    for (leak in listOf("user", "pass", "tk9", "s3cret", "Bearer", "http", "/live", "Referer")) {
      assertFalse(withHardwareDecoder, withHardwareDecoder.contains(leak))
    }
    assertTrue(withHardwareDecoder.contains(", decoderMode=hardware"))
  }

  @Test
  fun `parseVideoDecoderMode and parseLoadArgs handle auto, hardware, software, whitespace, case and fallback (#411)`() {
    val previousLocale = Locale.getDefault()
    try {
      Locale.setDefault(Locale.forLanguageTag("tr-TR"))
      assertEquals(VideoDecoderMode.AUTO, parseVideoDecoderMode(null))
      assertEquals(VideoDecoderMode.AUTO, parseVideoDecoderMode(""))
      assertEquals(VideoDecoderMode.AUTO, parseVideoDecoderMode("   "))
      assertEquals(VideoDecoderMode.AUTO, parseVideoDecoderMode("auto"))
      assertEquals(VideoDecoderMode.AUTO, parseVideoDecoderMode("AUTO"))
      assertEquals(VideoDecoderMode.AUTO, parseVideoDecoderMode("unknown"))
      assertEquals(VideoDecoderMode.HARDWARE, parseVideoDecoderMode("hardware"))
      assertEquals(VideoDecoderMode.HARDWARE, parseVideoDecoderMode("  HARDWARE  "))
      assertEquals(VideoDecoderMode.HARDWARE, parseVideoDecoderMode("HaRdWaRe"))
      assertEquals(VideoDecoderMode.SOFTWARE, parseVideoDecoderMode("software"))
      assertEquals(VideoDecoderMode.SOFTWARE, parseVideoDecoderMode("\tSoFtWaRe\n"))
    } finally {
      Locale.setDefault(previousLocale)
    }

    val (_, defaultReq) = parseLoadArgs(
      mapOf("attempt" to 1, "url" to "http://h/live/1.ts", "kind" to "live")
    )
    val (_, hwReq) = parseLoadArgs(
      mapOf("attempt" to 2, "url" to "http://h/live/1.ts", "kind" to "live", "decoderMode" to "hardware")
    )
    val (_, swReq) = parseLoadArgs(
      mapOf("attempt" to 3, "url" to "http://h/live/1.ts", "kind" to "live", "decoderMode" to "  SOFTWARE ")
    )
    val (_, invalidReq) = parseLoadArgs(
      mapOf("attempt" to 4, "url" to "http://h/live/1.ts", "kind" to "live", "decoderMode" to 42)
    )
    assertEquals(VideoDecoderMode.AUTO, defaultReq.decoderMode)
    assertEquals(VideoDecoderMode.HARDWARE, hwReq.decoderMode)
    assertEquals(VideoDecoderMode.SOFTWARE, swReq.decoderMode)
    assertEquals(VideoDecoderMode.AUTO, invalidReq.decoderMode)
  }

  @Test
  fun `the source type follows the detection and parseLoadArgs rejects non-finite startMs and parses bufferPreset (#147)`() {
    assertFalse(guess.playlistDetected)
    assertEquals(SourceType.TS, guess.sourceType())
    assertEquals(StreamKind.RAW_TS_LIVE, guess.streamKind())
    assertEquals(SourceType.HLS, guess.asDetectedPlaylist().sourceType())
    assertEquals(StreamKind.HLS_LIVE, guess.asDetectedPlaylist().streamKind())

    val (_, infReq) = parseLoadArgs(
      mapOf("attempt" to 1, "url" to "http://h/1.mp4", "kind" to "vod", "startMs" to Double.POSITIVE_INFINITY)
    )
    val (_, nanReq) = parseLoadArgs(
      mapOf("attempt" to 1, "url" to "http://h/1.mp4", "kind" to "vod", "startMs" to Double.NaN)
    )
    val (_, validReq) = parseLoadArgs(
      mapOf(
        "attempt" to 1,
        "url" to "http://h/1.mp4",
        "kind" to "vod",
        "startMs" to 42_500.0,
        "preferHevcOverDolbyVision" to true,
        "bufferPreset" to "balanced",
      )
    )
    val (_, largeLiveHls) = parseLoadArgs(
      mapOf(
        "attempt" to 2,
        "url" to "http://h/live/1.m3u8",
        "kind" to "live",
        "bufferPreset" to "large",
      )
    )
    assertNull(infReq.startMs)
    assertNull(nanReq.startMs)
    assertFalse(infReq.preferHevcOverDolbyVision)
    assertEquals(BufferPreset.AUTO, infReq.bufferPreset)
    assertEquals(StreamKind.VOD, infReq.streamKind())
    assertEquals(42_500L, validReq.startMs)
    assertTrue(validReq.preferHevcOverDolbyVision)
    assertEquals(BufferPreset.BALANCED, validReq.bufferPreset)
    assertEquals(StreamKind.VOD, validReq.streamKind())
    assertEquals(BufferPreset.LARGE, largeLiveHls.bufferPreset)
    assertEquals(StreamKind.HLS_LIVE, largeLiveHls.streamKind())
  }

  @Test
  fun `isAllowedPlaybackUrl accepts only http and https URLs with a non-empty host`() {
    for (allowed in listOf(
      "http://sim.test/live/demo/pass/1001.ts",
      "https://cdn.example:8443/live/1.m3u8?token=abc",
      "HTTP://SIM.TEST/movie/1.mp4",
      "HTTPS://[::1]:8080/live/1.ts",
      "  https://cdn.example/trimmed.m3u8  ",
    )) {
      assertTrue("expected allowed: $allowed", isAllowedPlaybackUrl(allowed))
    }

    for (disallowed in listOf(
      "",
      "   ",
      "file:///etc/passwd",
      "file://localhost/data/local/tmp/a.ts",
      "content://com.example.provider/secret",
      "data:video/mp4;base64,AAAA",
      "javascript:alert(1)",
      "blob:https://sim.test/uuid",
      "about:blank",
      "ftp://sim.test/stream.ts",
      "rtsp://sim.test:554/stream",
      "http://",
      "http:///path",
      "https:///path",
      "http://\\evil.example/path",
      "https://user:pass@/path",
      "\r\nhttp://sim.test/live/1.ts\r\n",
      "\thttp://sim.test/live/1.ts",
      "http://sim.test/live/1.ts\r\nX-Injected: 1",
      "http://sim.test/live/1.ts\u0000",
    )) {
      assertFalse("expected rejected: $disallowed", isAllowedPlaybackUrl(disallowed))
    }
  }
}

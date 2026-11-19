package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
  }

  @Test
  fun `the source type follows the detection and parseLoadArgs rejects non-finite startMs`() {
    assertFalse(guess.playlistDetected)
    assertEquals(SourceType.TS, guess.sourceType())
    assertEquals(SourceType.HLS, guess.asDetectedPlaylist().sourceType())

    val (_, infReq) = parseLoadArgs(
      mapOf("attempt" to 1, "url" to "http://h/1.mp4", "kind" to "vod", "startMs" to Double.POSITIVE_INFINITY)
    )
    val (_, nanReq) = parseLoadArgs(
      mapOf("attempt" to 1, "url" to "http://h/1.mp4", "kind" to "vod", "startMs" to Double.NaN)
    )
    val (_, validReq) = parseLoadArgs(
      mapOf("attempt" to 1, "url" to "http://h/1.mp4", "kind" to "vod", "startMs" to 42_500.0)
    )
    org.junit.Assert.assertNull(infReq.startMs)
    org.junit.Assert.assertNull(nanReq.startMs)
    assertEquals(42_500L, validReq.startMs)
  }
}

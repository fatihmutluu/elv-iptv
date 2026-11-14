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
  fun `the source type follows the detection`() {
    assertFalse(guess.playlistDetected)
    assertEquals(SourceType.TS, guess.sourceType())
    assertEquals(SourceType.HLS, guess.asDetectedPlaylist().sourceType())
  }
}

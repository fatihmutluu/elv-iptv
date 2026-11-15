package io.github.fatihmutluu.elv.media3

import androidx.media3.common.PlaybackException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorMappingTest {
  private val badStatus = PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS

  @Test
  fun `named HTTP statuses keep their own code`() {
    assertEquals("http-401", mapError(401, "text/plain", badStatus))
    assertEquals("http-403", mapError(403, "text/plain", badStatus))
    assertEquals("http-404", mapError(404, null, badStatus))
    assertEquals("http-429", mapError(429, "text/html", badStatus))
    assertEquals("http-509", mapError(509, "text/plain", badStatus))
  }

  @Test
  fun `other HTTP error statuses are http-other`() {
    assertEquals("http-other", mapError(500, null, badStatus))
    assertEquals("http-other", mapError(503, "text/html", badStatus))
    assertEquals("http-other", mapError(410, null, badStatus))
    assertEquals("http-other", mapError(null, null, badStatus))
  }

  @Test
  fun `a text or HTML body on a successful stream response is the provider's connection notice`() {
    val invalidType = PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE
    assertEquals("connection-limit", mapError(200, "text/html", invalidType))
    assertEquals("connection-limit", mapError(200, "text/plain; charset=utf-8", invalidType))
    assertEquals("connection-limit", mapError(null, "TEXT/HTML", invalidType))
    assertEquals("connection-limit", mapError(null, null, invalidType))
  }

  @Test
  fun `a sniffed provider notice is connection-limit unless an HTTP error status came first`() {
    val unspecified = PlaybackException.ERROR_CODE_IO_UNSPECIFIED
    assertEquals("connection-limit", mapError(null, null, unspecified, notice = true))
    assertEquals("connection-limit", mapError(200, null, unspecified, notice = true, live = true, played = true))
    assertEquals("http-403", mapError(403, null, badStatus, notice = true))
    assertEquals("network", mapError(null, null, unspecified, notice = false))
  }

  @Test
  fun `Media3 network codes are network`() {
    for (code in listOf(
      PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
      PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED,
      PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT,
      PlaybackException.ERROR_CODE_IO_READ_POSITION_OUT_OF_RANGE,
      PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW,
    )) {
      assertEquals("code $code", "network", mapError(null, null, code))
    }
  }

  @Test
  fun `a platform policy block is terminal, so the ladder never retries it`() {
    for (code in listOf(
      PlaybackException.ERROR_CODE_IO_CLEARTEXT_NOT_PERMITTED,
      PlaybackException.ERROR_CODE_IO_NO_PERMISSION,
    )) {
      assertEquals("code $code", "unsupported-format", mapError(null, null, code))
      assertEquals("code $code", "unsupported-format", mapError(null, null, code, live = true, played = true))
    }
  }

  @Test
  fun `Media3 parsing codes are unsupported-format`() {
    for (code in listOf(
      PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
      PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
      PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
      PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED,
    )) {
      assertEquals("code $code", "unsupported-format", mapError(null, null, code))
    }
  }

  @Test
  fun `malformed media is recoverable for live media`() {
    val malformed = listOf(
      PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
      PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
    )
    for (code in malformed) {
      assertEquals("code $code", "network", mapError(null, null, code, live = true, played = false))
      assertEquals("code $code", "network", mapError(null, null, code, live = true, played = true))
    }
  }

  @Test
  fun `malformed VOD is recoverable once it played and terminal before`() {
    val malformed = listOf(
      PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
      PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
    )
    for (code in malformed) {
      assertEquals("code $code", "network", mapError(null, null, code, live = false, played = true))
      assertEquals("code $code", "unsupported-format", mapError(null, null, code, live = false, played = false))
    }
  }

  @Test
  fun `an unsupported container or manifest stays terminal even live and after playing`() {
    for (code in listOf(
      PlaybackException.ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED,
      PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED,
    )) {
      assertEquals("code $code", "unsupported-format", mapError(null, null, code, live = true, played = true))
    }
  }

  @Test
  fun `Media3 decoder, audio output and frame processing codes are decoder`() {
    for (code in listOf(
      PlaybackException.ERROR_CODE_DECODER_INIT_FAILED,
      PlaybackException.ERROR_CODE_DECODING_FAILED,
      PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED,
      PlaybackException.ERROR_CODE_DECODING_RESOURCES_RECLAIMED,
      PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED,
      PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED,
      PlaybackException.ERROR_CODE_VIDEO_FRAME_PROCESSING_FAILED,
    )) {
      assertEquals("code $code", "decoder", mapError(null, null, code))
    }
  }

  @Test
  fun `Media3 DRM codes are drm`() {
    for (code in listOf(
      PlaybackException.ERROR_CODE_DRM_UNSPECIFIED,
      PlaybackException.ERROR_CODE_DRM_LICENSE_ACQUISITION_FAILED,
      PlaybackException.ERROR_CODE_DRM_LICENSE_EXPIRED,
    )) {
      assertEquals("code $code", "drm", mapError(null, null, code))
    }
  }

  @Test
  fun `a player timeout means the engine is wedged`() {
    assertEquals("engine-wedged", mapError(null, null, PlaybackException.ERROR_CODE_TIMEOUT))
  }

  @Test
  fun `everything else is unknown`() {
    assertEquals("unknown", mapError(null, null, PlaybackException.ERROR_CODE_UNSPECIFIED))
    assertEquals("unknown", mapError(null, null, PlaybackException.ERROR_CODE_REMOTE_ERROR))
    assertEquals("unknown", mapError(null, null, PlaybackException.CUSTOM_ERROR_CODE_BASE))
    assertEquals("unknown", mapError(null, null, -2))
  }

  @Test
  fun `progressive streams treat text, HTML and JSON bodies as notices`() {
    assertTrue(isNoticeContentType("text/plain", hls = false))
    assertTrue(isNoticeContentType("text/html; charset=UTF-8", hls = false))
    assertTrue(isNoticeContentType("application/xhtml+xml", hls = false))
    assertTrue(isNoticeContentType("application/json", hls = false))
    assertFalse(isNoticeContentType("video/mp2t", hls = false))
    assertFalse(isNoticeContentType("application/octet-stream", hls = false))
    assertFalse(isNoticeContentType(null, hls = false))
    assertFalse(isNoticeContentType("", hls = false))
  }

  @Test
  fun `HLS accepts plain-text playlists but not HTML or JSON`() {
    assertFalse(isNoticeContentType("text/plain", hls = true))
    assertFalse(isNoticeContentType("application/vnd.apple.mpegurl", hls = true))
    assertFalse(isNoticeContentType("audio/x-mpegurl", hls = true))
    assertTrue(isNoticeContentType("text/html", hls = true))
    assertTrue(isNoticeContentType("application/json", hls = true))
  }

  @Test
  fun `decoder error caused by an invalid surface maps to surface-lost instead of decoder (I6)`() {
    assertEquals(
      "surface-lost",
      mapError(null, null, PlaybackException.ERROR_CODE_DECODING_FAILED, surfaceLost = true),
    )
    assertEquals(
      "surface-lost",
      mapError(null, null, PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, surfaceLost = true),
    )
    assertEquals(
      "decoder",
      mapError(null, null, PlaybackException.ERROR_CODE_DECODING_FAILED, surfaceLost = false),
    )
  }
}

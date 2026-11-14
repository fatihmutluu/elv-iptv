package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponseSniffingTest {
  private fun bytes(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

  private fun classify(contentType: String?, body: ByteArray): ResponseKind =
    classifyResponse(contentType, body, body.size)

  /** Three MPEG-TS packets: sync byte, PID bytes and zero padding. */
  private fun tsPackets(): ByteArray =
    ByteArray(188 * 3).also { packets ->
      for (start in 0 until 3) {
        packets[start * 188] = 0x47
        packets[start * 188 + 1] = 0x40
      }
    }

  @Test
  fun `the content type header is found in any case and the status line key is skipped`() {
    val headers = mapOf<String?, List<String>>(
      null to listOf("HTTP/1.1 200 OK"),
      "content-TYPE" to listOf("text/html; charset=UTF-8", "ignored"),
    )
    assertEquals("text/html; charset=UTF-8", contentTypeOf(headers))
    assertNull(contentTypeOf(mapOf("Server" to listOf("x"))))
  }

  @Test
  fun `mpegurl content types are HLS`() {
    assertTrue(isHlsContentType("application/vnd.apple.mpegurl"))
    assertTrue(isHlsContentType("application/x-mpegURL; charset=utf-8"))
    assertTrue(isHlsContentType("audio/mpegurl"))
    assertTrue(isHlsContentType("AUDIO/X-MPEGURL"))
    assertFalse(isHlsContentType("video/mp2t"))
    assertFalse(isHlsContentType("text/plain"))
    assertFalse(isHlsContentType(null))
  }

  @Test
  fun `an mpegurl content type is HLS whatever the body`() {
    assertEquals(ResponseKind.HLS, classify("application/vnd.apple.mpegurl", ByteArray(0)))
    assertEquals(ResponseKind.HLS, classify("audio/x-mpegurl", bytes("Max connections reached")))
  }

  @Test
  fun `media content types are media without looking at the body`() {
    assertEquals(ResponseKind.MEDIA, classify("video/mp2t", bytes("Max connections reached")))
    assertEquals(ResponseKind.MEDIA, classify("application/octet-stream", bytes("<html>")))
    assertEquals(ResponseKind.MEDIA, classify(null, bytes("Max connections reached")))
  }

  @Test
  fun `MPEG-TS mislabelled as text or HTML is media`() {
    assertEquals(ResponseKind.MEDIA, classify("text/html", tsPackets()))
    assertEquals(ResponseKind.MEDIA, classify("text/plain", tsPackets()))
  }

  @Test
  fun `other binary bodies under a text label are media`() {
    val mp4 = byteArrayOf(0, 0, 0, 0x18) + bytes("ftypmp42") + ByteArray(16)
    assertEquals(ResponseKind.MEDIA, classify("text/plain", mp4))
  }

  @Test
  fun `a playlist under a text label is HLS, also after a byte order mark and blank lines`() {
    assertEquals(ResponseKind.HLS, classify("text/plain", bytes("#EXTM3U\n#EXT-X-VERSION:3\n")))
    val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
    assertEquals(ResponseKind.HLS, classify("text/html", bom + bytes("\r\n  #EXTM3U\r\n")))
  }

  @Test
  fun `a text, HTML or JSON body that is no playlist is the provider notice`() {
    assertEquals(ResponseKind.NOTICE, classify("text/plain", bytes("Max connections reached")))
    assertEquals(ResponseKind.NOTICE, classify("text/html", bytes("<html><body>Limit</body></html>")))
    assertEquals(ResponseKind.NOTICE, classify("application/json", bytes("{\"error\":\"limit\"}")))
    assertEquals(ResponseKind.NOTICE, classify("text/plain", bytes("Bağlantı sınırı aşıldı\r\n")))
  }

  @Test
  fun `an empty text body is left to the player`() {
    assertEquals(ResponseKind.MEDIA, classify("text/html", ByteArray(0)))
  }

  @Test
  fun `only the read part of the prefix buffer counts`() {
    val buffer = bytes("Max connections") + ByteArray(64)
    assertEquals(ResponseKind.NOTICE, classifyResponse("text/plain", buffer, 15))
  }

  @Test
  fun `a playlist body without the EXTM3U header that reads as text is a notice`() {
    assertTrue(isPlaylistNotice(bytes("Max connections reached"), 23))
    assertTrue(isPlaylistNotice(bytes("<html></html>"), 13))
    assertFalse(isPlaylistNotice(bytes("#EXTM3U\n#EXTINF:2,\n1.ts\n"), 24))
    val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
    assertFalse(isPlaylistNotice(bom + bytes("#EXTM3U\n"), 11))
    assertFalse(isPlaylistNotice(ByteArray(0), 0))
    assertFalse(isPlaylistNotice(tsPackets(), 564))
  }
}

package io.github.fatihmutluu.elv.media3

import androidx.media3.common.C
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ResponseSniffingTest {
  private val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())

  private fun bytes(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)

  private fun classify(kind: RequestKind, contentType: String?, body: ByteArray): ResponseKind =
    classifyResponse(kind, contentType, body, body.size)

  /** Three MPEG-TS packets: sync byte, PID bytes and zero padding. */
  private fun tsPackets(): ByteArray =
    ByteArray(188 * 3).also { packets ->
      for (start in 0 until 3) {
        packets[start * 188] = 0x47
        packets[start * 188 + 1] = 0x40
      }
    }

  /**
   * MPEG-TS joined mid-packet: the first sync byte is at offset 88, and every byte is printable, so only the sync
   * search (not the binary test) can tell it from text.
   */
  private fun printableTsFromMidPacket(): ByteArray =
    ByteArray(1_024) { index -> if ((index - 88).mod(188) == 0) 0x47 else 'x'.code.toByte() }

  private val notice = bytes("Max connections reached")

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
  fun `HLS requests are judged by their data type and keys are never sniffed`() {
    assertEquals(RequestKind.MANIFEST, requestKindFor(C.DATA_TYPE_MANIFEST))
    assertEquals(RequestKind.SEGMENT, requestKindFor(C.DATA_TYPE_MEDIA))
    assertEquals(RequestKind.SEGMENT, requestKindFor(C.DATA_TYPE_MEDIA_INITIALIZATION))
    assertEquals(RequestKind.OTHER, requestKindFor(C.DATA_TYPE_DRM))
    assertEquals(RequestKind.OTHER, requestKindFor(C.DATA_TYPE_STEERING_MANIFEST))
    assertEquals(RequestKind.OTHER, requestKindFor(C.DATA_TYPE_UNKNOWN))
  }

  @Test
  fun `a progressive notice is found whatever the label says`() {
    for (label in listOf("video/mp2t", "application/octet-stream", "video/mp4", null, "text/plain", "text/html")) {
      assertEquals("label $label", ResponseKind.NOTICE, classify(RequestKind.PROGRESSIVE, label, notice))
    }
    val html = bytes("<html><body>Limit</body></html>")
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.PROGRESSIVE, null, html))
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.PROGRESSIVE, null, bytes("{\"error\":\"limit\"}")))
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.PROGRESSIVE, null, bytes("Bağlantı sınırı aşıldı\r\n")))
  }

  @Test
  fun `a progressive playlist is HLS by label or by body`() {
    assertEquals(ResponseKind.HLS, classify(RequestKind.PROGRESSIVE, "application/vnd.apple.mpegurl", ByteArray(0)))
    assertEquals(ResponseKind.HLS, classify(RequestKind.PROGRESSIVE, "audio/x-mpegurl", notice))
    assertEquals(ResponseKind.HLS, classify(RequestKind.PROGRESSIVE, "application/octet-stream", bytes("#EXTM3U\n")))
    assertEquals(ResponseKind.HLS, classify(RequestKind.PROGRESSIVE, "text/html", bom + bytes("\r\n  #EXTM3U\r\n")))
  }

  @Test
  fun `progressive media is media under any label`() {
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, "text/html", tsPackets()))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, null, tsPackets()))
    val mp4 = byteArrayOf(0, 0, 0, 0x18) + bytes("ftypmp42") + ByteArray(16)
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, "text/plain", mp4))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, "text/html", ByteArray(0)))
  }

  @Test
  fun `MPEG-TS that starts mid-packet is found by the sync search`() {
    val joined = printableTsFromMidPacket()
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, "text/plain", joined))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "text/plain", joined))
  }

  @Test
  fun `two G characters 188 bytes apart in a long notice are no sync pattern`() {
    val text = ByteArray(600) { 'a'.code.toByte() }.also {
      it[0] = 'G'.code.toByte()
      it[188] = 'G'.code.toByte()
    }
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.PROGRESSIVE, "text/html", text))
  }

  @Test
  fun `a manifest must start with EXTM3U whatever its label, or it is a notice`() {
    for (label in listOf("application/vnd.apple.mpegurl", "text/plain", null)) {
      assertEquals(ResponseKind.HLS, classify(RequestKind.MANIFEST, label, bytes("#EXTM3U\n#EXT-X-VERSION:3\n")))
      assertEquals(ResponseKind.NOTICE, classify(RequestKind.MANIFEST, label, notice))
    }
    assertEquals(ResponseKind.HLS, classify(RequestKind.MANIFEST, null, bom + bytes("#EXTM3U\n")))
  }

  @Test
  fun `an empty or binary manifest is left to the playlist parser`() {
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.MANIFEST, "application/vnd.apple.mpegurl", ByteArray(0)))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.MANIFEST, "text/plain", tsPackets()))
  }

  @Test
  fun `HLS segments are media unless they are readable text that is neither WebVTT nor MPEG-TS`() {
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "video/mp2t", tsPackets()))
    val subtitles = bytes("WEBVTT\nX-TIMESTAMP-MAP=MPEGTS:900000,LOCAL:00:00:00.000\n\n00:00.000 --> 00:02.000\nHi\n")
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "text/vtt", subtitles))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "text/plain", bom + bytes("WEBVTT\n\n")))
    val fmp4 = byteArrayOf(0, 0, 0, 0x18) + bytes("styp") + ByteArray(16)
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "video/mp4", fmp4))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "video/mp2t", ByteArray(0)))
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.SEGMENT, "video/mp2t", notice))
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.SEGMENT, "text/html", bytes("<html>Limit</html>")))
  }

  @Test
  fun `other requests such as keys are never judged`() {
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.OTHER, "text/html", notice))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.OTHER, "text/html", bytes("0123456789abcdef")))
  }

  @Test
  fun `only the read part of the prefix buffer counts`() {
    val buffer = bytes("Max connections") + ByteArray(64)
    assertEquals(ResponseKind.NOTICE, classifyResponse(RequestKind.PROGRESSIVE, "text/plain", buffer, 15))
  }

  @Test
  fun `invalid UTF-8 binary streams with high bytes 0x80 to 0xFF are classified as media, not text notices (I4)`() {
    // ADTS AAC header 0xFF 0xF1 + printable payload bytes >= 0x20
    val adts = ByteArray(256) { 'A'.code.toByte() }.also {
      it[0] = 0xFF.toByte()
      it[1] = 0xF1.toByte()
    }
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, "audio/aac", adts))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "audio/aac", adts))

    // Bare continuation byte 0x80 and overlong 0xC0 0x80
    val bareCont = byteArrayOf(0x80.toByte(), 'x'.code.toByte(), 'y'.code.toByte())
    val overlong = byteArrayOf(0xC0.toByte(), 0x80.toByte(), 'z'.code.toByte())
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, null, bareCont))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, null, overlong))

    // Valid UTF-8 notice whose multi-byte character is cut right at SNIFF_BYTES (1024) still counts as text
    val padded = ByteArray(SNIFF_BYTES) { 'a'.code.toByte() }.also {
      // 'ğ' in UTF-8 is 0xC4 0x9F; place 0xC4 at index 1023 so it's truncated by SNIFF_BYTES
      it[SNIFF_BYTES - 1] = 0xC4.toByte()
    }
    assertEquals(ResponseKind.NOTICE, classifyResponse(RequestKind.PROGRESSIVE, "text/plain", padded, SNIFF_BYTES))
  }

  @Test
  fun `XML TTML and SRT subtitle segments are classified as media while XHTML and notices stay notices (I4)`() {
    val ttmlXml = bytes("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<tt xmlns=\"http://www.w3.org/ns/ttml\"></tt>")
    val ttmlBare = bom + bytes("  <tt xml:lang=\"en\"><body></body></tt>")
    val srtNumbered = bytes("1\r\n00:00:01,000 --> 00:00:04,500\r\nHello world\r\n\r\n")
    val srtBare = bytes("00:01:02.250 --> 00:01:05.000\nLine\n")

    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "application/ttml+xml", ttmlXml))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "text/xml", ttmlBare))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "application/x-subrip", srtNumbered))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "text/plain", srtBare))

    // XHTML error page starting with <?xml must still be caught as a notice!
    val xhtmlNotice = bytes("<?xml version=\"1.0\"?>\n<!DOCTYPE html>\n<html><body>Limit</body></html>")
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.SEGMENT, "application/xhtml+xml", xhtmlNotice))
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.SEGMENT, "text/plain", bytes("{\"error\":\"limit\"}")))
  }
}

package io.github.fatihmutluu.elv.media3

import androidx.media3.common.C
import java.util.Locale
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
  fun `vertical tab and form feed control whitespace still classify HTML and text notices as NOTICE`() {
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.PROGRESSIVE, "video/mp2t", bytes("<html>\u000CLimit\u000B</html>")))
    assertEquals(ResponseKind.HLS, classify(RequestKind.MANIFEST, "text/plain", bytes("\u000C\u000B#EXTM3U\n")))
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
  fun `a progressive playlist is HLS only by its body`() {
    assertEquals(ResponseKind.HLS, classify(RequestKind.PROGRESSIVE, "application/octet-stream", bytes("#EXTM3U\n")))
    assertEquals(ResponseKind.HLS, classify(RequestKind.PROGRESSIVE, "text/html", bom + bytes("\r\n  #EXTM3U\r\n")))
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.PROGRESSIVE, "audio/x-mpegurl", notice))
  }

  @Test
  fun `MPEG-TS labelled as a playlist is media`() {
    for (label in listOf("application/vnd.apple.mpegurl", "application/x-mpegURL", "audio/mpegurl")) {
      assertEquals("label $label", ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, label, tsPackets()))
    }
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
  fun `a short notice with two G characters 188 bytes apart is a notice, three sync bytes are media`() {
    val text = ByteArray(250) { 'a'.code.toByte() }.also {
      it[0] = 'G'.code.toByte()
      it[188] = 'G'.code.toByte()
    }
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.PROGRESSIVE, "text/plain", text))
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.SEGMENT, "text/plain", text))
    val synced = ByteArray(400) { 'a'.code.toByte() }.also {
      it[5] = 'G'.code.toByte()
      it[193] = 'G'.code.toByte()
      it[381] = 'G'.code.toByte()
    }
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.PROGRESSIVE, "text/plain", synced))
  }

  @Test
  fun `WebVTT segments without a header are media`() {
    val midFile = bytes("01:02.000 --> 01:05.000\nHello\n")
    val noted = bytes("NOTE comment\n\n00:01.000 --> 00:03.000\nHi\n")
    val identified = bytes("cue-7\n00:00:01.000 --> 00:00:03.000 align:start\nHi\n")
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "text/plain", midFile))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, null, noted))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "application/octet-stream", identified))
    assertEquals(ResponseKind.MEDIA, classify(RequestKind.SEGMENT, "text/vtt; charset=utf-8", bytes("Hello\nthere\n")))
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.SEGMENT, "text/html", bytes("<html>Limit</html>")))
    assertEquals(ResponseKind.NOTICE, classify(RequestKind.SEGMENT, "text/vtt", bytes("<html><body>Limit</body></html>")))
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

  @Test
  fun `HTML and XHTML content-type classification respects Locale ROOT under tr-TR locale (#438)`() {
    val previousLocale = Locale.getDefault()
    try {
      Locale.setDefault(Locale.forLanguageTag("tr-TR"))
      val xhtmlNotice = bytes("<?xml version=\"1.0\"?>\n<error>Limit</error>")
      assertEquals(ResponseKind.NOTICE, classify(RequestKind.SEGMENT, "APPLICATION/XHTML+XML", xhtmlNotice))
      val htmlTag = bytes("<?xml version=\"1.0\"?>\n<HTML><BODY>Limit</BODY></HTML>")
      assertEquals(ResponseKind.NOTICE, classify(RequestKind.SEGMENT, "TEXT/VTT", htmlTag))
    } finally {
      Locale.setDefault(previousLocale)
    }
  }

  @Test
  fun `canStopSniffing stops early on 3-packet TS sync, unambiguous binary media, and EXTM3U, never on text (#438)`() {
    // 3-packet MPEG-TS sync stops immediately for all kinds once >= 564 bytes arrive
    val ts = tsPackets()
    assertTrue(canStopSniffing(RequestKind.PROGRESSIVE, "video/mp2t", ts, ts.size))
    assertTrue(canStopSniffing(RequestKind.SEGMENT, "video/mp2t", ts, ts.size))
    assertTrue(canStopSniffing(RequestKind.MANIFEST, "text/plain", ts, ts.size))
    val printableTs = printableTsFromMidPacket()
    assertFalse(canStopSniffing(RequestKind.PROGRESSIVE, "text/plain", printableTs, 188 * 2))
    assertTrue(canStopSniffing(RequestKind.PROGRESSIVE, "text/plain", printableTs, 188 * 3))

    // Unambiguous binary container (>= 16 bytes) stops early for PROGRESSIVE and SEGMENT, not MANIFEST
    val mp4 = byteArrayOf(0, 0, 0, 0x18) + bytes("ftypmp42") + ByteArray(16)
    assertFalse(canStopSniffing(RequestKind.PROGRESSIVE, "video/mp4", mp4, 15))
    assertTrue(canStopSniffing(RequestKind.PROGRESSIVE, "video/mp4", mp4, 16))
    assertTrue(canStopSniffing(RequestKind.SEGMENT, "video/mp4", mp4, 16))
    assertFalse(canStopSniffing(RequestKind.MANIFEST, "application/vnd.apple.mpegurl", mp4, 16))

    // #EXTM3U header (>= 16 bytes) stops early for PROGRESSIVE and MANIFEST, not SEGMENT
    val playlist = bytes("#EXTM3U\n#EXT-X-VERSION:3\n")
    assertFalse(canStopSniffing(RequestKind.MANIFEST, "application/vnd.apple.mpegurl", playlist, 15))
    assertTrue(canStopSniffing(RequestKind.MANIFEST, "application/vnd.apple.mpegurl", playlist, 16))
    assertTrue(canStopSniffing(RequestKind.PROGRESSIVE, "text/plain", playlist, 16))
    assertFalse(canStopSniffing(RequestKind.SEGMENT, "text/plain", playlist, 16))

    // Plain text notices, HTML, and subtitle segments never stop early
    assertFalse(canStopSniffing(RequestKind.PROGRESSIVE, "text/plain", notice, notice.size))
    assertFalse(canStopSniffing(RequestKind.MANIFEST, "text/html", bytes("<html><body>Limit reached</body></html>"), 39))
    val vtt = bytes("WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n")
    assertFalse(canStopSniffing(RequestKind.SEGMENT, "text/vtt", vtt, vtt.size))

    // Partial UTF-8 text whose trailing byte is the lead byte of a multi-byte character must NOT early-stop as binary
    val partialUtf8 = ByteArray(16) { 'a'.code.toByte() }.also { it[15] = 0xC4.toByte() }
    assertFalse(canStopSniffing(RequestKind.PROGRESSIVE, "text/plain", partialUtf8, 16))
    assertFalse(canStopSniffing(RequestKind.SEGMENT, "text/plain", partialUtf8, 16))
  }
}

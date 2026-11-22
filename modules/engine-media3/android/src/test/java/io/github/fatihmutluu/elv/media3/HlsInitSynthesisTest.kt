package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSchemeDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.hls.playlist.HlsMediaPlaylist
import java.io.ByteArrayInputStream
import java.nio.charset.StandardCharsets
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class HlsInitSynthesisTest {
  @Before
  fun setUp() {
    InitSynthesizingPlaylistParserFactory.resetCacheForTest()
  }

  private fun tsPacket(pid: Int, pusi: Boolean, payload: ByteArray): ByteArray {
    val pkt = ByteArray(188) { 0xFF.toByte() }
    pkt[0] = 0x47
    pkt[1] = (((if (pusi) 0x40 else 0x00) or ((pid shr 8) and 0x1F))).toByte()
    pkt[2] = (pid and 0xFF).toByte()
    pkt[3] = 0x10 // payload only, no adaptation
    payload.copyInto(pkt, 4, 0, minOf(payload.size, 184))
    return pkt
  }

  private fun patPacket(pmtPid: Int): ByteArray {
    val sectionLen = 13 // 5 header + 4 program + 4 CRC
    val payload = byteArrayOf(
      0x00, // pointer field
      0x00, // table_id PAT
      (0xB0 or ((sectionLen shr 8) and 0x0F)).toByte(),
      (sectionLen and 0xFF).toByte(),
      0x00, 0x01, // transport_stream_id
      0xC1.toByte(),
      0x00, 0x00,
      0x00, 0x01, // program_number = 1
      (0xE0 or ((pmtPid shr 8) and 0x1F)).toByte(),
      (pmtPid and 0xFF).toByte(),
      0x00, 0x00, 0x00, 0x00, // CRC placeholder
    )
    return tsPacket(0x0000, pusi = true, payload = payload)
  }

  private fun pmtPacket(pmtPid: Int, videoPid: Int, streamType: Int): ByteArray {
    val sectionLen = 18 // 9 header + 5 ES + 4 CRC
    val payload = byteArrayOf(
      0x00, // pointer field
      0x02, // table_id PMT
      (0xB0 or ((sectionLen shr 8) and 0x0F)).toByte(),
      (sectionLen and 0xFF).toByte(),
      0x00, 0x01,
      0xC1.toByte(),
      0x00, 0x00,
      (0xE0 or ((videoPid shr 8) and 0x1F)).toByte(),
      (videoPid and 0xFF).toByte(),
      0xF0.toByte(), 0x00, // program_info_length = 0
      streamType.toByte(),
      (0xE0 or ((videoPid shr 8) and 0x1F)).toByte(),
      (videoPid and 0xFF).toByte(),
      0xF0.toByte(), 0x00, // ES_info_length = 0
      0x00, 0x00, 0x00, 0x00, // CRC placeholder
    )
    return tsPacket(pmtPid, pusi = true, payload = payload)
  }

  private fun videoPesPacket(videoPid: Int, esPayload: ByteArray): ByteArray {
    val pesHeader = byteArrayOf(
      0x00, 0x00, 0x01, 0xE0.toByte(), // video stream_id
      0x00, 0x00, // PES packet length
      0x80.toByte(), 0x00, 0x00, // header data len = 0
    )
    return tsPacket(videoPid, pusi = true, payload = pesHeader + esPayload)
  }

  private fun concat(vararg chunks: ByteArray): ByteArray {
    val total = chunks.sumOf { it.size }
    val out = ByteArray(total)
    var pos = 0
    for (c in chunks) {
      c.copyInto(out, pos)
      pos += c.size
    }
    return out
  }

  private fun h264SegmentWithParamSets(): ByteArray {
    val es = byteArrayOf(
      0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1E, // SPS (NAL 7)
      0x00, 0x00, 0x00, 0x01, 0x68, 0xCE.toByte(), 0x3C, 0x80.toByte(), // PPS (NAL 8)
      0x00, 0x00, 0x00, 0x01, 0x65, 0x88.toByte(), 0x84.toByte(), // IDR slice (NAL 5)
    )
    return concat(patPacket(0x0100), pmtPacket(0x0100, 0x0101, 0x1B), videoPesPacket(0x0101, es))
  }

  private fun h264SegmentWithoutParamSets(): ByteArray {
    val es = byteArrayOf(
      0x00, 0x00, 0x00, 0x01, 0x41, 0x9A.toByte(), 0x22, // Non-IDR slice (NAL 1)
    )
    return concat(patPacket(0x0100), pmtPacket(0x0100, 0x0101, 0x1B), videoPesPacket(0x0101, es))
  }

  private fun hevcSegmentWithParamSets(): ByteArray {
    // HEVC NAL header = (nalType << 1)
    val es = byteArrayOf(
      0x00, 0x00, 0x00, 0x01, (32 shl 1).toByte(), 0x01, 0xAA.toByte(), // VPS (32)
      0x00, 0x00, 0x00, 0x01, (33 shl 1).toByte(), 0x01, 0xBB.toByte(), // SPS (33)
      0x00, 0x00, 0x00, 0x01, (34 shl 1).toByte(), 0x01, 0xCC.toByte(), // PPS (34)
      0x00, 0x00, 0x00, 0x01, (19 shl 1).toByte(), 0x01, 0xDD.toByte(), // IDR (19)
    )
    return concat(patPacket(0x0100), pmtPacket(0x0100, 0x0101, 0x24), videoPesPacket(0x0101, es))
  }

  @Test
  fun `extractTsInitSegment extracts PAT, PMT and H264 or HEVC SPS-PPS packets and rejects invalid input (#183)`() {
    val h264 = h264SegmentWithParamSets()
    assertTrue(hasVideoParameterSets(h264))
    val h264Init = extractTsInitSegment(h264)
    assertNotNull(h264Init)
    assertEquals(3 * 188, h264Init!!.size)
    assertEquals(0x47.toByte(), h264Init[0])
    assertTrue(hasVideoParameterSets(h264Init))

    val hevc = hevcSegmentWithParamSets()
    assertTrue(hasVideoParameterSets(hevc))
    val hevcInit = extractTsInitSegment(hevc)
    assertNotNull(hevcInit)
    assertEquals(3 * 188, hevcInit!!.size)
    assertTrue(hasVideoParameterSets(hevcInit))

    val noSpsPps = h264SegmentWithoutParamSets()
    assertFalse(hasVideoParameterSets(noSpsPps))
    assertNull(extractTsInitSegment(noSpsPps))

    assertNull(extractTsInitSegment(ByteArray(32)))
    assertNull(extractTsInitSegment("not a transport stream".toByteArray()))
  }

  @Test
  fun `synthesizes data URI EXT-X-MAP for finished VOD TS playlist lacking SPS-PPS on segment 1 and caches result (#183)`() {
    val seg0 = h264SegmentWithParamSets()
    val seg1 = h264SegmentWithoutParamSets()
    val probed = mutableListOf<String>()
    val factory = InitSynthesizingPlaylistParserFactory(
      probeSegment = { uri ->
        probed += uri.toString()
        when {
          uri.toString().endsWith("seg0.ts") -> seg0
          uri.toString().endsWith("seg1.ts") -> seg1
          else -> null
        }
      },
    )
    val playlistText = """
      #EXTM3U
      #EXT-X-VERSION:3
      #EXT-X-TARGETDURATION:6
      #EXTINF:6.0,
      seg0.ts
      #EXTINF:6.0,
      seg1.ts
      #EXT-X-ENDLIST
    """.trimIndent()
    val uri = Uri.parse("http://example.invalid/vod/movie.m3u8")
    val parser = factory.createPlaylistParser()
    val first = parser.parse(uri, ByteArrayInputStream(playlistText.toByteArray(StandardCharsets.UTF_8))) as HlsMediaPlaylist

    assertEquals(2, first.segments.size)
    val initSeg = first.segments[1].initializationSegment
    assertNotNull(initSeg)
    assertTrue(initSeg!!.url.startsWith("data:video/mp2t;base64,"))
    assertEquals(initSeg.url, first.segments[0].initializationSegment?.url)
    assertEquals(2, probed.size)

    // Decodable directly by Media3 DataSchemeDataSource
    val dataSource = DataSchemeDataSource()
    val len = dataSource.open(DataSpec(Uri.parse(initSeg.url)))
    val decoded = ByteArray(len.toInt())
    assertEquals(decoded.size, dataSource.read(decoded, 0, decoded.size))
    dataSource.close()
    assertArrayEquals(extractTsInitSegment(seg0), decoded)

    // Second parse of same playlist URL hits LRU cache without re-probing!
    val second = parser.parse(uri, ByteArrayInputStream(playlistText.toByteArray(StandardCharsets.UTF_8))) as HlsMediaPlaylist
    assertEquals(initSeg.url, second.segments[1].initializationSegment?.url)
    assertEquals(2, probed.size)
  }

  @Test
  fun `skips synthesis when segment 1 already carries SPS-PPS, or on live, discontinuity, fMP4 or existing EXT-X-MAP (#183)`() {
    val seg0 = h264SegmentWithParamSets()
    val probed = mutableListOf<String>()
    val factory = InitSynthesizingPlaylistParserFactory(
      probeSegment = { uri ->
        probed += uri.toString()
        seg0 // both seg0 and seg1 carry SPS/PPS
      },
    )
    val parser = factory.createPlaylistParser()

    fun parse(url: String, body: String): HlsMediaPlaylist =
      parser.parse(Uri.parse(url), ByteArrayInputStream(body.toByteArray(StandardCharsets.UTF_8))) as HlsMediaPlaylist

    // 1. Live playlist (no #EXT-X-ENDLIST): zero probes
    val live = parse("http://example.invalid/live/1.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n")
    assertNull(live.segments[0].initializationSegment)
    assertTrue(probed.isEmpty())

    // 2. Discontinuity playlist: zero probes
    val disc = parse("http://example.invalid/vod/disc.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXT-X-DISCONTINUITY\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n")
    assertNull(disc.segments[0].initializationSegment)
    assertTrue(probed.isEmpty())

    // 3. fMP4 (.m4s) playlist: zero probes
    val fmp4 = parse("http://example.invalid/vod/fmp4.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.m4s\n#EXTINF:4.0,\nseg1.m4s\n#EXT-X-ENDLIST\n")
    assertNull(fmp4.segments[0].initializationSegment)
    assertTrue(probed.isEmpty())

    // 4. Already has #EXT-X-MAP: zero probes
    val mapped = parse("http://example.invalid/vod/mapped.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-MAP:URI=\"init.ts\"\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n")
    assertEquals("init.ts", mapped.segments[0].initializationSegment?.url)
    assertTrue(probed.isEmpty())

    // 5. AES-128 encrypted VOD TS playlist: zero probes (encrypted bytes cannot be TS-synced without key)
    val encrypted = parse(
      "http://example.invalid/vod/aes128.m3u8",
      "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI=\"https://example.invalid/key.bin\"\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n",
    )
    assertNull(encrypted.segments[0].initializationSegment)
    assertNotNull(encrypted.segments[0].fullSegmentEncryptionKeyUri)
    assertTrue("encrypted VOD HLS-TS segments must not waste probes", probed.isEmpty())

    // 6. Healthy VOD TS playlist where segment 1 already has SPS/PPS: probes segment 1 only, does NOT attach init segment
    val healthy = parse("http://example.invalid/vod/healthy.m3u8", "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n")
    assertNull(healthy.segments[0].initializationSegment)
    assertEquals(1, probed.size)
    assertTrue(probed[0].endsWith("seg1.ts"))
  }

  @Test(expected = SupersededMediaException::class)
  fun `propagates SupersededMediaException cleanly during probe without caching (#183)`() {
    val factory = InitSynthesizingPlaylistParserFactory(
      probeSegment = { throw SupersededMediaException() },
    )
    val parser = factory.createPlaylistParser()
    val body = "#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg0.ts\n#EXTINF:4.0,\nseg1.ts\n#EXT-X-ENDLIST\n"
    parser.parse(Uri.parse("http://example.invalid/vod/superseded.m3u8"), ByteArrayInputStream(body.toByteArray(StandardCharsets.UTF_8)))
  }
}

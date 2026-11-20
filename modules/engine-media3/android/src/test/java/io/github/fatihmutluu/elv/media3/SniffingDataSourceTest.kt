package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.EOFException
import java.io.IOException
import kotlin.math.min
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class SniffingDataSourceTest {
  private class FakeUpstream(
    private val body: ByteArray,
    private val headers: Map<String, List<String>> = emptyMap(),
    private val failOnRead: Boolean = false,
  ) : DataSource {
    var closed = false
    private var offset = 0

    override fun addTransferListener(transferListener: TransferListener) = Unit

    override fun open(dataSpec: DataSpec): Long {
      closed = false
      offset = 0
      return body.size.toLong()
    }

    override fun read(buffer: ByteArray, bufferOffset: Int, length: Int): Int {
      if (failOnRead) throw IOException("socket reset during sniff")
      if (offset >= body.size) return C.RESULT_END_OF_INPUT
      val count = min(length, body.size - offset)
      System.arraycopy(body, offset, buffer, bufferOffset, count)
      offset += count
      return count
    }

    override fun getUri(): Uri = Uri.parse("http://127.0.0.1:7878/movie/demo/demo/1.mp4")

    override fun getResponseHeaders(): Map<String, List<String>> = headers

    override fun close() {
      closed = true
    }
  }

  @Test
  fun `skips notice sniffing on HTTP 206 byte-range slices with position greater than 0 (I4)`() {
    // Simulates an MP4 tail seek into udta/ilst metadata containing >1 KB of plain UTF-8 text
    val metadataText = "Movie description metadata ".repeat(60).toByteArray(Charsets.UTF_8)
    val upstream = FakeUpstream(
      body = metadataText,
      headers = mapOf(
        "Content-Type" to listOf("video/mp4"),
        "Content-Range" to listOf("bytes 1048576-${1048576 + metadataText.size - 1}/2000000"),
      ),
    )
    val sniffing = SniffingDataSource(upstream, RequestKind.PROGRESSIVE)
    val spec = DataSpec.Builder()
      .setUri(Uri.parse("http://127.0.0.1:7878/movie/demo/demo/1.mp4"))
      .setPosition(1_048_576L)
      .build()
    assertEquals(metadataText.size.toLong(), sniffing.open(spec))
    val out = ByteArray(metadataText.size)
    var total = 0
    while (total < out.size) {
      val n = sniffing.read(out, total, out.size - total)
      if (n == C.RESULT_END_OF_INPUT) break
      total += n
    }
    assertArrayEquals(metadataText, out)
    sniffing.close()
    assertTrue(upstream.closed)
  }

  @Test
  fun `still sniffs a 200 OK provider notice when server ignored Range and omitted Content-Range (I4)`() {
    val notice = "Max connections reached".toByteArray(Charsets.UTF_8)
    val upstream = FakeUpstream(body = notice, headers = mapOf("Content-Type" to listOf("text/plain")))
    val sniffing = SniffingDataSource(upstream, RequestKind.PROGRESSIVE)
    val spec = DataSpec.Builder()
      .setUri(Uri.parse("http://127.0.0.1:7878/movie/demo/demo/1.mp4"))
      .setPosition(1_048_576L)
      .build()
    try {
      sniffing.open(spec)
      fail("expected ProviderNoticeException")
    } catch (_: ProviderNoticeException) {
    }
    assertTrue("upstream must be closed when open throws ProviderNoticeException", upstream.closed)
  }

  @Test
  fun `closes upstream immediately if HlsDetectedException or readAhead IOException is thrown in open (I4)`() {
    val hlsUpstream = FakeUpstream("#EXTM3U\n".toByteArray(Charsets.UTF_8))
    val hlsSniffing = SniffingDataSource(hlsUpstream, RequestKind.PROGRESSIVE)
    try {
      hlsSniffing.open(DataSpec(Uri.parse("http://127.0.0.1:7878/live/demo/demo/1")))
      fail("expected HlsDetectedException")
    } catch (_: HlsDetectedException) {
    }
    assertTrue("upstream must be closed when HlsDetectedException is thrown", hlsUpstream.closed)

    val failingUpstream = FakeUpstream(ByteArray(64), failOnRead = true)
    val failingSniffing = SniffingDataSource(failingUpstream, RequestKind.PROGRESSIVE)
    try {
      failingSniffing.open(DataSpec(Uri.parse("http://127.0.0.1:7878/live/demo/demo/1.ts")))
      fail("expected IOException")
    } catch (_: IOException) {
    }
    assertTrue("upstream must be closed when readAhead throws", failingUpstream.closed)
  }

  private fun tsBody(packets: Int): ByteArray =
    ByteArray(188 * packets).also { body ->
      for (packet in 0 until packets) {
        body[packet * 188] = 0x47
        body[packet * 188 + 1] = 0x40
      }
    }

  private fun readAll(source: DataSource, size: Int): ByteArray {
    val out = ByteArray(size)
    var total = 0
    while (total < size) {
      val n = source.read(out, total, size - total)
      if (n == C.RESULT_END_OF_INPUT) break
      total += n
    }
    assertEquals(C.RESULT_END_OF_INPUT, source.read(ByteArray(1), 0, 1))
    return out.copyOf(total)
  }

  @Test
  fun `MPEG-TS labelled as a playlist is sniffed and served whole`() {
    val body = tsBody(20)
    for (label in listOf("application/vnd.apple.mpegurl", "application/x-mpegurl")) {
      val upstream = FakeUpstream(body, mapOf("Content-Type" to listOf(label)))
      val sniffing = SniffingDataSource(upstream, RequestKind.PROGRESSIVE)
      assertEquals(body.size.toLong(), sniffing.open(DataSpec(Uri.parse("http://127.0.0.1:7878/live/demo/demo/1014.ts"))))
      assertArrayEquals(body, readAll(sniffing, body.size))
      sniffing.close()
    }
  }

  @Test
  fun `an empty initial response fails as notice on progressive text or HTML manifest, and empty media on plain-text HLS manifest`() {
    val spec = DataSpec(Uri.parse("http://127.0.0.1:7878/movie/demo/demo/1.mp4"))
    val progNotice = FakeUpstream(ByteArray(0), mapOf("Content-Type" to listOf("text/plain")))
    try {
      SniffingDataSource(progNotice, RequestKind.PROGRESSIVE).open(spec)
      fail("expected ProviderNoticeException for PROGRESSIVE text/plain")
    } catch (_: ProviderNoticeException) {
    }
    assertTrue(progNotice.closed)

    val htmlManifest = FakeUpstream(ByteArray(0), mapOf("Content-Type" to listOf("text/html")))
    try {
      SniffingDataSource(htmlManifest, RequestKind.MANIFEST).open(spec)
      fail("expected ProviderNoticeException for MANIFEST text/html")
    } catch (_: ProviderNoticeException) {
    }
    assertTrue(htmlManifest.closed)

    val plainManifest = FakeUpstream(ByteArray(0), mapOf("Content-Type" to listOf("text/plain")))
    try {
      SniffingDataSource(plainManifest, RequestKind.MANIFEST).open(spec)
      fail("expected EmptyMediaException for MANIFEST text/plain")
    } catch (_: EmptyMediaException) {
    }
    assertTrue(plainManifest.closed)

    for (kind in listOf(RequestKind.PROGRESSIVE, RequestKind.MANIFEST)) {
      for (label in listOf("video/mp4", null)) {
        val headers = if (label == null) emptyMap() else mapOf("Content-Type" to listOf(label))
        val empty = FakeUpstream(ByteArray(0), headers)
        try {
          SniffingDataSource(empty, kind).open(spec)
          fail("expected EmptyMediaException for $kind $label")
        } catch (error: EmptyMediaException) {
          assertEquals("empty media response", error.message)
          assertTrue(isRefusedLoad(error))
          assertTrue(isRefusedLoad(error, hls = true, manifestLoaded = false))
          assertFalse(isRefusedLoad(error, hls = true, manifestLoaded = true))
        }
        assertTrue(empty.closed)
      }
    }
    assertTrue(isRefusedLoad(IOException("wrapped", ProviderNoticeException("text/html")), hls = true, manifestLoaded = true))
  }

  @Test
  fun `marks manifestLoaded on valid EXTM3U manifest and avoids redundant upstream read after readAhead EOF`() {
    var manifestMarked = false
    var eofReads = 0
    val playlist = "#EXTM3U\n#EXT-X-VERSION:3\n".toByteArray(Charsets.UTF_8)
    val chunkedUpstream = object : DataSource {
      private var offset = 0
      override fun addTransferListener(transferListener: TransferListener) = Unit
      override fun open(dataSpec: DataSpec): Long {
        offset = 0
        return C.LENGTH_UNSET.toLong()
      }
      override fun read(buffer: ByteArray, bufferOffset: Int, length: Int): Int {
        if (offset >= playlist.size) {
          eofReads += 1
          return C.RESULT_END_OF_INPUT
        }
        val count = min(length, playlist.size - offset)
        System.arraycopy(playlist, offset, buffer, bufferOffset, count)
        offset += count
        return count
      }
      override fun getUri(): Uri = Uri.parse("http://127.0.0.1:7878/live/demo/demo/1.m3u8")
      override fun close() = Unit
    }
    val sniffing = SniffingDataSource(chunkedUpstream, RequestKind.MANIFEST) { manifestMarked = true }
    sniffing.open(DataSpec(Uri.parse("http://127.0.0.1:7878/live/demo/demo/1.m3u8")))
    assertTrue("manifestLoaded must flip as soon as MANIFEST EXTM3U opens", manifestMarked)
    assertEquals(1, eofReads)
    assertArrayEquals(playlist, readAll(sniffing, playlist.size))
    assertEquals("must not call upstream.read again after readAhead already saw EOF", 1, eofReads)
    sniffing.close()
  }

  @Test
  fun `an empty byte-range slice and an empty segment are passed on`() {
    val slice = FakeUpstream(ByteArray(0), mapOf("Content-Range" to listOf("bytes */2000000")))
    val spec = DataSpec.Builder().setUri(Uri.parse("http://127.0.0.1:7878/movie/demo/demo/1.mp4")).setPosition(2_000_000L).build()
    assertEquals(0L, SniffingDataSource(slice, RequestKind.PROGRESSIVE).open(spec))
    val segment = FakeUpstream(ByteArray(0), mapOf("Content-Type" to listOf("video/mp2t")))
    assertEquals(0L, SniffingDataSource(segment, RequestKind.SEGMENT).open(DataSpec(Uri.parse("http://127.0.0.1:7878/hls/1.ts"))))
    assertFalse(isRefusedLoad(IOException("reset")))
  }
}

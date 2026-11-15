package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.IOException
import kotlin.math.min
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
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
}

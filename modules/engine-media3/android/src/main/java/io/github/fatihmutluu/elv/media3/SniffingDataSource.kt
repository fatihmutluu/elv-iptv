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

/** A successful response whose body is the provider's notice (connection limit), not media. */
internal class ProviderNoticeException(val contentType: String?) : IOException("provider notice")

/** A non-HLS guess answered with an HLS playlist at [uri] (after redirects); the engine prepares it as HLS. */
internal class HlsDetectedException(val uri: Uri) : IOException("HLS playlist on a non-HLS guess")

/**
 * Judges each response with [classifyResponse] before the player sees it. Only text-labelled responses are read
 * ahead ([SNIFF_BYTES] at most); the bytes read are served first, so the player gets the full body. A notice throws
 * [ProviderNoticeException]; an HLS playlist on a non-[hls] media throws [HlsDetectedException].
 */
@OptIn(UnstableApi::class)
internal class SniffingDataSource(private val upstream: DataSource, private val hls: Boolean) : DataSource {
  private var prefix = ByteArray(0)
  private var prefixLength = 0
  private var prefixRead = 0

  override fun addTransferListener(transferListener: TransferListener) {
    upstream.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    prefixLength = 0
    prefixRead = 0
    val length = upstream.open(dataSpec)
    val contentType = contentTypeOf(upstream.responseHeaders)
    val sniff = !isHlsContentType(contentType) && isNoticeContentType(contentType, hls = false)
    val buffer = if (sniff) ByteArray(SNIFF_BYTES) else ByteArray(0)
    val filled = if (sniff) readAhead(buffer, length) else 0
    when (classifyResponse(contentType, buffer, filled)) {
      ResponseKind.HLS -> if (!hls) throw HlsDetectedException(upstream.uri ?: dataSpec.uri)
      ResponseKind.NOTICE -> throw ProviderNoticeException(contentType)
      ResponseKind.MEDIA -> Unit
    }
    prefix = buffer
    prefixLength = filled
    return length
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (prefixRead < prefixLength) {
      val count = min(length, prefixLength - prefixRead)
      System.arraycopy(prefix, prefixRead, buffer, offset, count)
      prefixRead += count
      return count
    }
    return upstream.read(buffer, offset, length)
  }

  override fun getUri(): Uri? = upstream.uri

  override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

  override fun close() {
    prefixLength = 0
    prefixRead = 0
    upstream.close()
  }

  private fun readAhead(buffer: ByteArray, length: Long): Int {
    val limit = if (length == C.LENGTH_UNSET.toLong()) buffer.size else min(buffer.size.toLong(), length).toInt()
    var filled = 0
    while (filled < limit) {
      val read = upstream.read(buffer, filled, limit - filled)
      if (read == C.RESULT_END_OF_INPUT) break
      filled += read
    }
    return filled
  }
}

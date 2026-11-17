package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.TransferListener
import java.io.EOFException
import java.io.IOException
import kotlin.math.min

/** A successful response whose body is the provider's notice (connection limit), not media. */
internal class ProviderNoticeException(val contentType: String?) : IOException("provider notice")

/** A progressive guess was answered with an HLS playlist; the engine prepares the request again as HLS. */
internal class HlsDetectedException : IOException("HLS playlist on a progressive guess")

/** A first response of a stream or playlist had an empty body: nothing will ever play from it. */
internal class EmptyMediaException : EOFException("empty media response")

/** True for load failures that must reach the playback service at once instead of Media3's retries. */
internal fun isRefusedLoad(error: Throwable): Boolean =
  error is ProviderNoticeException ||
    error is EmptyMediaException ||
    error is HlsDetectedException ||
    error is SupersededMediaException ||
    error is HttpDataSource.InvalidContentTypeException

/**
 * Judges every response of [kind] with [classifyResponse] before the player sees it, whatever its label: it reads up
 * to [SNIFF_BYTES] ahead and serves them first, so the player gets the full body. [RequestKind.OTHER] requests (keys)
 * are passed through unread. A notice throws [ProviderNoticeException]; a playlist on a progressive guess throws
 * [HlsDetectedException]; an empty first progressive or manifest response throws [ProviderNoticeException] or
 * [EmptyMediaException].
 */
@OptIn(UnstableApi::class)
internal class SniffingDataSource(private val upstream: DataSource, private val kind: RequestKind) : DataSource {
  private val prefix = ByteArray(if (kind == RequestKind.OTHER) 0 else SNIFF_BYTES)
  private var prefixLength = 0
  private var prefixRead = 0

  override fun addTransferListener(transferListener: TransferListener) {
    upstream.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    prefixLength = 0
    prefixRead = 0
    val length = upstream.open(dataSpec)
    try {
      if (kind == RequestKind.OTHER) return length
      if (dataSpec.position > 0L && hasContentRange(upstream.responseHeaders)) return length
      val contentType = contentTypeOf(upstream.responseHeaders)
      val filled = readAhead(length)
      if (filled == 0 && (kind == RequestKind.PROGRESSIVE || kind == RequestKind.MANIFEST)) {
        if (isNoticeContentType(contentType, hls = false)) throw ProviderNoticeException(contentType)
        throw EmptyMediaException()
      }
      when (classifyResponse(kind, contentType, prefix, filled)) {
        ResponseKind.HLS -> if (kind == RequestKind.PROGRESSIVE) throw HlsDetectedException()
        ResponseKind.NOTICE -> throw ProviderNoticeException(contentType)
        ResponseKind.MEDIA -> Unit
      }
      prefixLength = filled
      return length
    } catch (t: Throwable) {
      runCatching { upstream.close() }
      throw t
    }
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

  private fun readAhead(length: Long): Int {
    val limit = if (length == C.LENGTH_UNSET.toLong()) prefix.size else min(prefix.size.toLong(), length).toInt()
    var filled = 0
    while (filled < limit) {
      val read = upstream.read(prefix, filled, limit - filled)
      if (read == C.RESULT_END_OF_INPUT) break
      filled += read
    }
    return filled
  }
}

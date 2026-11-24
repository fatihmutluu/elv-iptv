package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ContentDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.okhttp.OkHttpDataSource
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Scheme-allowlisting [DataSource] for external sidecar subtitles (#308):
 * - Routes `http://` and `https://` strictly through an isolated [subtitleHttpClient] with ONLY the headers explicitly
 *   declared on that subtitle track (never primary stream `Authorization`, `Cookie`, `User-Agent`, or `Referer`).
 * - Routes `file://` to [FileDataSource] and `content://` to [ContentDataSource].
 * - Rejects every other URI scheme (`data:`, `ftp:`, `javascript:`, etc.).
 */
@OptIn(UnstableApi::class)
internal class IsolatedSubtitleDataSource(
  subtitleHeaders: Map<String, String>,
  private val client: Call.Factory,
  private val context: Context?,
  private val maxBytes: Int = MAX_EXTERNAL_SUBTITLE_BYTES,
  private val canonicalFileResolver: (File) -> File = { it.canonicalFile },
) : DataSource {
  private val customAgent: String?
  private val cleanHeaders: Map<String, String>
  private val transferListeners = mutableListOf<TransferListener>()
  private val lifecycleLock = Any()
  private val cancelled = AtomicBoolean(false)
  @Volatile private var activeSource: DataSource? = null
  @Volatile private var activeCalls: CancellableCalls? = null
  private var bytesRead: Long = 0L

  init {
    customAgent =
      subtitleHeaders.entries
        .firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }
        ?.value
        ?.let(::sanitizeHeaderValue)
        ?.takeIf { it.isNotEmpty() }
    val sanitized = LinkedHashMap<String, String>()
    for ((rawName, rawValue) in subtitleHeaders) {
      val name = rawName.trim()
      if (name.equals("User-Agent", ignoreCase = true) || !isValidHeaderName(name)) continue
      sanitized[name] = sanitizeHeaderValue(rawValue)
    }
    cleanHeaders = sanitized
  }

  override fun addTransferListener(transferListener: TransferListener) {
    transferListeners += transferListener
    activeSource?.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    if (cancelled.get()) {
      throw IOException("External subtitle request cancelled")
    }
    val rawUri = dataSpec.uri.toString()
    if (!isAllowedExternalSubtitleUri(rawUri)) {
      throw IOException("Disallowed external subtitle URI")
    }
    val scheme = dataSpec.uri.normalizeScheme().scheme?.lowercase(Locale.ROOT)
    var effectiveSpec = dataSpec
    val (delegate, calls) = when (scheme) {
      "http", "https" -> {
        val origin = rawUri.toHttpUrlOrNull()?.let(::StreamOrigin)
        val cancellable = CancellableCalls(client, origin)
        val httpSource = OkHttpDataSource.Factory(cancellable)
          .setUserAgent(customAgent)
          .setDefaultRequestProperties(cleanHeaders)
          .createDataSource()
        httpSource to cancellable
      }
      "file" -> {
        val rawPath = dataSpec.uri.path
        if (rawPath.isNullOrBlank()) {
          throw IOException("Invalid local subtitle file URI")
        }
        val canonical = try {
          canonicalFileResolver(File(rawPath))
        } catch (e: IOException) {
          throw IOException("Unable to resolve local subtitle file", e)
        }
        if (!canonical.exists() || !canonical.isFile) {
          throw IOException("Local subtitle file does not exist or is not a regular file")
        }
        if (!hasAllowedLocalSubtitleExtension(canonical.path)) {
          throw IOException("Local subtitle canonical path has disallowed extension")
        }
        if (canonical.length() > maxBytes.toLong()) {
          throw IOException("Local subtitle file exceeds $maxBytes byte cap")
        }
        effectiveSpec = dataSpec.buildUpon().setUri(Uri.fromFile(canonical)).build()
        FileDataSource() to null
      }
      "content" -> {
        val appCtx = context?.applicationContext ?: context
          ?: throw IOException("content:// external subtitle requires Android Context")
        ContentDataSource(appCtx) to null
      }
      else -> throw IOException("Unsupported external subtitle URI scheme: $scheme")
    }
    for (listener in transferListeners) {
      delegate.addTransferListener(listener)
    }
    synchronized(lifecycleLock) {
      if (cancelled.get()) {
        calls?.cancel()
        throw IOException("External subtitle request cancelled")
      }
      activeSource = delegate
      activeCalls = calls
    }
    bytesRead = 0L
    val openedLength = delegate.open(effectiveSpec)
    val limit = maxBytes.toLong()
    val headerTooLarge = delegate.responseHeaders.entries.any { (name, values) ->
      name.equals("Content-Length", ignoreCase = true) &&
        values.any { (it.trim().toLongOrNull() ?: -1L) > limit }
    }
    if ((openedLength != C.LENGTH_UNSET.toLong() && openedLength > limit) || headerTooLarge) {
      close()
      throw IOException("External subtitle exceeds $maxBytes byte cap")
    }
    return openedLength
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (cancelled.get()) {
      throw IOException("External subtitle request cancelled")
    }
    val source = activeSource ?: return C.RESULT_END_OF_INPUT
    val limit = maxBytes.toLong()
    val remaining = (limit - bytesRead).coerceAtLeast(0L)
    val toRead = if (remaining < length.toLong()) {
      (remaining + 1L).coerceAtMost(length.toLong()).toInt()
    } else {
      length
    }
    val read = source.read(buffer, offset, toRead)
    if (read > 0) {
      bytesRead += read.toLong()
      if (bytesRead > limit) {
        close()
        throw IOException("External subtitle exceeds $maxBytes byte cap")
      }
    }
    return read
  }

  override fun getUri(): Uri? = activeSource?.uri

  override fun getResponseHeaders(): Map<String, List<String>> =
    activeSource?.responseHeaders ?: emptyMap()

  fun cancel() {
    cancelled.set(true)
    val calls: CancellableCalls?
    val source: DataSource?
    synchronized(lifecycleLock) {
      calls = activeCalls
      source = activeSource
    }
    calls?.cancel()
    runCatching { source?.close() }
  }

  override fun close() {
    val calls: CancellableCalls?
    val source: DataSource?
    synchronized(lifecycleLock) {
      calls = activeCalls
      source = activeSource
      activeCalls = null
      activeSource = null
    }
    calls?.cancel()
    source?.close()
  }
}

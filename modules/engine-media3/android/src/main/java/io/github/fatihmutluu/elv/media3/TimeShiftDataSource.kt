package io.github.fatihmutluu.elv.media3

import android.net.Uri
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener

/** Live time-shift window metrics derived from a live MPEG-TS [TimeShiftRingBuffer] session (#28). */
internal data class RingBufferTimeShiftWindow(
  val liveSeekableStartMs: Long,
  val liveEdgeMs: Long,
  val bufferedWindowMs: Long,
)

/**
 * Thread-safe elapsed-duration tracker paired with a session's [TimeShiftRingBuffer] (#28).
 * Tracks elapsed live duration from the first upstream byte and scales the retained seekable window
 * proportionally once the bounded disk ring wraps past capacity.
 */
internal class TimeShiftWindowTracker(
  private val ringBuffer: TimeShiftRingBuffer,
  private val clockMs: () -> Long = SystemClock::uptimeMillis,
) {
  private val lock = Any()
  private var firstByteAtMs: Long? = null

  /** Records incoming upstream bytes to anchor elapsed live window timing. */
  fun recordUpstreamBytes(count: Int) {
    if (count <= 0) return
    val now = clockMs()
    synchronized(lock) {
      if (firstByteAtMs == null) {
        firstByteAtMs = now
      }
    }
  }

  /** Retained live window duration currently backed by the ring buffer in milliseconds. */
  val bufferedWindowMs: Long
    get() = currentWindow()?.bufferedWindowMs ?: 0L

  /** Computes the current live seekable window, or `null` before bytes arrive or once closed. */
  fun currentWindow(): RingBufferTimeShiftWindow? {
    val snap = ringBuffer.snapshot()
    if (snap.closed || snap.totalWrittenBytes <= 0L || snap.bufferedBytes <= 0L) return null
    val startedAt = synchronized(lock) { firstByteAtMs } ?: return null
    val totalElapsedMs = (clockMs() - startedAt).coerceAtLeast(0L)
    val retainedMs = if (snap.totalWrittenBytes <= snap.capacityBytes) {
      totalElapsedMs
    } else {
      ((totalElapsedMs.toDouble() * snap.bufferedBytes.toDouble()) / snap.totalWrittenBytes.toDouble())
        .toLong()
        .coerceIn(0L, totalElapsedMs)
    }
    val seekableStartMs = (totalElapsedMs - retainedMs).coerceAtLeast(0L)
    return RingBufferTimeShiftWindow(
      liveSeekableStartMs = seekableStartMs,
      liveEdgeMs = totalElapsedMs,
      bufferedWindowMs = retainedMs,
    )
  }
}

/**
 * [DataSource] wrapper backed by [TimeShiftRingBuffer] for live raw MPEG-TS streams (#28).
 *
 * Incoming bytes from [upstream] are teed into [ringBuffer] (strictly capped on disk at 64 MiB low-RAM /
 * 256 MiB standard, never inflating ExoPlayer's 16 MiB heap `DefaultLoadControl` budget). When [open]
 * requests a byte offset inside the retained ring window, reads are served directly from [ringBuffer]
 * without opening a competing upstream connection, then transition seamlessly to [upstream] at live head.
 * Closing this data source closes only [upstream]; [ringBuffer] remains owned by `Media3Engine` across seeks.
 */
@OptIn(UnstableApi::class)
internal class TimeShiftDataSource(
  private val upstream: DataSource,
  private val ringBuffer: TimeShiftRingBuffer,
  private val tracker: TimeShiftWindowTracker? = null,
) : DataSource {
  private var activeSpec: DataSpec? = null
  private var upstreamOpen = false
  private var servingFromRing = false
  private var ringCursor = 0L
  private var lastUri: Uri? = null
  private var lastResponseHeaders: Map<String, List<String>> = emptyMap()

  override fun addTransferListener(transferListener: TransferListener) {
    upstream.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    activeSpec = dataSpec
    lastUri = dataSpec.uri
    val snap = ringBuffer.snapshot()
    val requestedPosition = dataSpec.position.coerceAtLeast(0L)
    if (
      !snap.closed &&
      snap.bufferedBytes > 0L &&
      requestedPosition >= snap.oldestAvailableOffset &&
      requestedPosition < snap.totalWrittenBytes
    ) {
      val clamped = ringBuffer.seek(requestedPosition)
      if (clamped >= 0L) {
        ringCursor = clamped
        servingFromRing = true
        upstreamOpen = false
        return C.LENGTH_UNSET.toLong()
      }
    }
    servingFromRing = false
    return openUpstream(dataSpec)
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (servingFromRing) {
      val positioned = ringBuffer.seek(ringCursor)
      if (positioned >= 0L) {
        ringCursor = positioned
        val fromRing = ringBuffer.read(buffer, offset, length)
        if (fromRing > 0) {
          ringCursor += fromRing.toLong()
          return fromRing
        }
      }
      servingFromRing = false
      if (!upstreamOpen) {
        val spec = activeSpec ?: return C.RESULT_END_OF_INPUT
        openUpstream(spec)
      }
    }
    val bytesRead = upstream.read(buffer, offset, length)
    if (bytesRead > 0) {
      ringBuffer.write(buffer, offset, bytesRead)
      tracker?.recordUpstreamBytes(bytesRead)
    }
    return bytesRead
  }

  override fun getUri(): Uri? = if (upstreamOpen) upstream.uri ?: lastUri else lastUri

  override fun getResponseHeaders(): Map<String, List<String>> =
    if (upstreamOpen) upstream.responseHeaders else lastResponseHeaders

  override fun close() {
    activeSpec = null
    servingFromRing = false
    if (upstreamOpen) {
      upstreamOpen = false
      upstream.close()
    }
  }

  private fun openUpstream(dataSpec: DataSpec): Long {
    val liveSpec = if (dataSpec.position > 0L) {
      dataSpec.buildUpon().setPosition(0L).setLength(C.LENGTH_UNSET.toLong()).build()
    } else {
      dataSpec
    }
    val length = upstream.open(liveSpec)
    upstreamOpen = true
    lastUri = upstream.uri ?: dataSpec.uri
    lastResponseHeaders = upstream.responseHeaders
    return length
  }
}

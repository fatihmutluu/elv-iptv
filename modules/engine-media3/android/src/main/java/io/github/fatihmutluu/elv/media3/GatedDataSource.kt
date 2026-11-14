package io.github.fatihmutluu.elv.media3

import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.atomic.AtomicBoolean

/** How long a new media's first request waits for the previous media's connections before closing them. */
internal const val GATE_TIMEOUT_MS = 1_000L

private const val TAG = "ElvMedia3"

/** A request of a media that a newer `load`, `retry` or `stop` superseded; it never reaches the network. */
internal class SupersededMediaException : IOException("superseded media")

/**
 * Reports every connection of its media generation to the [ConnectionGate]. `open` first waits until the
 * connections of older generations are closed (forcing them after [GATE_TIMEOUT_MS]) and refuses to open once its
 * own generation is superseded. Media3 calls `close` after every `open`, also a failed one.
 */
@OptIn(UnstableApi::class)
internal class GatedDataSource(
  private val upstream: DataSource,
  private val gate: ConnectionGate,
  private val generation: Long,
) : DataSource, ForceClosable {
  private val counted = AtomicBoolean(false)
  private val closeLock = Any()

  @Volatile
  private var forced = false

  override fun addTransferListener(transferListener: TransferListener) {
    upstream.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    try {
      if (!gate.awaitPreviousClosed(generation, GATE_TIMEOUT_MS)) {
        Log.w(TAG, "closed connections of an older media after $GATE_TIMEOUT_MS ms")
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      throw InterruptedIOException("interrupted at the media boundary")
    }
    forced = false
    counted.set(true)
    if (!gate.tryOpen(generation, this)) {
      counted.set(false)
      throw SupersededMediaException()
    }
    return upstream.open(dataSpec)
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (forced) throw IOException("closed at the media boundary")
    return upstream.read(buffer, offset, length)
  }

  override fun getUri(): Uri? = upstream.uri

  override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

  override fun close() {
    synchronized(closeLock) {
      try {
        upstream.close()
      } finally {
        uncount()
      }
    }
  }

  /** Called by the gate on the waiting loader thread; closing the upstream unblocks a read stuck on the socket. */
  override fun forceClose() {
    forced = true
    synchronized(closeLock) {
      try {
        upstream.close()
      } catch (_: Exception) {
      } finally {
        uncount()
      }
    }
  }

  private fun uncount() {
    if (counted.compareAndSet(true, false)) gate.closed(generation, this)
  }
}

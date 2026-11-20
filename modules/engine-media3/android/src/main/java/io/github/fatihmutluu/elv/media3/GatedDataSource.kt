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

/** How long a new media's first request waits for the previous media's connections before forcing them again. */
internal const val GATE_TIMEOUT_MS = 1_000L

private const val TAG = "ElvMedia3"

/** A request of a media that a newer `load`, `retry` or `stop` superseded; it never reaches the network. */
internal class SupersededMediaException : IOException("superseded media")

/**
 * Reports every connection of its media generation to the [ConnectionGate]. `open` first waits until the connections
 * of older generations are closed (forcing them again after [gateTimeoutMs]) and refuses to open once its own
 * generation is superseded. A force-close cancels the upstream call ([cancelUpstream]: OkHttp closes its socket,
 * connecting, waiting for the answer or reading) and interrupts an `open` still in progress; the connection stays
 * counted until Media3 closes it, which it does after every `open`, also a failed one, or until the gate drops it
 * ([ConnectionGate.dropForced], [DROP_AFTER_MS]). A forced source opens no more.
 */
@OptIn(UnstableApi::class)
internal class GatedDataSource(
  private val upstream: DataSource,
  private val gate: ConnectionGate,
  private val generation: Long,
  private val cancelUpstream: () -> Unit = {},
  private val gateTimeoutMs: Long = GATE_TIMEOUT_MS,
) : DataSource, ForceClosable {
  private val counted = AtomicBoolean(false)
  private val lock = Any()

  /** The thread inside `open`, guarded by [lock]. */
  private var opening: Thread? = null

  @Volatile
  private var forced = false

  override fun addTransferListener(transferListener: TransferListener) {
    upstream.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    if (forced) throw SupersededMediaException()
    try {
      when (gate.awaitPreviousClosed(generation, gateTimeoutMs)) {
        BoundaryWait.CLOSED_AFTER_FORCE ->
          Log.w(TAG, "an older media's connections closed only after a second force-close at $gateTimeoutMs ms")
        BoundaryWait.DROPPED ->
          Log.w(TAG, "dropped older connections still open $DROP_AFTER_MS ms after their cancel, without a close")
        BoundaryWait.SUPERSEDED -> throw SupersededMediaException()
        BoundaryWait.CLOSED -> Unit
      }
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      throw InterruptedIOException("interrupted at the media boundary")
    }
    counted.set(true)
    if (!gate.tryOpen(generation, this)) {
      counted.set(false)
      throw SupersededMediaException()
    }
    synchronized(lock) {
      if (forced) throw SupersededMediaException()
      opening = Thread.currentThread()
    }
    try {
      return upstream.open(dataSpec)
    } finally {
      synchronized(lock) { opening = null }
    }
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (forced) throw SupersededMediaException()
    return upstream.read(buffer, offset, length)
  }

  override fun getUri(): Uri? = upstream.uri

  override fun getResponseHeaders(): Map<String, List<String>> = upstream.responseHeaders

  override fun close() {
    try {
      upstream.close()
    } finally {
      if (counted.compareAndSet(true, false)) gate.closed(generation, this)
    }
  }

  /** Called on the gate's closer thread; never closes the upstream itself (its owner may be reading it). */
  override fun forceClose() {
    forced = true
    cancelUpstream()
    synchronized(lock) { opening?.interrupt() }
  }
}

package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import java.io.IOException
import java.io.InterruptedIOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit.SECONDS
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLog

/** Waits use lower bounds or generous timeouts only, as in [ConnectionGateTest]. */
@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class GatedDataSourceTest {
  private val spec = DataSpec(Uri.parse("http://h/live/u/p/1001.ts"))

  private abstract class Upstream : DataSource {
    override fun addTransferListener(transferListener: TransferListener) = Unit

    override fun getUri(): Uri? = null

    override fun close() = Unit
  }

  /** Opens at once; its owner then stays parked (a full sample queue) and never reads or closes it. */
  private class Parked : Upstream() {
    override fun open(dataSpec: DataSpec): Long = C.LENGTH_UNSET.toLong()

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = throw UnsupportedOperationException()
  }

  /** Opens [source] on a daemon thread; returns the thread and the milliseconds the open took (0 until it returns). */
  private fun openLater(source: GatedDataSource): Pair<Thread, AtomicLong> {
    val tookMs = AtomicLong()
    val start = System.nanoTime()
    val opener = thread(isDaemon = true) {
      source.open(spec)
      tookMs.set(maxOf(1L, (System.nanoTime() - start) / 1_000_000))
    }
    return opener to tookMs
  }

  /** An open that waits for its answer the way OkHttp's call wait does: only an interrupt ends it. */
  private class StuckOpen : Upstream() {
    val entered = CountDownLatch(1)

    override fun open(dataSpec: DataSpec): Long {
      entered.countDown()
      try {
        CountDownLatch(1).await()
      } catch (_: InterruptedException) {
        throw InterruptedIOException("call cancelled")
      }
      throw AssertionError("unreachable")
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int = throw UnsupportedOperationException()
  }

  /** A read blocked on its socket: interrupts are ignored, only cancelling the call (closing the socket) ends it. */
  private class StuckRead : Upstream() {
    val reading = CountDownLatch(1)
    val socketClosed = CountDownLatch(1)

    override fun open(dataSpec: DataSpec): Long = C.LENGTH_UNSET.toLong()

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
      reading.countDown()
      while (true) {
        try {
          if (socketClosed.await(10, SECONDS)) throw IOException("socket closed")
        } catch (_: InterruptedException) {
        }
      }
    }
  }

  @Test
  fun `an open stuck before its answer is aborted by a newer media and stays counted until its owner closes it`() {
    val gate = ConnectionGate(Executors.newSingleThreadExecutor())
    gate.beginMedia(1)
    val upstream = StuckOpen()
    val cancelled = AtomicBoolean()
    val source = GatedDataSource(upstream, gate, 1, cancelUpstream = { cancelled.set(true) })
    val aborted = CountDownLatch(1)
    val mayClose = CountDownLatch(1)
    val failure = AtomicReference<Throwable?>()
    val owner = thread {
      try {
        source.open(spec)
      } catch (e: IOException) {
        failure.set(e)
      }
      aborted.countDown()
      mayClose.await()
      source.close()
    }
    assertTrue(upstream.entered.await(5, SECONDS))
    gate.beginMedia(2)
    assertTrue("the stuck open was not aborted", aborted.await(5, SECONDS))
    assertTrue("${failure.get()}", failure.get() is InterruptedIOException)
    assertTrue("the call was not cancelled", cancelled.get())

    val waiterDone = AtomicLong()
    val waiter = thread {
      gate.awaitPreviousClosed(2, 10_000)
      waiterDone.set(System.nanoTime())
    }
    Thread.sleep(300)
    assertEquals("the aborted connection was uncounted before its owner closed it", 0L, waiterDone.get())
    val closedAt = System.nanoTime()
    mayClose.countDown()
    waiter.join(5_000)
    owner.join(5_000)
    assertTrue("the next media opened before the close", waiterDone.get() >= closedAt)
  }

  @Test
  fun `a read stuck on its socket is ended by cancelling the call, then uncounted by its close`() {
    val gate = ConnectionGate(Executors.newSingleThreadExecutor())
    gate.beginMedia(1)
    val upstream = StuckRead()
    val source = GatedDataSource(upstream, gate, 1, cancelUpstream = { upstream.socketClosed.countDown() })
    val failure = AtomicReference<Throwable?>()
    val owner = thread {
      source.open(spec)
      try {
        source.read(ByteArray(1), 0, 1)
      } catch (e: IOException) {
        failure.set(e)
      } finally {
        source.close()
      }
    }
    assertTrue(upstream.reading.await(5, SECONDS))
    gate.beginMedia(2)
    owner.join(5_000)
    assertTrue("the stuck read did not end", !owner.isAlive)
    assertTrue("${failure.get()}", failure.get() is IOException)
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `a superseded media never reaches its upstream`() {
    val gate = ConnectionGate(Executors.newSingleThreadExecutor())
    gate.beginMedia(1)
    gate.beginMedia(2)
    val upstream = StuckOpen()
    val failure = runCatching { GatedDataSource(upstream, gate, 1).open(spec) }.exceptionOrNull()
    assertTrue("$failure", failure is SupersededMediaException)
    assertEquals(1L, upstream.entered.count)
  }

  @Test
  fun `a forced connection that never closes is dropped with a warning, and only then the next media opens`() {
    ShadowLog.clear()
    val gate = ConnectionGate(Executors.newSingleThreadExecutor())
    gate.beginMedia(1)
    GatedDataSource(Parked(), gate, 1).open(spec)
    gate.beginMedia(2)
    val (opener, tookMs) = openLater(GatedDataSource(Parked(), gate, 2, gateTimeoutMs = 200))
    opener.join(10_000)
    assertTrue("the next media never opened", tookMs.get() > 0)
    assertTrue("opened after ${tookMs.get()} ms", tookMs.get() >= 200 + DROP_AFTER_MS)
    val warnings = ShadowLog.getLogsForTag("ElvMedia3").map { it.msg }
    assertTrue("$warnings", warnings.any { it.contains("dropped") })
    assertTrue("$warnings", warnings.none { it.contains("http") || it.contains("closed only after") })
  }

  @Test
  fun `after a recreate released the player, its stuck connection does not hold up the next media`() {
    val gate = ConnectionGate { it.run() }
    gate.beginMedia(1)
    GatedDataSource(Parked(), gate, 1).open(spec)
    gate.beginMedia(2)
    gate.dropForced()
    val (opener, tookMs) = openLater(GatedDataSource(Parked(), gate, 2, gateTimeoutMs = 10_000))
    opener.join(5_000)
    assertTrue("the next media waited for the stuck connection", tookMs.get() > 0)
  }
}

package io.github.fatihmutluu.elv.media3

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Timing assertions only use lower bounds (a wait cannot end before the event it waits for); "did not wait" is shown
 * with a zero timeout, which forces at once if anything older is still open. Force-closes run on [inline] by default.
 */
class ConnectionGateTest {
  private val patientMs = 10_000L
  private val inline = Executor { it.run() }

  private fun elapsedMs(since: Long): Long = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - since)

  private fun waitFor2(gate: ConnectionGate, timeoutMs: Long): Pair<Thread, AtomicReference<BoundaryWait?>> {
    val result = AtomicReference<BoundaryWait?>()
    return thread(isDaemon = true) { result.set(gate.awaitPreviousClosed(2, timeoutMs)) } to result
  }

  private fun later(delayMs: Long, action: () -> Unit): Thread =
    Thread {
      Thread.sleep(delayMs)
      action()
    }.also { it.start() }

  private class Aborting(private val gate: ConnectionGate, private val generation: Long) : ForceClosable {
    val forced = AtomicInteger()

    override fun forceClose() {
      forced.incrementAndGet()
      gate.closed(generation, this)
    }
  }

  @Test
  fun `the first media and connections of the same media open without waiting`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(1, 0))
    assertTrue(gate.tryOpen(1))
    assertTrue(gate.tryOpen(1))
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(1, 0))
  }

  @Test
  fun `a newer generation waits until every connection of every older generation closes`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    gate.tryOpen(1)
    gate.tryOpen(1)
    gate.beginMedia(2)
    gate.tryOpen(2)
    gate.beginMedia(3)
    val start = System.nanoTime()
    val closer = later(100) {
      gate.closed(1)
      gate.closed(2)
      Thread.sleep(150)
      gate.closed(1)
    }
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(3, patientMs))
    val waited = elapsedMs(start)
    closer.join()
    assertTrue("waited $waited ms", waited >= 200)
  }

  @Test
  fun `a new media force-closes every older open connection at once on the closer executor`() {
    val queued = mutableListOf<Runnable>()
    val gate = ConnectionGate { queued += it }
    gate.beginMedia(1)
    val first = Aborting(gate, 1)
    val closedBefore = Aborting(gate, 1)
    gate.tryOpen(1, first)
    gate.tryOpen(1, closedBefore)
    gate.closed(1, closedBefore)
    gate.beginMedia(1)
    assertEquals(0, queued.size)
    gate.beginMedia(2)
    assertEquals(0, first.forced.get())
    assertEquals(1, queued.size)
    queued.single().run()
    assertEquals(1, first.forced.get())
    assertEquals(0, closedBefore.forced.get())
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `a forced connection stays counted until closed or second force-close`() {
    val gate = ConnectionGate(inline)
    val forced = AtomicInteger()
    val closedOnSecondForce = object : ForceClosable {
      override fun forceClose() {
        if (forced.incrementAndGet() == 2) gate.closed(1, this)
      }
    }
    gate.beginMedia(1)
    gate.tryOpen(1, closedOnSecondForce)
    gate.beginMedia(2)
    val start = System.nanoTime()
    assertEquals(BoundaryWait.CLOSED_AFTER_FORCE, gate.awaitPreviousClosed(2, 200))
    assertTrue(elapsedMs(start) >= 200)
    assertEquals(2, forced.get())
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `a superseded generation cannot open and a superseded waiter stops without forcing`() {
    val gate = ConnectionGate(inline)
    val forced = AtomicInteger()
    gate.beginMedia(1)
    gate.tryOpen(1) { forced.incrementAndGet() }
    gate.beginMedia(2)
    val zap = later(100) { gate.beginMedia(3) }
    assertEquals(BoundaryWait.SUPERSEDED, gate.awaitPreviousClosed(2, patientMs))
    zap.join()
    assertFalse(gate.tryOpen(2))
    assertEquals(2, forced.get())
  }

  @Test
  fun `an interrupted waiter throws InterruptedException`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    gate.tryOpen(1)
    gate.beginMedia(2)
    val failure = AtomicReference<Throwable?>()
    val started = CountDownLatch(1)
    val waiter = Thread {
      started.countDown()
      try {
        gate.awaitPreviousClosed(2, patientMs)
      } catch (e: Throwable) {
        failure.set(e)
      }
    }.also { it.start() }
    started.await()
    waiter.interrupt()
    waiter.join(patientMs)
    assertTrue(failure.get() is InterruptedException)
  }

  @Test
  fun `a forced connection that never reports closed is dropped 1,500 ms after the second force-close`() {
    val gate = ConnectionGate(inline)
    val forced = AtomicInteger()
    gate.beginMedia(1)
    gate.tryOpen(1) { forced.incrementAndGet() }
    gate.beginMedia(2)
    val start = System.nanoTime()
    val (waiter, result) = waitFor2(gate, 200)
    waiter.join(patientMs)
    assertEquals(BoundaryWait.DROPPED, result.get())
    assertTrue(elapsedMs(start) >= 200 + DROP_AFTER_MS)
    assertEquals(2, forced.get())
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `a connection whose force-close has not finished is not dropped on the first tick`() {
    val queued = LinkedBlockingQueue<Runnable>()
    val gate = ConnectionGate { queued.put(it) }
    gate.beginMedia(1)
    gate.tryOpen(1) {}
    gate.beginMedia(2)
    val (waiter, result) = waitFor2(gate, 100)
    waiter.join(100 + DROP_AFTER_MS + 700)
    assertTrue("dropped before its force-close ran", waiter.isAlive)
    assertNull(result.get())
    while (queued.isNotEmpty()) queued.take().run()
    waiter.join(patientMs)
    assertEquals(BoundaryWait.DROPPED, result.get())
  }

  @Test
  fun `a connection without a closer is never dropped`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    gate.tryOpen(1)
    gate.beginMedia(2)
    val (waiter, result) = waitFor2(gate, 100)
    waiter.join(100 + DROP_AFTER_MS + 700)
    assertTrue(waiter.isAlive)
    gate.closed(1)
    waiter.join(patientMs)
    assertEquals(BoundaryWait.CLOSED_AFTER_FORCE, result.get())
  }

  @Test
  fun `a released player's forced connections are dropped and late closes do not uncount peers`() {
    val gate = ConnectionGate(inline)
    val dropped = ForceClosable {}
    gate.beginMedia(1)
    gate.tryOpen(1, dropped)
    gate.tryOpen(1)
    gate.beginMedia(2)
    gate.dropForced()
    gate.closed(1, dropped)
    val (waiter, result) = waitFor2(gate, patientMs)
    waiter.join(300)
    assertTrue(waiter.isAlive)
    gate.closed(1)
    waiter.join(patientMs)
    assertEquals(BoundaryWait.CLOSED, result.get())
  }

  @Test
  fun `a waiter superseded during the second wait reports superseded and dropForced handles async closer`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    gate.tryOpen(1) {}
    gate.beginMedia(2)
    val (waiter, result) = waitFor2(gate, 100)
    val zap = later(400) { gate.beginMedia(3) }
    waiter.join(patientMs)
    zap.join()
    assertEquals(BoundaryWait.SUPERSEDED, result.get())

    val queued = LinkedBlockingQueue<Runnable>()
    val asyncGate = ConnectionGate { queued.put(it) }
    asyncGate.beginMedia(1)
    asyncGate.tryOpen(1) {}
    asyncGate.beginMedia(2)
    asyncGate.dropForced()
    queued.take().run()
    assertEquals(BoundaryWait.CLOSED, asyncGate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `shut-down or stalled closer still drops superseded connections after bounded backstop`() {
    val rejectingGate = ConnectionGate { throw RejectedExecutionException("closer shut down") }
    rejectingGate.beginMedia(1)
    rejectingGate.tryOpen(1) {}
    rejectingGate.beginMedia(2)
    val (rejWaiter, rejResult) = waitFor2(rejectingGate, 50)
    rejWaiter.join(5_000)
    assertEquals(BoundaryWait.DROPPED, rejResult.get())

    val stalledGate = ConnectionGate {}
    stalledGate.beginMedia(1)
    stalledGate.tryOpen(1) {}
    stalledGate.beginMedia(2)
    val (stallWaiter, stallResult) = waitFor2(stalledGate, 50)
    stallWaiter.join(6_000)
    assertEquals(BoundaryWait.DROPPED, stallResult.get())
    assertEquals(BoundaryWait.CLOSED, stalledGate.awaitPreviousClosed(2, 0))
  }
}

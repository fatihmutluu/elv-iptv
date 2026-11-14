package io.github.fatihmutluu.elv.media3

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Timing assertions only use lower bounds (a wait cannot end before the event it waits for); "did not wait" is shown
 * with a zero timeout, which forces at once if anything older is still open. A loaded CI runner cannot break them.
 */
class ConnectionGateTest {
  private val patientMs = 10_000L

  private fun elapsedMs(since: Long): Long = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - since)

  private fun later(delayMs: Long, action: () -> Unit): Thread =
    Thread {
      Thread.sleep(delayMs)
      action()
    }.also { it.start() }

  @Test
  fun `the first media opens without waiting`() {
    val gate = ConnectionGate()
    gate.beginMedia(1)
    assertTrue(gate.awaitPreviousClosed(1, 0))
  }

  @Test
  fun `connections of the same media never wait for each other`() {
    val gate = ConnectionGate()
    gate.beginMedia(1)
    assertTrue(gate.tryOpen(1))
    assertTrue(gate.tryOpen(1))
    assertTrue(gate.awaitPreviousClosed(1, 0))
  }

  @Test
  fun `a second generation waits until the first closes`() {
    val gate = ConnectionGate()
    gate.beginMedia(1)
    gate.tryOpen(1)
    gate.beginMedia(2)
    val start = System.nanoTime()
    val closer = later(200) { gate.closed(1) }
    assertTrue(gate.awaitPreviousClosed(2, patientMs))
    val waited = elapsedMs(start)
    closer.join()
    assertTrue("waited $waited ms", waited >= 150)
  }

  @Test
  fun `it waits for every connection of every older generation`() {
    val gate = ConnectionGate()
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
    assertTrue(gate.awaitPreviousClosed(3, patientMs))
    val waited = elapsedMs(start)
    closer.join()
    assertTrue("waited $waited ms", waited >= 200)
  }

  @Test
  fun `it times out at 1,000 ms, force-closes the older connections and reports forced`() {
    val gate = ConnectionGate()
    val forced = AtomicInteger()
    gate.beginMedia(1)
    gate.tryOpen(1) { forced.incrementAndGet() }
    gate.beginMedia(2)
    val start = System.nanoTime()
    assertFalse(gate.awaitPreviousClosed(2, 1_000))
    val waited = elapsedMs(start)
    assertTrue("waited $waited ms", waited >= 1_000)
    assertEquals(1, forced.get())
  }

  @Test
  fun `a forced generation is not waited for again and its late close is ignored`() {
    val gate = ConnectionGate()
    val forced = AtomicInteger()
    gate.beginMedia(1)
    gate.tryOpen(1) { forced.incrementAndGet() }
    gate.beginMedia(2)
    assertFalse(gate.awaitPreviousClosed(2, 0))
    gate.closed(1)
    gate.tryOpen(2)
    gate.closed(2)
    assertTrue(gate.awaitPreviousClosed(2, 0))
    assertEquals(1, forced.get())
  }

  @Test
  fun `a closed connection is not force-closed`() {
    val gate = ConnectionGate()
    val forced = AtomicInteger()
    val first = ForceClosable { forced.incrementAndGet() }
    val second = ForceClosable { forced.addAndGet(10) }
    gate.beginMedia(1)
    gate.tryOpen(1, first)
    gate.tryOpen(1, second)
    gate.closed(1, first)
    gate.beginMedia(2)
    assertFalse(gate.awaitPreviousClosed(2, 0))
    assertEquals(10, forced.get())
  }

  @Test
  fun `a superseded generation cannot open and is not counted`() {
    val gate = ConnectionGate()
    gate.beginMedia(1)
    assertTrue(gate.tryOpen(1))
    gate.closed(1)
    gate.beginMedia(2)
    assertFalse(gate.tryOpen(1))
    assertTrue(gate.awaitPreviousClosed(2, 0))
    assertTrue(gate.tryOpen(2))
    gate.beginMedia(1)
    assertTrue(gate.tryOpen(2))
  }

  @Test
  fun `a superseded waiter stops waiting without forcing`() {
    val gate = ConnectionGate()
    val forced = AtomicInteger()
    gate.beginMedia(1)
    gate.tryOpen(1) { forced.incrementAndGet() }
    gate.beginMedia(2)
    val start = System.nanoTime()
    val zap = later(100) { gate.beginMedia(3) }
    assertTrue(gate.awaitPreviousClosed(2, patientMs))
    val waited = elapsedMs(start)
    zap.join()
    assertTrue("waited $waited ms", waited >= 50)
    assertFalse(gate.tryOpen(2))
    assertEquals(0, forced.get())
  }

  @Test
  fun `an interrupted waiter throws InterruptedException`() {
    val gate = ConnectionGate()
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
    }
    waiter.start()
    started.await()
    waiter.interrupt()
    waiter.join(patientMs)
    assertTrue(failure.get() is InterruptedException)
  }
}

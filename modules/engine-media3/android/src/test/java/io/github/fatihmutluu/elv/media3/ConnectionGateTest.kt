package io.github.fatihmutluu.elv.media3

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionGateTest {
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
    val start = System.nanoTime()
    assertTrue(gate.awaitPreviousClosed(1, 1_000))
    assertTrue(elapsedMs(start) < 100)
  }

  @Test
  fun `connections of the same media never wait for each other`() {
    val gate = ConnectionGate()
    gate.beginMedia(1)
    gate.opened(1)
    gate.opened(1)
    val start = System.nanoTime()
    assertTrue(gate.awaitPreviousClosed(1, 1_000))
    assertTrue(elapsedMs(start) < 100)
  }

  @Test
  fun `a second generation waits until the first closes`() {
    val gate = ConnectionGate()
    gate.beginMedia(1)
    gate.opened(1)
    gate.beginMedia(2)
    val start = System.nanoTime()
    val closer = later(200) { gate.closed(1) }
    assertTrue(gate.awaitPreviousClosed(2, 1_000))
    val waited = elapsedMs(start)
    closer.join()
    assertTrue("waited $waited ms", waited in 150..900)
  }

  @Test
  fun `it waits for every connection of every older generation`() {
    val gate = ConnectionGate()
    gate.beginMedia(1)
    gate.opened(1)
    gate.opened(1)
    gate.beginMedia(2)
    gate.opened(2)
    gate.beginMedia(3)
    val start = System.nanoTime()
    val closer = later(100) {
      gate.closed(1)
      gate.closed(2)
      Thread.sleep(150)
      gate.closed(1)
    }
    assertTrue(gate.awaitPreviousClosed(3, 1_000))
    val waited = elapsedMs(start)
    closer.join()
    assertTrue("waited $waited ms", waited in 200..900)
  }

  @Test
  fun `it times out at 1,000 ms, force-closes the older connections and reports forced`() {
    val gate = ConnectionGate()
    val forced = AtomicInteger()
    gate.beginMedia(1)
    gate.opened(1) { forced.incrementAndGet() }
    gate.beginMedia(2)
    val start = System.nanoTime()
    assertFalse(gate.awaitPreviousClosed(2, 1_000))
    val waited = elapsedMs(start)
    assertTrue("waited $waited ms", waited in 1_000..1_500)
    assertEquals(1, forced.get())
  }

  @Test
  fun `a forced generation is not waited for again and its late close is ignored`() {
    val gate = ConnectionGate()
    val forced = AtomicInteger()
    gate.beginMedia(1)
    gate.opened(1) { forced.incrementAndGet() }
    gate.beginMedia(2)
    assertFalse(gate.awaitPreviousClosed(2, 50))
    gate.closed(1)
    gate.opened(2)
    gate.closed(2)
    val start = System.nanoTime()
    assertTrue(gate.awaitPreviousClosed(2, 1_000))
    assertTrue(elapsedMs(start) < 100)
    assertEquals(1, forced.get())
  }

  @Test
  fun `a closed connection is not force-closed`() {
    val gate = ConnectionGate()
    val forced = AtomicInteger()
    val first = ForceClosable { forced.incrementAndGet() }
    val second = ForceClosable { forced.addAndGet(10) }
    gate.beginMedia(1)
    gate.opened(1, first)
    gate.opened(1, second)
    gate.closed(1, first)
    gate.beginMedia(2)
    assertFalse(gate.awaitPreviousClosed(2, 50))
    assertEquals(10, forced.get())
  }

  @Test
  fun `a generation is stale once a newer one began`() {
    val gate = ConnectionGate()
    gate.beginMedia(1)
    assertFalse(gate.isStale(1))
    gate.beginMedia(2)
    assertTrue(gate.isStale(1))
    assertFalse(gate.isStale(2))
    gate.beginMedia(1)
    assertTrue(gate.isStale(1))
  }

  @Test
  fun `a superseded waiter stops waiting without forcing`() {
    val gate = ConnectionGate()
    val forced = AtomicInteger()
    gate.beginMedia(1)
    gate.opened(1) { forced.incrementAndGet() }
    gate.beginMedia(2)
    val start = System.nanoTime()
    val zap = later(100) { gate.beginMedia(3) }
    assertTrue(gate.awaitPreviousClosed(2, 1_000))
    val waited = elapsedMs(start)
    zap.join()
    assertTrue("waited $waited ms", waited in 50..900)
    assertTrue(gate.isStale(2))
    assertEquals(0, forced.get())
  }

  @Test
  fun `an interrupted waiter throws InterruptedException`() {
    val gate = ConnectionGate()
    gate.beginMedia(1)
    gate.opened(1)
    gate.beginMedia(2)
    val failure = AtomicReference<Throwable?>()
    val started = CountDownLatch(1)
    val waiter = Thread {
      started.countDown()
      try {
        gate.awaitPreviousClosed(2, 5_000)
      } catch (e: Throwable) {
        failure.set(e)
      }
    }
    waiter.start()
    started.await()
    Thread.sleep(50)
    waiter.interrupt()
    waiter.join(2_000)
    assertTrue(failure.get() is InterruptedException)
  }
}

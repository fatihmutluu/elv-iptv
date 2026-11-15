package io.github.fatihmutluu.elv.media3

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
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
 * with a zero timeout, which forces at once if anything older is still open. A loaded CI runner cannot break them.
 * Force-closes run on the calling thread ([inline]), so their effects are visible as soon as the call returns.
 */
class ConnectionGateTest {
  private val patientMs = 10_000L
  private val inline = Executor { it.run() }

  private fun elapsedMs(since: Long): Long = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - since)

  /** Runs one wait of generation 2 on its own (daemon) thread, so a wait that never ends cannot hang the suite. */
  private fun waitFor2(gate: ConnectionGate, timeoutMs: Long): Pair<Thread, AtomicReference<BoundaryWait?>> {
    val result = AtomicReference<BoundaryWait?>()
    return thread(isDaemon = true) { result.set(gate.awaitPreviousClosed(2, timeoutMs)) } to result
  }

  private fun later(delayMs: Long, action: () -> Unit): Thread =
    Thread {
      Thread.sleep(delayMs)
      action()
    }.also { it.start() }

  /** A connection whose force-close aborts it, after which its owner reports it closed (what Media3 does). */
  private class Aborting(private val gate: ConnectionGate, private val generation: Long) : ForceClosable {
    val forced = AtomicInteger()

    override fun forceClose() {
      forced.incrementAndGet()
      gate.closed(generation, this)
    }
  }

  @Test
  fun `the first media opens without waiting`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(1, 0))
  }

  @Test
  fun `connections of the same media never wait for each other`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    assertTrue(gate.tryOpen(1))
    assertTrue(gate.tryOpen(1))
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(1, 0))
  }

  @Test
  fun `a second generation waits until the first closes`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    gate.tryOpen(1)
    gate.beginMedia(2)
    val start = System.nanoTime()
    val closer = later(200) { gate.closed(1) }
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, patientMs))
    val waited = elapsedMs(start)
    closer.join()
    assertTrue("waited $waited ms", waited >= 150)
  }

  @Test
  fun `it waits for every connection of every older generation`() {
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
  fun `a new media force-closes every older connection at once, without any waiter`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    val first = Aborting(gate, 1)
    val second = Aborting(gate, 1)
    gate.tryOpen(1, first)
    gate.tryOpen(1, second)
    gate.beginMedia(2)
    assertEquals(1, first.forced.get())
    assertEquals(1, second.forced.get())
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `beginning the current generation again forces nothing, a newer one forces its connections`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    val open = Aborting(gate, 1)
    gate.tryOpen(1, open)
    gate.beginMedia(1)
    assertEquals(0, open.forced.get())
    gate.beginMedia(2)
    assertEquals(1, open.forced.get())
  }

  @Test
  fun `the force-close runs on the closer, not on the thread that begins the media`() {
    val queued = mutableListOf<Runnable>()
    val gate = ConnectionGate { queued += it }
    gate.beginMedia(1)
    val open = Aborting(gate, 1)
    gate.tryOpen(1, open)
    gate.beginMedia(2)
    assertEquals(0, open.forced.get())
    assertEquals(1, queued.size)
    queued.single().run()
    assertEquals(1, open.forced.get())
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `a forced connection stays counted until its owner reports it closed`() {
    val gate = ConnectionGate(inline)
    val forced = AtomicInteger()
    val stuck = ForceClosable { forced.incrementAndGet() }
    gate.beginMedia(1)
    gate.tryOpen(1, stuck)
    gate.beginMedia(2)
    assertEquals(1, forced.get())
    val start = System.nanoTime()
    val owner = later(300) { gate.closed(1, stuck) }
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, patientMs))
    val waited = elapsedMs(start)
    owner.join()
    assertTrue("waited $waited ms", waited >= 250)
  }

  @Test
  fun `after the backstop it forces again, keeps waiting for the close and reports forced`() {
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
    val waited = elapsedMs(start)
    assertTrue("waited $waited ms", waited >= 200)
    assertEquals(2, forced.get())
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `a closed connection is not force-closed`() {
    val gate = ConnectionGate(inline)
    val first = Aborting(gate, 1)
    val second = Aborting(gate, 1)
    gate.beginMedia(1)
    gate.tryOpen(1, first)
    gate.tryOpen(1, second)
    gate.closed(1, first)
    gate.beginMedia(2)
    assertEquals(0, first.forced.get())
    assertEquals(1, second.forced.get())
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `a superseded generation cannot open and is not counted`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    assertTrue(gate.tryOpen(1))
    gate.closed(1)
    gate.beginMedia(2)
    assertFalse(gate.tryOpen(1))
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
    assertTrue(gate.tryOpen(2))
    gate.beginMedia(1)
    assertTrue(gate.tryOpen(2))
  }

  @Test
  fun `a superseded waiter stops waiting without forcing anything itself`() {
    val gate = ConnectionGate(inline)
    val forced = AtomicInteger()
    val stuck = ForceClosable { forced.incrementAndGet() }
    gate.beginMedia(1)
    gate.tryOpen(1, stuck)
    gate.beginMedia(2)
    val start = System.nanoTime()
    val zap = later(100) { gate.beginMedia(3) }
    assertEquals(BoundaryWait.SUPERSEDED, gate.awaitPreviousClosed(2, patientMs))
    val waited = elapsedMs(start)
    zap.join()
    assertTrue("waited $waited ms", waited >= 50)
    assertFalse(gate.tryOpen(2))
    assertEquals("one force per new media, none by the waiter", 2, forced.get())
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
    }
    waiter.start()
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
    val waited = elapsedMs(start)
    assertEquals(BoundaryWait.DROPPED, result.get())
    assertTrue("waited $waited ms", waited >= 200 + DROP_AFTER_MS)
    assertEquals("forced by the new media and by the backstop", 2, forced.get())
    assertEquals(BoundaryWait.CLOSED, gate.awaitPreviousClosed(2, 0))
  }

  @Test
  fun `a connection whose force-close has not finished is never dropped`() {
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
  fun `a released player's forced connections are dropped at once`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    gate.tryOpen(1) {}
    gate.beginMedia(2)
    gate.dropForced()
    val (waiter, result) = waitFor2(gate, patientMs)
    waiter.join(patientMs)
    assertEquals(BoundaryWait.CLOSED, result.get())
  }

  @Test
  fun `a dropped connection's late close does not uncount another connection of its media`() {
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
    assertTrue("the late close uncounted the open connection", waiter.isAlive)
    gate.closed(1)
    waiter.join(patientMs)
    assertEquals(BoundaryWait.CLOSED, result.get())
  }

  @Test
  fun `a waiter superseded during the second wait reports superseded, not a forced close`() {
    val gate = ConnectionGate(inline)
    gate.beginMedia(1)
    gate.tryOpen(1) {}
    gate.beginMedia(2)
    val (waiter, result) = waitFor2(gate, 100)
    val zap = later(400) { gate.beginMedia(3) }
    waiter.join(patientMs)
    zap.join()
    assertEquals(BoundaryWait.SUPERSEDED, result.get())
  }
}

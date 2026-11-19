package io.github.fatihmutluu.elv.media3

import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * After the backstop's second force-close, a connection whose force-close finished (its call is cancelled) but that
 * never reported closed is dropped this late: the cancel closed its socket in every OkHttp phase, and a call
 * cancelled during DNS never sent its request, so the provider sees no overlap.
 */
internal const val DROP_AFTER_MS = 1_500L

/** Drop cycles past [ConnectionGate.awaitPreviousClosed]'s initial timeout before force-dropping a stalled closer. */
private const val STALLED_CLOSER_DROP_CYCLES = 2

/** How [ConnectionGate.awaitPreviousClosed] ended. */
enum class BoundaryWait {
  /** Nothing older was open, or it closed before the backstop. */
  CLOSED,

  /** The waiting media was superseded itself. */
  SUPERSEDED,

  /** The older connections closed only after the backstop's second force-close. */
  CLOSED_AFTER_FORCE,

  /** Older connections whose calls were cancelled never closed and were dropped [DROP_AFTER_MS] after the backstop. */
  DROPPED,
}

/** A connection the gate can close when its media is superseded. */
fun interface ForceClosable {
  fun forceClose()
}

/**
 * Media-boundary connection gate (player core spec 5.1): every connection is counted under the generation of the
 * media that opened it, and a newer media's open waits until no older generation has an open connection. A new
 * media force-closes every older connection at once on [closer] (a close may block, so never on the thread that
 * begins the media); a forced connection stays counted until its owner reports it closed, so the next media never
 * opens beside a connection that is still open, unless it is dropped: [DROP_AFTER_MS] after the backstop, or when its
 * player was released ([dropForced]). Within one generation connections never wait for each other (HLS playlists and
 * segments). Thread-safe; loader threads call [tryOpen], [closed] and [awaitPreviousClosed], the playback thread calls
 * [beginMedia] and [dropForced].
 */
class ConnectionGate(private val closer: Executor) {
  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private var current = 0L
  private var releasedBefore = 0L
  private val counts = HashMap<Long, Int>()
  private val connections = HashMap<Long, MutableSet<ForceClosable>>()

  /** Registered connections currently queued or running on [closer]. */
  private val forcing = HashSet<ForceClosable>()

  /** Registered connections whose force-close finished (or whose closer rejected): eligible for backstop drop. */
  private val cancelled = HashSet<ForceClosable>()

  private enum class Older { CLOSED, SUPERSEDED, OPEN }

  /**
   * Makes [generation] the current media: its waiters re-check, and the connections of every older generation are
   * force-closed at once.
   */
  fun beginMedia(generation: Long) {
    val superseded = lock.withLock {
      if (generation > current) current = generation
      changed.signalAll()
      connectionsOlderThan(current).also { forcing.addAll(it) }
    }
    forceClose(superseded)
  }

  /**
   * Counts one open connection of [generation] unless a newer generation already began, in one locked step, so a
   * connection is never counted for a superseded media. [connection] is force-closed when its media is superseded.
   * Returns false (nothing counted) for a superseded generation.
   */
  fun tryOpen(generation: Long, connection: ForceClosable? = null): Boolean =
    lock.withLock {
      if (generation < current) return@withLock false
      counts[generation] = (counts[generation] ?: 0) + 1
      if (connection != null) connections.getOrPut(generation) { HashSet() }.add(connection)
      true
    }

  /** Counts one closed connection of [generation]; the late close of a dropped connection is ignored. */
  fun closed(generation: Long, connection: ForceClosable? = null) {
    lock.withLock {
      if (connection != null) {
        forcing.remove(connection)
        cancelled.remove(connection)
        if (connections[generation]?.remove(connection) != true) return
      }
      uncount(generation)
    }
  }

  /**
   * Forgets every superseded connection of a released player once its force-close has finished: the player that owned
   * it was released, so its close may never come (a loader parked on a full buffer only closes when its period is
   * released). Any older connection not yet queued for force-close is queued now.
   */
  fun dropForced() {
    val unforced = lock.withLock {
      if (current > releasedBefore) releasedBefore = current
      drop(releasedBefore)
      connectionsOlderThan(releasedBefore).filter { it !in cancelled && it !in forcing }.also { forcing.addAll(it) }
    }
    forceClose(unforced)
  }

  /**
   * Blocks until no generation older than [generation] has an open connection, or until [generation] itself is
   * superseded. After [timeoutMs] (a backstop: the new media already forced them) it force-closes the older
   * connections still open again and keeps waiting for their close; every [DROP_AFTER_MS] after that it drops older
   * connections whose force-close finished (and after [STALLED_CLOSER_DROP_CYCLES] cycles also drops registered
   * connections stuck in a blocked closer so a stalled closer cannot hang the boundary forever).
   */
  fun awaitPreviousClosed(generation: Long, timeoutMs: Long): BoundaryWait {
    when (waitForOlder(generation, timeoutMs)) {
      Older.CLOSED -> return BoundaryWait.CLOSED
      Older.SUPERSEDED -> return BoundaryWait.SUPERSEDED
      Older.OPEN -> Unit
    }
    forceClose(lock.withLock { connectionsOlderThan(generation).also { forcing.addAll(it) } })
    var dropped = false
    var cycles = 0
    while (true) {
      when (waitForOlder(generation, DROP_AFTER_MS)) {
        Older.CLOSED -> return if (dropped) BoundaryWait.DROPPED else BoundaryWait.CLOSED_AFTER_FORCE
        Older.SUPERSEDED -> return if (dropped) BoundaryWait.DROPPED else BoundaryWait.SUPERSEDED
        Older.OPEN -> {
          cycles += 1
          val includeStalled = cycles >= STALLED_CLOSER_DROP_CYCLES
          if (lock.withLock { drop(generation, includeStalled = includeStalled) } > 0) dropped = true
        }
      }
    }
  }

  /** Waits up to [timeoutMs] while something older than [generation] is open and [generation] is current. */
  private fun waitForOlder(generation: Long, timeoutMs: Long): Older =
    lock.withLock {
      var remainingNs = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
      var state = olderState(generation)
      while (state == Older.OPEN && remainingNs > 0L) {
        remainingNs = changed.awaitNanos(remainingNs)
        state = olderState(generation)
      }
      state
    }

  /** Under [lock]. */
  private fun olderState(generation: Long): Older =
    when {
      generation < current -> Older.SUPERSEDED
      counts.keys.none { it < generation } -> Older.CLOSED
      else -> Older.OPEN
    }

  private fun connectionsOlderThan(generation: Long): List<ForceClosable> =
    connections.filterKeys { it < generation }.values.flatten()

  /** Under [lock]: forgets eligible connections of generations older than [generation]; returns how many. */
  private fun drop(generation: Long, includeStalled: Boolean = false): Int {
    var dropped = 0
    for ((owner, open) in connections.filterKeys { it < generation }) {
      val eligible = open.filter { it in cancelled || (includeStalled && it in forcing) }
      for (connection in eligible) {
        open.remove(connection)
        forcing.remove(connection)
        cancelled.remove(connection)
        uncount(owner)
        dropped += 1
      }
    }
    return dropped
  }

  /** Under [lock]: one connection of [generation] fewer. */
  private fun uncount(generation: Long) {
    val open = counts[generation] ?: return
    if (open <= 1) {
      counts.remove(generation)
      connections.remove(generation)
    } else {
      counts[generation] = open - 1
    }
    changed.signalAll()
  }

  private fun forceClose(overstaying: List<ForceClosable>) {
    if (overstaying.isEmpty()) return
    try {
      closer.execute {
        for (connection in overstaying) {
          try {
            connection.forceClose()
          } catch (_: Exception) {
          }
          lock.withLock {
            forcing.remove(connection)
            if (connections.values.any { connection in it }) {
              cancelled.add(connection)
              if (releasedBefore > 0L) drop(releasedBefore)
            }
          }
        }
      }
    } catch (_: RejectedExecutionException) {
      lock.withLock {
        for (connection in overstaying) {
          forcing.remove(connection)
          if (connections.values.any { connection in it }) {
            cancelled.add(connection)
          }
        }
        if (releasedBefore > 0L) drop(releasedBefore)
      }
    }
  }
}

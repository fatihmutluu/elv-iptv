package io.github.fatihmutluu.elv.media3

import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** A connection the gate can close when its media is superseded. */
fun interface ForceClosable {
  fun forceClose()
}

/**
 * Media-boundary connection gate (player core spec 5.1): every connection is counted under the generation of the
 * media that opened it, and a newer media's open waits until no older generation has an open connection. A new
 * media force-closes every older connection at once on [closer] (a close may block, so never on the thread that
 * begins the media); a forced connection stays counted until its owner reports it closed, so the next media never
 * opens beside a connection that is still open. Within one generation connections never wait for each other (HLS
 * playlists and segments). Thread-safe; loader threads call [tryOpen], [closed] and [awaitPreviousClosed], the
 * playback thread calls [beginMedia].
 */
class ConnectionGate(private val closer: Executor) {
  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private var current = 0L
  private val counts = HashMap<Long, Int>()
  private val connections = HashMap<Long, MutableSet<ForceClosable>>()

  /**
   * Makes [generation] the current media: its waiters re-check, and the connections of every older generation are
   * force-closed at once.
   */
  fun beginMedia(generation: Long) {
    val superseded = lock.withLock {
      if (generation > current) current = generation
      changed.signalAll()
      connectionsOlderThan(current)
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

  /** Counts one closed connection of [generation]; it is no longer force-closed. */
  fun closed(generation: Long, connection: ForceClosable? = null) {
    lock.withLock {
      val open = counts[generation] ?: return
      if (connection != null) connections[generation]?.remove(connection)
      if (open <= 1) {
        counts.remove(generation)
        connections.remove(generation)
      } else {
        counts[generation] = open - 1
      }
      changed.signalAll()
    }
  }

  /**
   * Blocks until no generation older than [generation] has an open connection, or until [generation] itself is
   * superseded. After [timeoutMs] (a backstop: the new media already forced them) it force-closes the older
   * connections still open again and keeps waiting for their close, which a forced connection reports once its open or
   * read has ended; then it returns false. Returns true when it did not have to force. Throws [InterruptedException]
   * when the waiting thread is interrupted.
   */
  fun awaitPreviousClosed(generation: Long, timeoutMs: Long): Boolean {
    if (waitForOlder(generation, TimeUnit.MILLISECONDS.toNanos(timeoutMs))) return true
    forceClose(lock.withLock { connectionsOlderThan(generation) })
    waitForOlder(generation, null)
    return false
  }

  /** True once nothing older than [generation] is open or [generation] is superseded; false when [timeoutNs] ran out. */
  private fun waitForOlder(generation: Long, timeoutNs: Long?): Boolean =
    lock.withLock {
      var remainingNs = timeoutNs
      while (generation >= current && counts.keys.any { it < generation }) {
        when {
          remainingNs == null -> changed.await()
          remainingNs <= 0L -> return@withLock false
          else -> remainingNs = changed.awaitNanos(remainingNs)
        }
      }
      true
    }

  private fun connectionsOlderThan(generation: Long): List<ForceClosable> =
    connections.filterKeys { it < generation }.values.flatten()

  private fun forceClose(overstaying: List<ForceClosable>) {
    if (overstaying.isEmpty()) return
    closer.execute {
      for (connection in overstaying) {
        try {
          connection.forceClose()
        } catch (_: Exception) {
        }
      }
    }
  }
}

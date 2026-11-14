package io.github.fatihmutluu.elv.media3

import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** A connection the gate can close when its media overstays a media boundary. */
fun interface ForceClosable {
  fun forceClose()
}

/**
 * Media-boundary connection gate (player core spec 5.1): every connection is counted under the generation of the
 * media that opened it, and a newer media's open waits until no older generation has an open connection. Within one
 * generation connections never wait for each other (HLS playlists and segments). Thread-safe; loader threads call
 * [opened], [closed] and [awaitPreviousClosed], the playback thread calls [beginMedia].
 */
class ConnectionGate {
  private val lock = ReentrantLock()
  private val changed = lock.newCondition()
  private var current = 0L
  private val counts = HashMap<Long, Int>()
  private val connections = HashMap<Long, MutableSet<ForceClosable>>()

  /** Makes [generation] the current media; older generations become stale and their waiters re-check. */
  fun beginMedia(generation: Long) {
    lock.withLock {
      if (generation > current) current = generation
      changed.signalAll()
    }
  }

  /** True once a newer generation began: the media is superseded and must not open connections. */
  fun isStale(generation: Long): Boolean = lock.withLock { generation < current }

  /** Counts one open connection of [generation]; [connection] is force-closed if it overstays a boundary. */
  fun opened(generation: Long, connection: ForceClosable? = null) {
    lock.withLock {
      counts[generation] = (counts[generation] ?: 0) + 1
      if (connection != null) connections.getOrPut(generation) { HashSet() }.add(connection)
    }
  }

  /** Counts one closed connection of [generation]; a close of a generation already forced is ignored. */
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
   * superseded. After [timeoutMs] it force-closes the remaining older connections, forgets them and returns false;
   * otherwise it returns true. Throws [InterruptedException] when the waiting thread is interrupted.
   */
  fun awaitPreviousClosed(generation: Long, timeoutMs: Long): Boolean {
    val overstaying = lock.withLock {
      var remainingNs = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
      while (generation >= current && counts.keys.any { it < generation }) {
        if (remainingNs <= 0L) return@withLock forgetOlderThan(generation)
        remainingNs = changed.awaitNanos(remainingNs)
      }
      return true
    }
    for (connection in overstaying) {
      try {
        connection.forceClose()
      } catch (_: Exception) {
      }
    }
    return false
  }

  private fun forgetOlderThan(generation: Long): List<ForceClosable> {
    val older = counts.keys.filter { it < generation }
    val closers = older.flatMap { connections[it].orEmpty() }
    older.forEach {
      counts.remove(it)
      connections.remove(it)
    }
    changed.signalAll()
    return closers
  }
}

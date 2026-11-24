package io.github.fatihmutluu.elv.media3

import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

internal const val TIMESHIFT_CACHE_SUBDIR = "timeshift"
internal const val TIMESHIFT_LOW_RAM_MAX_BYTES: Long = 64L * 1024L * 1024L
internal const val TIMESHIFT_STANDARD_MAX_BYTES: Long = 256L * 1024L * 1024L

/** Returns the bounded disk capacity for live time-shift storage: 64 MiB on low-RAM devices, 256 MiB otherwise (#28). */
internal fun maxTimeShiftBytesFor(lowRam: Boolean): Long =
  if (lowRam) TIMESHIFT_LOW_RAM_MAX_BYTES else TIMESHIFT_STANDARD_MAX_BYTES

/** Synchronously removes any stale time-shift backing files under `cacheDir/timeshift/` so zero orphan files remain (#28). */
internal fun purgeTimeShiftCacheDir(cacheDir: File) {
  val dir = File(cacheDir, TIMESHIFT_CACHE_SUBDIR)
  if (!dir.exists() || !dir.isDirectory) return
  dir.listFiles()?.forEach { child ->
    if (child.isDirectory) {
      child.deleteRecursively()
    } else {
      child.delete()
    }
  }
}

/** Immutable point-in-time snapshot of [TimeShiftRingBuffer] offsets and state (#28). */
internal data class TimeShiftBufferSnapshot(
  val capacityBytes: Long,
  val oldestAvailableOffset: Long,
  val totalWrittenBytes: Long,
  val bufferedBytes: Long,
  val readOffset: Long,
  val closed: Boolean,
)

/**
 * Thread-safe, strictly bounded disk ring buffer under `cacheDir/timeshift/` for live time-shift (#28).
 *
 * Maintains the invariant that every live logical byte `p` in `[oldestAvailableOffset, totalWrittenBytes)` resides at
 * physical file offset `p % capacityBytes`, ensuring disk usage never exceeds [capacityBytes] and never inflates
 * ExoPlayer's heap `DefaultLoadControl` budget. Both [reset] and [close] synchronously delete the backing file.
 */
internal class TimeShiftRingBuffer(
  cacheDir: File,
  val capacityBytes: Long,
) : Closeable {
  init {
    require(capacityBytes > 0L) { "capacityBytes must be positive" }
  }

  private val lock = Any()
  private val dir = File(cacheDir, TIMESHIFT_CACHE_SUBDIR)
  internal val backingFile: File = File(dir, "ts-${UUID.randomUUID()}.bin")

  private var raf: RandomAccessFile? = null
  private var totalWrittenBytes = 0L
  private var oldestAvailableOffset = 0L
  private var readOffset = 0L
  private var closed = false

  /** Appends [length] bytes from [data] starting at [offset] into the ring, overwriting the oldest bytes past [capacityBytes]. */
  fun write(data: ByteArray, offset: Int = 0, length: Int = data.size - offset): Int {
    require(offset >= 0 && length >= 0 && offset + length <= data.size) { "invalid slice bounds" }
    synchronized(lock) {
      if (closed) return -1
      if (length == 0) return 0
      val file = ensureOpenLocked()
      val newTotal = totalWrittenBytes + length.toLong()
      val newOldest = maxOf(0L, newTotal - capacityBytes)
      val writeLen = minOf(length.toLong(), capacityBytes).toInt()
      val srcStart = offset + (length - writeLen)
      val logicalWriteStart = newTotal - writeLen.toLong()

      val physStart = logicalWriteStart % capacityBytes
      val firstLen = minOf(writeLen.toLong(), capacityBytes - physStart).toInt()
      file.seek(physStart)
      file.write(data, srcStart, firstLen)
      val wrappedLen = writeLen - firstLen
      if (wrappedLen > 0) {
        file.seek(0L)
        file.write(data, srcStart + firstLen, wrappedLen)
      }

      totalWrittenBytes = newTotal
      oldestAvailableOffset = newOldest
      if (readOffset < oldestAvailableOffset) {
        readOffset = oldestAvailableOffset
      }
      return length
    }
  }

  /** Reads up to [length] bytes at the current logical read cursor into [buffer] at [offset]. Returns `0` at head or `-1` when closed. */
  fun read(buffer: ByteArray, offset: Int = 0, length: Int = buffer.size - offset): Int {
    require(offset >= 0 && length >= 0 && offset + length <= buffer.size) { "invalid slice bounds" }
    synchronized(lock) {
      if (closed) return -1
      if (length == 0) return 0
      if (readOffset < oldestAvailableOffset) {
        readOffset = oldestAvailableOffset
      }
      val available = totalWrittenBytes - readOffset
      if (available <= 0L) return 0
      val file = raf ?: return 0
      val toRead = minOf(length.toLong(), available).toInt()
      val physStart = readOffset % capacityBytes
      val firstLen = minOf(toRead.toLong(), capacityBytes - physStart).toInt()
      file.seek(physStart)
      file.readFully(buffer, offset, firstLen)
      val wrappedLen = toRead - firstLen
      if (wrappedLen > 0) {
        file.seek(0L)
        file.readFully(buffer, offset + firstLen, wrappedLen)
      }
      readOffset += toRead.toLong()
      return toRead
    }
  }

  /** Moves the logical read cursor, clamped strictly to `[oldestAvailableOffset, totalWrittenBytes]`, or `-1` if closed. */
  fun seek(logicalOffset: Long): Long = synchronized(lock) {
    if (closed) return -1L
    readOffset = logicalOffset.coerceIn(oldestAvailableOffset, totalWrittenBytes)
    readOffset
  }

  /** Returns an immutable snapshot of current buffer bounds and cursor positions. */
  fun snapshot(): TimeShiftBufferSnapshot = synchronized(lock) {
    TimeShiftBufferSnapshot(
      capacityBytes = capacityBytes,
      oldestAvailableOffset = oldestAvailableOffset,
      totalWrittenBytes = totalWrittenBytes,
      bufferedBytes = (totalWrittenBytes - oldestAvailableOffset).coerceAtLeast(0L),
      readOffset = readOffset,
      closed = closed,
    )
  }

  /** Synchronously closes and deletes the backing file and resets all pointers so idle sessions leave zero disk state. */
  fun reset() = synchronized(lock) {
    closeAndDeleteLocked()
    totalWrittenBytes = 0L
    oldestAvailableOffset = 0L
    readOffset = 0L
  }

  /** Permanently closes the buffer and synchronously deletes its backing file. */
  override fun close() = synchronized(lock) {
    closed = true
    closeAndDeleteLocked()
    totalWrittenBytes = 0L
    oldestAvailableOffset = 0L
    readOffset = 0L
  }

  private fun ensureOpenLocked(): RandomAccessFile {
    raf?.let { return it }
    if (!dir.exists()) {
      dir.mkdirs()
    }
    return RandomAccessFile(backingFile, "rw").also { raf = it }
  }

  private fun closeAndDeleteLocked() {
    val active = raf
    raf = null
    if (active != null) {
      try {
        active.close()
      } catch (_: IOException) {
        // Best-effort close before synchronous file deletion.
      }
    }
    if (backingFile.exists()) {
      backingFile.delete()
    }
  }

  companion object {
    private val startupPurgeDone = AtomicBoolean(false)

    /** Creates a ring buffer sized strictly for the device's memory tier (`64 MiB` low-RAM / `256 MiB` standard). */
    fun create(cacheDir: File, lowRam: Boolean): TimeShiftRingBuffer =
      TimeShiftRingBuffer(cacheDir, maxTimeShiftBytesFor(lowRam))

    /**
     * Removes stale crash-orphan files under `cacheDir/timeshift/` at most once per process startup so overlapping
     * engine instances never wipe one another's active session files (#28).
     */
    fun purgeOrphansOnStartup(cacheDir: File): Boolean {
      if (!startupPurgeDone.compareAndSet(false, true)) return false
      purgeTimeShiftCacheDir(cacheDir)
      return true
    }

    internal fun resetStartupPurgeForTest() {
      startupPurgeDone.set(false)
    }
  }
}

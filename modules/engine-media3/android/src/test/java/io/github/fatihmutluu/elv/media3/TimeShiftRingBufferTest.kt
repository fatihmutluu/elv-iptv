package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSpec
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class TimeShiftRingBufferTest {
  private lateinit var tempCacheDir: File

  @Before
  fun setUp() {
    tempCacheDir = Files.createTempDirectory("elv-timeshift-test-").toFile()
  }

  @After
  fun tearDown() {
    tempCacheDir.deleteRecursively()
  }

  @Test
  fun `enforces 64 MiB low-RAM and 256 MiB standard disk budgets without raising LoadControl 16 MiB heap cap (#28)`() {
    assertEquals(64L * 1024L * 1024L, maxTimeShiftBytesFor(lowRam = true))
    assertEquals(256L * 1024L * 1024L, maxTimeShiftBytesFor(lowRam = false))

    // Low-RAM heap LoadControl invariant must remain strictly capped at 16 MiB across all presets
    val lowRamHeapCap = 16 * 1024 * 1024
    for (kind in StreamKind.entries) {
      for (preset in BufferPreset.entries) {
        val values = loadControlForStream(
          isLowRamDevice = true,
          totalMemBytes = 1024L * 1024L * 1024L,
          streamKind = kind,
          preset = preset,
        )
        assertEquals(lowRamHeapCap, values.targetBufferBytes)
        assertFalse(values.prioritizeTimeOverSizeThresholds)
      }
    }
  }

  @Test
  fun `writes, reads, seeks, and wraps cleanly within strict disk capacity bound`() {
    val capacity = 16L
    TimeShiftRingBuffer(tempCacheDir, capacity).use { ring ->
      val first = "ABCDEFGHIJ".encodeToByteArray() // 10 bytes (logical 0..10)
      assertEquals(10, ring.write(first))
      assertEquals(10L, ring.backingFile.length())

      val out1 = ByteArray(4)
      assertEquals(4, ring.read(out1))
      assertArrayEquals("ABCD".encodeToByteArray(), out1)

      // Wrap around capacity (write 12 more -> logical 0..22, oldest = 6, retained = "GHIJ0123456789ab")
      val second = "0123456789ab".encodeToByteArray()
      assertEquals(12, ring.write(second))
      assertTrue(
        "backing file length (${ring.backingFile.length()}) must never exceed capacity ($capacity)",
        ring.backingFile.length() <= capacity,
      )

      val snap = ring.snapshot()
      assertEquals(6L, snap.oldestAvailableOffset)
      assertEquals(22L, snap.totalWrittenBytes)
      assertEquals(16L, snap.bufferedBytes)
      // Cursor at 4 was overwritten -> clamped forward to oldestAvailableOffset (6)
      assertEquals(6L, snap.readOffset)

      val all = ByteArray(16)
      assertEquals(16, ring.read(all))
      assertArrayEquals("GHIJ0123456789ab".encodeToByteArray(), all)
      assertEquals(0, ring.read(ByteArray(4)))

      // Seek clamps strictly inside [oldestAvailableOffset, totalWrittenBytes]
      assertEquals(6L, ring.seek(0L))
      assertEquals(22L, ring.seek(999L))
      assertEquals(10L, ring.seek(10L))
      val tail = ByteArray(6)
      assertEquals(6, ring.read(tail))
      assertArrayEquals("012345".encodeToByteArray(), tail)
    }
  }

  @Test
  fun `handles single write larger than capacity by retaining only the trailing capacity bytes`() {
    val capacity = 8L
    TimeShiftRingBuffer(tempCacheDir, capacity).use { ring ->
      val payload = "0123456789ABCDEF".encodeToByteArray() // 16 bytes
      assertEquals(16, ring.write(payload))
      assertEquals(8L, ring.backingFile.length())
      assertEquals(8L, ring.snapshot().oldestAvailableOffset)
      assertEquals(16L, ring.snapshot().totalWrittenBytes)

      val out = ByteArray(8)
      assertEquals(8, ring.read(out))
      assertArrayEquals("89ABCDEF".encodeToByteArray(), out)
    }
  }

  @Test
  fun `reset and close delete backing files synchronously leaving zero orphan files`() {
    val ring = TimeShiftRingBuffer.create(tempCacheDir, lowRam = true)
    assertEquals(TIMESHIFT_LOW_RAM_MAX_BYTES, ring.capacityBytes)
    ring.write("hello-timeshift".encodeToByteArray())
    val backing = ring.backingFile
    assertTrue(backing.exists())

    ring.reset()
    assertFalse("reset() must delete backing file synchronously", backing.exists())
    assertEquals(0L, ring.snapshot().totalWrittenBytes)
    assertEquals(0L, ring.snapshot().bufferedBytes)

    // Subsequent write reopens cleanly, and close() deletes synchronously and rejects further ops
    ring.write("after-reset".encodeToByteArray())
    assertTrue(backing.exists())
    ring.close()
    assertFalse("close() must delete backing file synchronously", backing.exists())
    assertTrue(ring.snapshot().closed)
    assertEquals(-1, ring.write("x".encodeToByteArray()))
    assertEquals(-1, ring.read(ByteArray(4)))
    assertEquals(-1L, ring.seek(0L))

    // purgeTimeShiftCacheDir removes any stale files under cacheDir/timeshift/
    val staleDir = File(tempCacheDir, TIMESHIFT_CACHE_SUBDIR).apply { mkdirs() }
    val staleFile = File(staleDir, "stale-orphan.bin").apply { writeText("orphan") }
    assertTrue(staleFile.exists())
    purgeTimeShiftCacheDir(tempCacheDir)
    assertFalse(staleFile.exists())
    assertEquals(0, staleDir.listFiles()?.size ?: 0)
  }

  @Test
  fun `evaluates Media3 live time-shift windows and live seek clamping accurately`() {
    // Seekable live window > 2s -> timeShiftSupported = true, start = 0, edge = duration
    val seekable = evaluateLiveTimeShiftWindow(
      isLive = true,
      isCurrentMediaItemSeekable = true,
      isWindowLive = true,
      windowDurationMs = 45_000L,
      fallbackDurationMs = C.TIME_UNSET,
    )
    assertEquals(LiveTimeShiftWindowState(0L, 45_000L, true), seekable)

    // Live window <= 2s -> timeShiftSupported = false
    val tooShort = evaluateLiveTimeShiftWindow(
      isLive = true,
      isCurrentMediaItemSeekable = true,
      isWindowLive = true,
      windowDurationMs = 2_000L,
      fallbackDurationMs = 2_000L,
    )
    assertEquals(LiveTimeShiftWindowState(null, 2_000L, false), tooShort)

    // Non-seekable live stream -> timeShiftSupported = false, preserves fallback liveEdgeMs
    val unseekable = evaluateLiveTimeShiftWindow(
      isLive = true,
      isCurrentMediaItemSeekable = false,
      isWindowLive = true,
      windowDurationMs = C.TIME_UNSET,
      fallbackDurationMs = 30_000L,
    )
    assertEquals(LiveTimeShiftWindowState(null, 30_000L, false), unseekable)

    // VOD -> timeShiftSupported = false, null live bounds
    val vod = evaluateLiveTimeShiftWindow(
      isLive = false,
      isCurrentMediaItemSeekable = true,
      isWindowLive = false,
      windowDurationMs = 120_000L,
      fallbackDurationMs = 120_000L,
    )
    assertNull(vod.liveSeekableStartMs)
    assertNull(vod.liveEdgeMs)
    assertFalse(vod.timeShiftSupported)

    // resolveMedia3LiveSeek: ignores unseekable, clamps within [0, duration], snaps <= 1.5s from edge
    assertEquals(LiveSeekResolution.Ignore, resolveMedia3LiveSeek(10_000L, isSeekable = false, durationMs = 60_000L))
    assertEquals(LiveSeekResolution.SeekTo(0L), resolveMedia3LiveSeek(-500L, isSeekable = true, durationMs = 60_000L))
    assertEquals(LiveSeekResolution.SeekTo(30_000L), resolveMedia3LiveSeek(30_000L, isSeekable = true, durationMs = 60_000L))
    assertEquals(
      LiveSeekResolution.JumpToDefaultLiveEdge,
      resolveMedia3LiveSeek(58_500L, isSeekable = true, durationMs = 60_000L),
    )
    assertEquals(
      LiveSeekResolution.JumpToDefaultLiveEdge,
      resolveMedia3LiveSeek(99_000L, isSeekable = true, durationMs = 60_000L),
    )

    // Ring-buffer backed raw MPEG-TS exposes timeShiftSupported = true once >= 2_000 ms is buffered
    val ringTooShort = evaluateLiveTimeShiftWindow(
      isLive = true,
      isCurrentMediaItemSeekable = false,
      isWindowLive = false,
      windowDurationMs = C.TIME_UNSET,
      fallbackDurationMs = C.TIME_UNSET,
      ringWindow = RingBufferTimeShiftWindow(liveSeekableStartMs = 0L, liveEdgeMs = 1_999L, bufferedWindowMs = 1_999L),
    )
    assertFalse(ringTooShort.timeShiftSupported)
    assertNull(ringTooShort.liveSeekableStartMs)
    assertEquals(1_999L, ringTooShort.liveEdgeMs)

    val ringReady = evaluateLiveTimeShiftWindow(
      isLive = true,
      isCurrentMediaItemSeekable = false,
      isWindowLive = false,
      windowDurationMs = C.TIME_UNSET,
      fallbackDurationMs = C.TIME_UNSET,
      ringWindow = RingBufferTimeShiftWindow(liveSeekableStartMs = 5_000L, liveEdgeMs = 25_000L, bufferedWindowMs = 20_000L),
    )
    assertEquals(LiveTimeShiftWindowState(5_000L, 25_000L, true), ringReady)
  }

  @Test
  fun `isolates per-session ring files and guards cold-start orphan purge with one-shot AtomicBoolean`() {
    TimeShiftRingBuffer.resetStartupPurgeForTest()
    val staleDir = File(tempCacheDir, TIMESHIFT_CACHE_SUBDIR).apply { mkdirs() }
    val staleOrphan = File(staleDir, "crash-orphan.bin").apply { writeText("stale") }
    assertTrue(staleOrphan.exists())

    // First startup purge cleans stale crash orphans
    assertTrue(TimeShiftRingBuffer.purgeOrphansOnStartup(tempCacheDir))
    assertFalse(staleOrphan.exists())

    // Overlapping active sessions A and B keep distinct files; second startup purge is a no-op!
    val bufferA = TimeShiftRingBuffer(tempCacheDir, 64L)
    val bufferB = TimeShiftRingBuffer(tempCacheDir, 64L)
    try {
      bufferA.write("session-A-bytes".encodeToByteArray())
      bufferB.write("session-B-bytes".encodeToByteArray())
      assertTrue(bufferA.backingFile.exists())
      assertTrue(bufferB.backingFile.exists())

      // A second engine initializing in the same process must NOT wipe active buffer files
      assertFalse(TimeShiftRingBuffer.purgeOrphansOnStartup(tempCacheDir))
      assertTrue(bufferA.backingFile.exists())
      assertTrue(bufferB.backingFile.exists())

      // Closing buffer A deletes ONLY buffer A's backing file, never buffer B's!
      bufferA.close()
      assertFalse(bufferA.backingFile.exists())
      assertTrue("closing buffer A must never delete buffer B's file", bufferB.backingFile.exists())
    } finally {
      bufferA.close()
      bufferB.close()
    }
  }

  @OptIn(UnstableApi::class)
  @Test
  fun `TimeShiftDataSource tees upstream bytes, serves reads inside retained ring window, and tracks bufferedWindowMs`() {
    class FakeLiveDataSource(private val chunks: List<ByteArray>) : BaseDataSource(true) {
      var openCount = 0
      var closedCount = 0
      private var idx = 0
      private var chunkOffset = 0
      private var openedUri: Uri? = null

      override fun open(dataSpec: DataSpec): Long {
        openCount += 1
        openedUri = dataSpec.uri
        return C.LENGTH_UNSET.toLong()
      }

      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (idx >= chunks.size) return C.RESULT_END_OF_INPUT
        val current = chunks[idx]
        val available = current.size - chunkOffset
        val count = minOf(length, available)
        System.arraycopy(current, chunkOffset, buffer, offset, count)
        chunkOffset += count
        if (chunkOffset >= current.size) {
          idx += 1
          chunkOffset = 0
        }
        return count
      }

      override fun getUri(): Uri? = openedUri

      override fun close() {
        closedCount += 1
      }
    }

    var nowMs = 10_000L
    val upstream = FakeLiveDataSource(
      listOf(
        "ABCDEFGH".encodeToByteArray(),
        "IJKLMNOP".encodeToByteArray(),
        "QRSTUVWX".encodeToByteArray(),
      ),
    )
    TimeShiftRingBuffer(tempCacheDir, 16L).use { ring ->
      val tracker = TimeShiftWindowTracker(ring, clockMs = { nowMs })
      val ds = TimeShiftDataSource(upstream, ring, tracker)
      val uri = Uri.parse("http://sim.invalid/live/1001.ts")

      // Initial open tees upstream into ring buffer
      assertEquals(C.LENGTH_UNSET.toLong(), ds.open(DataSpec(uri)))
      assertEquals(1, upstream.openCount)
      val buf1 = ByteArray(8)
      assertEquals(8, ds.read(buf1, 0, 8))
      assertArrayEquals("ABCDEFGH".encodeToByteArray(), buf1)
      assertEquals(0L, tracker.bufferedWindowMs)

      nowMs += 2_500L
      val buf2 = ByteArray(8)
      assertEquals(8, ds.read(buf2, 0, 8))
      assertArrayEquals("IJKLMNOP".encodeToByteArray(), buf2)

      val winBeforeWrap = tracker.currentWindow()
      assertNotNull(winBeforeWrap)
      assertEquals(0L, winBeforeWrap?.liveSeekableStartMs)
      assertEquals(2_500L, winBeforeWrap?.liveEdgeMs)
      assertEquals(2_500L, winBeforeWrap?.bufferedWindowMs)
      ds.close()
      assertEquals(1, upstream.closedCount)
      assertFalse("closing TimeShiftDataSource must not close session ring", ring.snapshot().closed)

      // Re-opening at logical offset 4 (inside [0, 16)) serves straight from ring without opening upstream!
      assertEquals(C.LENGTH_UNSET.toLong(), ds.open(DataSpec.Builder().setUri(uri).setPosition(4L).build()))
      assertEquals(1, upstream.openCount)
      val replay = ByteArray(12)
      assertEquals(12, ds.read(replay, 0, 12))
      assertArrayEquals("EFGHIJKLMNOP".encodeToByteArray(), replay)

      // Continuing to read past ring head seamlessly opens upstream and tees wrapped bytes
      nowMs += 2_500L
      val tail = ByteArray(8)
      assertEquals(8, ds.read(tail, 0, 8))
      assertArrayEquals("QRSTUVWX".encodeToByteArray(), tail)
      assertEquals(2, upstream.openCount)

      // Total written = 24, capacity = 16 -> retained fraction = 16/24 of 5_000 ms
      val winAfterWrap = tracker.currentWindow()
      assertNotNull(winAfterWrap)
      assertEquals(5_000L, winAfterWrap?.liveEdgeMs)
      assertTrue((winAfterWrap?.liveSeekableStartMs ?: 0L) > 0L)
      assertTrue((winAfterWrap?.bufferedWindowMs ?: 0L) >= 2_000L)
      ds.close()
    }
  }
}

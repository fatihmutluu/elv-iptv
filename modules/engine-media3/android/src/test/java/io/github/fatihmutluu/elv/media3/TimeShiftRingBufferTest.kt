package io.github.fatihmutluu.elv.media3

import androidx.media3.common.C
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

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
  }
}

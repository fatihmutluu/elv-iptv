package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VodBufferPolicyTest {
  private val mib = 1024L * 1024L
  private val gib = 1024L * mib

  @Test
  fun `disables VOD buffer budget and disk cache completely for live streams`() {
    for (kind in listOf(StreamKind.RAW_TS_LIVE, StreamKind.HLS_LIVE)) {
      for (preset in BufferPreset.entries) {
        val budget = computeVodBufferBudget(
          streamKind = kind,
          preset = preset,
          isLowRamDevice = false,
          totalMemBytes = 8 * gib,
          freeDiskBytes = 20 * gib,
          multiViewTileCount = 1,
          throttleBackoffLevel = 0,
        )
        assertFalse("kind=$kind must not enable VOD budget", budget.enabled)
        assertFalse("kind=$kind must never allow VOD disk cache", budget.allowDiskCache)
        assertEquals(0L, budget.maxDiskBytes)
        assertEquals(0, budget.forwardTargetMs)
        assertEquals(0, budget.minBufferMs)
        assertEquals(0, budget.backTargetMs)
        assertEquals(0L, budget.maxMemoryBytes)
        assertEquals(0, budget.throttleBackoffLevel)
        assertFalse(budget.prioritizeTimeOverSize)
      }
    }
  }

  @Test
  fun `caps low-RAM devices at 16 MiB RAM, conservative durations, and 32 MiB disk across all presets`() {
    val cases = listOf(
      true to 8 * gib,
      false to 1 * gib,
      false to (1536L * mib - 1L),
    )
    for ((lowFlag, memBytes) in cases) {
      for (preset in BufferPreset.entries) {
        val budget = computeVodBufferBudget(
          streamKind = StreamKind.VOD,
          preset = preset,
          isLowRamDevice = lowFlag,
          totalMemBytes = memBytes,
          freeDiskBytes = 10 * gib,
          multiViewTileCount = 1,
          throttleBackoffLevel = 0,
        )
        assertTrue(budget.enabled)
        assertTrue("low-RAM maxMemoryBytes=${budget.maxMemoryBytes} must be <= 16 MiB", budget.maxMemoryBytes <= 16 * mib)
        assertFalse("low-RAM must never prioritize time over size", budget.prioritizeTimeOverSize)
        assertTrue("low-RAM forwardTargetMs=${budget.forwardTargetMs} must be <= 30_000", budget.forwardTargetMs <= 30_000)
        assertTrue("low-RAM backTargetMs=${budget.backTargetMs} must be <= 8_000", budget.backTargetMs <= 8_000)
        assertTrue(budget.allowDiskCache)
        assertTrue("low-RAM maxDiskBytes=${budget.maxDiskBytes} must be <= 32 MiB", budget.maxDiskBytes <= 32 * mib)
        assertEquals(32 * mib, budget.maxDiskBytes)
      }
    }
  }

  @Test
  fun `scales non-low-RAM presets and caps disk by min of preset cap, 10 percent free disk, and 512 MiB`() {
    val auto4 = computeVodBufferBudget(
      streamKind = StreamKind.VOD,
      preset = BufferPreset.AUTO,
      isLowRamDevice = false,
      totalMemBytes = 4 * gib,
      freeDiskBytes = 20 * gib,
    )
    val balanced4 = computeVodBufferBudget(
      streamKind = StreamKind.VOD,
      preset = BufferPreset.BALANCED,
      isLowRamDevice = false,
      totalMemBytes = 4 * gib,
      freeDiskBytes = 20 * gib,
    )
    val large4 = computeVodBufferBudget(
      streamKind = StreamKind.VOD,
      preset = BufferPreset.LARGE,
      isLowRamDevice = false,
      totalMemBytes = 4 * gib,
      freeDiskBytes = 20 * gib,
    )
    assertTrue(auto4.enabled && balanced4.enabled && large4.enabled)
    assertTrue(auto4.allowDiskCache && balanced4.allowDiskCache && large4.allowDiskCache)
    assertTrue(auto4.forwardTargetMs < balanced4.forwardTargetMs)
    assertTrue(balanced4.forwardTargetMs < large4.forwardTargetMs)
    assertTrue(auto4.backTargetMs < balanced4.backTargetMs)
    assertTrue(balanced4.backTargetMs < large4.backTargetMs)
    assertTrue(auto4.maxDiskBytes in (64 * mib)..(192 * mib))
    assertTrue(balanced4.maxDiskBytes in (96 * mib)..(256 * mib))
    assertTrue(large4.maxDiskBytes in (128 * mib)..(512 * mib))
    assertTrue(auto4.maxDiskBytes < balanced4.maxDiskBytes)
    assertTrue(balanced4.maxDiskBytes < large4.maxDiskBytes)

    // 10% free-disk cap constrains LARGE on tight storage (600 MiB free -> 60 MiB max disk)
    val tightDisk = computeVodBufferBudget(
      streamKind = StreamKind.VOD,
      preset = BufferPreset.LARGE,
      isLowRamDevice = false,
      totalMemBytes = 8 * gib,
      freeDiskBytes = 600 * mib,
    )
    assertTrue(tightDisk.allowDiskCache)
    assertEquals((600 * mib * 0.10).toLong(), tightDisk.maxDiskBytes)

    // 512 MiB hard ceiling holds even on huge free storage + 16 GiB RAM
    val hugeDisk = computeVodBufferBudget(
      streamKind = StreamKind.VOD,
      preset = BufferPreset.LARGE,
      isLowRamDevice = false,
      totalMemBytes = 16 * gib,
      freeDiskBytes = 100 * gib,
    )
    assertTrue(hugeDisk.allowDiskCache)
    assertEquals(512 * mib, hugeDisk.maxDiskBytes)
  }

  @Test
  fun `disables disk cache when free disk is null or under 512 MiB, in multi-view, or at throttle level 2+`() {
    val nullDisk = computeVodBufferBudget(StreamKind.VOD, BufferPreset.LARGE, false, 4 * gib, freeDiskBytes = null)
    assertFalse(nullDisk.allowDiskCache)
    assertEquals(0L, nullDisk.maxDiskBytes)

    val lowDisk = computeVodBufferBudget(StreamKind.VOD, BufferPreset.LARGE, false, 4 * gib, freeDiskBytes = 512 * mib - 1L)
    assertFalse(lowDisk.allowDiskCache)
    assertEquals(0L, lowDisk.maxDiskBytes)

    val multiView = computeVodBufferBudget(
      streamKind = StreamKind.VOD,
      preset = BufferPreset.LARGE,
      isLowRamDevice = false,
      totalMemBytes = 8 * gib,
      freeDiskBytes = 20 * gib,
      multiViewTileCount = 2,
    )
    assertFalse(multiView.allowDiskCache)
    assertEquals(0L, multiView.maxDiskBytes)
    assertFalse(multiView.prioritizeTimeOverSize)

    val throttled2 = computeVodBufferBudget(
      streamKind = StreamKind.VOD,
      preset = BufferPreset.LARGE,
      isLowRamDevice = false,
      totalMemBytes = 8 * gib,
      freeDiskBytes = 20 * gib,
      throttleBackoffLevel = 2,
    )
    assertFalse(throttled2.allowDiskCache)
    assertEquals(0L, throttled2.maxDiskBytes)
  }

  @Test
  fun `nextThrottleBackoffLevel increments on 429 and 509 clamped to 0 to 3 and halves forward target and disk cap`() {
    assertEquals(1, nextThrottleBackoffLevel(0, 429))
    assertEquals(2, nextThrottleBackoffLevel(1, 509))
    assertEquals(3, nextThrottleBackoffLevel(2, 429))
    assertEquals(3, nextThrottleBackoffLevel(3, 509))
    assertEquals(1, nextThrottleBackoffLevel(1, 404))
    assertEquals(0, nextThrottleBackoffLevel(-5, 200))
    assertEquals(3, nextThrottleBackoffLevel(99, 500))

    val lvl0 = computeVodBufferBudget(StreamKind.VOD, BufferPreset.LARGE, false, 8 * gib, 20 * gib, throttleBackoffLevel = 0)
    val lvl1 = computeVodBufferBudget(StreamKind.VOD, BufferPreset.LARGE, false, 8 * gib, 20 * gib, throttleBackoffLevel = 1)
    val lvl2 = computeVodBufferBudget(StreamKind.VOD, BufferPreset.LARGE, false, 8 * gib, 20 * gib, throttleBackoffLevel = 2)
    val lvl3 = computeVodBufferBudget(StreamKind.VOD, BufferPreset.LARGE, false, 8 * gib, 20 * gib, throttleBackoffLevel = 3)

    assertEquals(lvl0.forwardTargetMs / 2, lvl1.forwardTargetMs)
    assertEquals(lvl0.forwardTargetMs / 4, lvl2.forwardTargetMs)
    assertEquals(lvl0.forwardTargetMs / 8, lvl3.forwardTargetMs)
    assertEquals(lvl0.maxDiskBytes / 2, lvl1.maxDiskBytes)
    assertTrue(lvl1.allowDiskCache)
    assertFalse(lvl2.allowDiskCache)
    assertEquals(0L, lvl2.maxDiskBytes)

    // Forward target never drops below 15_000 ms floor even at level 3 on low-RAM
    val lowLvl3 = computeVodBufferBudget(StreamKind.VOD, BufferPreset.AUTO, true, 1 * gib, 10 * gib, throttleBackoffLevel = 3)
    assertEquals(15_000, lowLvl3.forwardTargetMs)
  }

  @Test
  fun `hashVodCacheKey produces deterministic lowercase SHA-256 hex without leaking raw URLs or tokens`() {
    assertEquals(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      hashVodCacheKey(""),
    )
    val basePath = listOf("https://provider.example.test", "movie", "demoUser", "demoSecret", "12345.mp4").joinToString("/")
    val urlA = "$basePath?token=abc987"
    val urlB = "$basePath?token=xyz123"
    val hashA = hashVodCacheKey(urlA)
    val hashB = hashVodCacheKey(urlB)

    assertEquals(64, hashA.length)
    assertTrue(hashA.matches(Regex("^[0-9a-f]{64}$")))
    assertEquals(hashA, hashVodCacheKey(urlA))
    assertNotEquals(hashA, hashB)
    assertFalse(hashA.contains("provider"))
    assertFalse(hashA.contains("secret"))
    assertFalse(hashA.contains("token"))
    assertFalse(hashA.contains(".mp4"))
  }

  @Test
  fun `applyVodBudgetToLoadControl preserves ExoPlayer invariants and low-RAM 16 MiB ceiling across all combinations`() {
    val liveBase = loadControlForStream(false, 4 * gib, StreamKind.HLS_LIVE, BufferPreset.AUTO)
    val disabledBudget = computeVodBufferBudget(StreamKind.HLS_LIVE, BufferPreset.AUTO, false, 4 * gib, 10 * gib)
    assertEquals(liveBase, applyVodBudgetToLoadControl(liveBase, disabledBudget))

    // Low-RAM base must NEVER exceed 16 MiB or prioritize time even if paired with an aggressive budget
    val lowRamBase = loadControlForStream(true, 1 * gib, StreamKind.VOD, BufferPreset.LARGE)
    val aggressiveBudget = computeVodBufferBudget(StreamKind.VOD, BufferPreset.LARGE, false, 8 * gib, 20 * gib)
    val guardedLowRam = applyVodBudgetToLoadControl(lowRamBase, aggressiveBudget)
    assertTrue(guardedLowRam.targetBufferBytes <= (16 * mib).toInt())
    assertFalse(guardedLowRam.prioritizeTimeOverSizeThresholds)

    // Exhaustive matrix of device RAM, preset, free disk, multi-view tiles, and backoff levels
    val mems = listOf(512 * mib, 1 * gib, 1536 * mib, 2 * gib, 4 * gib, 8 * gib)
    val disks = listOf<Long?>(null, 256 * mib, 512 * mib, 600 * mib, 20 * gib)
    for (mem in mems) {
      for (lowFlag in listOf(false, true)) {
        for (preset in BufferPreset.entries) {
          for (disk in disks) {
            for (tiles in listOf(1, 2, 4)) {
              for (backoff in 0..3) {
                val base = loadControlForStream(lowFlag, mem, StreamKind.VOD, preset, multiViewTileCount = tiles)
                val budget = computeVodBufferBudget(
                  streamKind = StreamKind.VOD,
                  preset = preset,
                  isLowRamDevice = lowFlag,
                  totalMemBytes = mem,
                  freeDiskBytes = disk,
                  multiViewTileCount = tiles,
                  throttleBackoffLevel = backoff,
                )
                val applied = applyVodBudgetToLoadControl(base, budget)
                val floorMin = maxOf(applied.bufferForPlaybackMs, applied.bufferForPlaybackAfterRebufferMs)
                assertTrue(applied.minBufferMs >= floorMin)
                assertTrue(applied.maxBufferMs >= applied.minBufferMs)
                assertTrue(applied.backBufferMs >= 0)
                assertEquals(applied.backBufferMs > 0, applied.retainBackBufferFromKeyframe)
                if (isLowRam(lowFlag, mem)) {
                  assertTrue(applied.targetBufferBytes <= (16 * mib).toInt())
                  assertFalse(applied.prioritizeTimeOverSizeThresholds)
                }
              }
            }
          }
        }
      }
    }
  }
}

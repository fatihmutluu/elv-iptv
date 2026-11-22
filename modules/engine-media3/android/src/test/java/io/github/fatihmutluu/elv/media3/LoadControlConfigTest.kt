package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadControlConfigTest {
  private val mib = 1024 * 1024
  private val gib = 1024L * mib

  @Test
  fun `regular devices prioritize time over size with 32 MiB target and 12 s back-buffer (#127, #307)`() {
    assertEquals(
      LoadControlValues(
        minBufferMs = 15_000,
        maxBufferMs = 30_000,
        bufferForPlaybackMs = 1_000,
        bufferForPlaybackAfterRebufferMs = 2_000,
        targetBufferBytes = 32 * mib,
        backBufferMs = 12_000,
        retainBackBufferFromKeyframe = true,
        prioritizeTimeOverSizeThresholds = true,
      ),
      loadControlFor(lowRam = false),
    )
  }

  @Test
  fun `low-RAM VOD enforces 16 MiB hard byte cap with 5 s back-buffer (#127, #307, #422)`() {
    assertEquals(
      LoadControlValues(
        minBufferMs = 15_000,
        maxBufferMs = 30_000,
        bufferForPlaybackMs = 1_000,
        bufferForPlaybackAfterRebufferMs = 2_000,
        targetBufferBytes = 16 * mib,
        backBufferMs = 5_000,
        retainBackBufferFromKeyframe = true,
        prioritizeTimeOverSizeThresholds = false,
      ),
      loadControlFor(lowRam = true, live = false),
    )
  }

  @Test
  fun `live streams drop back-buffer RAM and low-RAM live tightens buffer window (#422)`() {
    assertEquals(
      LoadControlValues(
        minBufferMs = 15_000,
        maxBufferMs = 30_000,
        bufferForPlaybackMs = 1_000,
        bufferForPlaybackAfterRebufferMs = 2_000,
        targetBufferBytes = 32 * mib,
        backBufferMs = 0,
        retainBackBufferFromKeyframe = false,
        prioritizeTimeOverSizeThresholds = true,
      ),
      loadControlFor(lowRam = false, live = true),
    )
    assertEquals(
      LoadControlValues(
        minBufferMs = 10_000,
        maxBufferMs = 20_000,
        bufferForPlaybackMs = 1_000,
        bufferForPlaybackAfterRebufferMs = 2_000,
        targetBufferBytes = 16 * mib,
        backBufferMs = 0,
        retainBackBufferFromKeyframe = false,
        prioritizeTimeOverSizeThresholds = false,
      ),
      loadControlFor(lowRam = true, live = true),
    )
  }

  @Test
  fun `memory-tiered config scales targetBufferBytes across 16, 32 and 48 MiB and splits live vs VOD (#262, #422)`() {
    val lowMemVod = loadControlForMemory(isLowRamDevice = false, totalMemBytes = 1 * gib, live = false)
    assertEquals(16 * mib, lowMemVod.targetBufferBytes)
    assertFalse(lowMemVod.prioritizeTimeOverSizeThresholds)
    assertEquals(5_000, lowMemVod.backBufferMs)
    assertTrue(lowMemVod.retainBackBufferFromKeyframe)

    val flaggedLowRamLive = loadControlForMemory(isLowRamDevice = true, totalMemBytes = 6 * gib, live = true)
    assertEquals(16 * mib, flaggedLowRamLive.targetBufferBytes)
    assertFalse(flaggedLowRamLive.prioritizeTimeOverSizeThresholds)
    assertEquals(10_000, flaggedLowRamLive.minBufferMs)
    assertEquals(20_000, flaggedLowRamLive.maxBufferMs)
    assertEquals(0, flaggedLowRamLive.backBufferMs)
    assertFalse(flaggedLowRamLive.retainBackBufferFromKeyframe)

    val standardVod = loadControlForMemory(isLowRamDevice = false, totalMemBytes = 2 * gib, live = false)
    assertEquals(32 * mib, standardVod.targetBufferBytes)
    assertTrue(standardVod.prioritizeTimeOverSizeThresholds)
    assertEquals(12_000, standardVod.backBufferMs)

    val highRamLive = loadControlForMemory(isLowRamDevice = false, totalMemBytes = 4 * gib, live = true)
    assertEquals(48 * mib, highRamLive.targetBufferBytes)
    assertTrue(highRamLive.prioritizeTimeOverSizeThresholds)
    assertEquals(15_000, highRamLive.minBufferMs)
    assertEquals(30_000, highRamLive.maxBufferMs)
    assertEquals(0, highRamLive.backBufferMs)
    assertFalse(highRamLive.retainBackBufferFromKeyframe)
  }

  @Test
  fun `a device is low-RAM when Android says so or it has under 1,5 GB`() {
    assertTrue(isLowRam(isLowRamDevice = true, totalMemBytes = 4 * gib))
    assertTrue(isLowRam(isLowRamDevice = false, totalMemBytes = 3 * gib / 2 - 1))
    assertFalse(isLowRam(isLowRamDevice = false, totalMemBytes = 3 * gib / 2))
    assertFalse(isLowRam(isLowRamDevice = false, totalMemBytes = 2 * gib))
  }
}

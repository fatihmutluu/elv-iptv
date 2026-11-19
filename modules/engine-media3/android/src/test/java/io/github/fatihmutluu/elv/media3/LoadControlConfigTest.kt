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
  fun `low-RAM devices use 16 MiB target and 5 s back-buffer while prioritizing time (#127, #307)`() {
    assertEquals(
      LoadControlValues(
        minBufferMs = 15_000,
        maxBufferMs = 30_000,
        bufferForPlaybackMs = 1_000,
        bufferForPlaybackAfterRebufferMs = 2_000,
        targetBufferBytes = 16 * mib,
        backBufferMs = 5_000,
        retainBackBufferFromKeyframe = true,
        prioritizeTimeOverSizeThresholds = true,
      ),
      loadControlFor(lowRam = true),
    )
  }

  @Test
  fun `memory-tiered config scales targetBufferBytes across 16, 32 and 48 MiB (#262)`() {
    assertEquals(16 * mib, loadControlForMemory(isLowRamDevice = false, totalMemBytes = 1 * gib).targetBufferBytes)
    assertEquals(16 * mib, loadControlForMemory(isLowRamDevice = true, totalMemBytes = 6 * gib).targetBufferBytes)
    assertEquals(32 * mib, loadControlForMemory(isLowRamDevice = false, totalMemBytes = 2 * gib).targetBufferBytes)
    assertEquals(48 * mib, loadControlForMemory(isLowRamDevice = false, totalMemBytes = 4 * gib).targetBufferBytes)
  }

  @Test
  fun `a device is low-RAM when Android says so or it has under 1,5 GB`() {
    assertTrue(isLowRam(isLowRamDevice = true, totalMemBytes = 4 * gib))
    assertTrue(isLowRam(isLowRamDevice = false, totalMemBytes = 3 * gib / 2 - 1))
    assertFalse(isLowRam(isLowRamDevice = false, totalMemBytes = 3 * gib / 2))
    assertFalse(isLowRam(isLowRamDevice = false, totalMemBytes = 2 * gib))
  }
}

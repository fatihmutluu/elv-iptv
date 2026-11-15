package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadControlConfigTest {
  private val gib = 1024L * 1024 * 1024

  @Test
  fun `regular devices buffer 15 to 30 s with a 32 MB target`() {
    assertEquals(
      LoadControlValues(
        minBufferMs = 15_000,
        maxBufferMs = 30_000,
        bufferForPlaybackMs = 1_000,
        bufferForPlaybackAfterRebufferMs = 2_000,
        targetBufferBytes = 32 * 1024 * 1024,
      ),
      loadControlFor(lowRam = false),
    )
  }

  @Test
  fun `low-RAM devices keep the durations with a 16 MB target`() {
    assertEquals(
      LoadControlValues(
        minBufferMs = 15_000,
        maxBufferMs = 30_000,
        bufferForPlaybackMs = 1_000,
        bufferForPlaybackAfterRebufferMs = 2_000,
        targetBufferBytes = 16 * 1024 * 1024,
      ),
      loadControlFor(lowRam = true),
    )
  }

  @Test
  fun `a device is low-RAM when Android says so or it has under 1,5 GB`() {
    assertTrue(isLowRam(isLowRamDevice = true, totalMemBytes = 4 * gib))
    assertTrue(isLowRam(isLowRamDevice = false, totalMemBytes = 3 * gib / 2 - 1))
    assertFalse(isLowRam(isLowRamDevice = false, totalMemBytes = 3 * gib / 2))
    assertFalse(isLowRam(isLowRamDevice = false, totalMemBytes = 2 * gib))
  }
}

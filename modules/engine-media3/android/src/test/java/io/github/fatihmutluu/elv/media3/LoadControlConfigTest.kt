package io.github.fatihmutluu.elv.media3

import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadControlConfigTest {
  private val mib = 1024 * 1024
  private val gib = 1024L * mib

  @Test
  fun `parseBufferPreset resolves known wire values case-insensitively and defaults to AUTO (#147)`() {
    val previousLocale = Locale.getDefault()
    try {
      Locale.setDefault(Locale.forLanguageTag("tr-TR"))
      assertEquals(BufferPreset.AUTO, parseBufferPreset(null))
      assertEquals(BufferPreset.AUTO, parseBufferPreset(""))
      assertEquals(BufferPreset.AUTO, parseBufferPreset("unknown"))
      assertEquals(BufferPreset.AUTO, parseBufferPreset("AUTO"))
      assertEquals(BufferPreset.BALANCED, parseBufferPreset("balanced"))
      assertEquals(BufferPreset.BALANCED, parseBufferPreset(" BALANCED "))
      assertEquals(BufferPreset.LARGE, parseBufferPreset("large"))
      assertEquals(BufferPreset.LARGE, parseBufferPreset("LARGE"))
    } finally {
      Locale.setDefault(previousLocale)
    }
  }

  @Test
  fun `RAW_TS_LIVE uses lean 750 ms startup, zero back-buffer and raised rebuffer hysteresis (#147, #150)`() {
    val lowRamTs = loadControlForStream(
      isLowRamDevice = true,
      totalMemBytes = 1 * gib,
      streamKind = StreamKind.RAW_TS_LIVE,
      preset = BufferPreset.AUTO,
    )
    assertEquals(750, lowRamTs.bufferForPlaybackMs)
    assertEquals(3_500, lowRamTs.bufferForPlaybackAfterRebufferMs)
    assertEquals(10_000, lowRamTs.minBufferMs)
    assertEquals(20_000, lowRamTs.maxBufferMs)
    assertEquals(16 * mib, lowRamTs.targetBufferBytes)
    assertEquals(0, lowRamTs.backBufferMs)
    assertFalse(lowRamTs.retainBackBufferFromKeyframe)
    assertFalse(lowRamTs.prioritizeTimeOverSizeThresholds)

    val stdTs = loadControlForStream(
      isLowRamDevice = false,
      totalMemBytes = 2 * gib,
      streamKind = StreamKind.RAW_TS_LIVE,
      preset = BufferPreset.AUTO,
    )
    assertEquals(750, stdTs.bufferForPlaybackMs)
    assertEquals(2_500, stdTs.bufferForPlaybackAfterRebufferMs)
    assertEquals(12_000, stdTs.minBufferMs)
    assertEquals(25_000, stdTs.maxBufferMs)
    assertEquals(0, stdTs.backBufferMs)
    assertFalse(stdTs.retainBackBufferFromKeyframe)
    assertTrue(stdTs.prioritizeTimeOverSizeThresholds)
  }

  @Test
  fun `low-RAM devices strictly cap targetBufferBytes at 16 MiB and disable time-priority across ALL presets (#147, #262, #422)`() {
    for (preset in BufferPreset.entries) {
      for (kind in StreamKind.entries) {
        val byFlag = loadControlForStream(
          isLowRamDevice = true,
          totalMemBytes = 8 * gib,
          streamKind = kind,
          preset = preset,
        )
        assertEquals("preset=$preset kind=$kind", 16 * mib, byFlag.targetBufferBytes)
        assertFalse("preset=$preset kind=$kind", byFlag.prioritizeTimeOverSizeThresholds)
        assertEquals(3_500, byFlag.bufferForPlaybackAfterRebufferMs)
        if (kind != StreamKind.VOD) {
          assertEquals(0, byFlag.backBufferMs)
          assertFalse(byFlag.retainBackBufferFromKeyframe)
        } else {
          assertEquals(5_000, byFlag.backBufferMs)
          assertTrue(byFlag.retainBackBufferFromKeyframe)
        }

        val byMem = loadControlForStream(
          isLowRamDevice = false,
          totalMemBytes = 1 * gib,
          streamKind = kind,
          preset = preset,
        )
        assertEquals(16 * mib, byMem.targetBufferBytes)
        assertFalse(byMem.prioritizeTimeOverSizeThresholds)
      }
    }
  }

  @Test
  fun `non-low-RAM scales targetBufferBytes proportionally by totalMemBytes div 18 and enforces preset floors and caps (#147, #262)`() {
    val mem1536 = 1536L * mib // 1.5 GiB -> /18 = 85.33 MiB
    val expected1536 = (mem1536 / 18L).toInt()
    val auto15 = loadControlForStream(false, mem1536, StreamKind.VOD, BufferPreset.AUTO)
    assertEquals(expected1536, auto15.targetBufferBytes)
    assertTrue(auto15.targetBufferBytes in (16 * mib)..(96 * mib))
    assertTrue(auto15.prioritizeTimeOverSizeThresholds)

    // At 2 GiB: 2 GiB / 18 = ~113.7 MiB -> AUTO/BALANCED clamp to 96 MiB, LARGE preserves ~113.7 MiB (< 128 MiB cap)
    val auto2 = loadControlForStream(false, 2 * gib, StreamKind.VOD, BufferPreset.AUTO)
    val balanced2 = loadControlForStream(false, 2 * gib, StreamKind.VOD, BufferPreset.BALANCED)
    val large2 = loadControlForStream(false, 2 * gib, StreamKind.VOD, BufferPreset.LARGE)
    assertEquals(96 * mib, auto2.targetBufferBytes)
    assertTrue(balanced2.targetBufferBytes >= 32 * mib)
    assertEquals(96 * mib, balanced2.targetBufferBytes)
    assertTrue(large2.targetBufferBytes >= 64 * mib)
    assertEquals(((2 * gib) / 18L).toInt(), large2.targetBufferBytes)
    assertTrue(auto2.maxBufferMs < balanced2.maxBufferMs)
    assertTrue(balanced2.maxBufferMs < large2.maxBufferMs)

    // At 8 GiB: LARGE clamps cleanly to 128 MiB
    val large8 = loadControlForStream(false, 8 * gib, StreamKind.VOD, BufferPreset.LARGE)
    assertEquals(128 * mib, large8.targetBufferBytes)
    assertEquals(45_000, large8.minBufferMs)
    assertEquals(90_000, large8.maxBufferMs)
    assertEquals(20_000, large8.backBufferMs)
    assertTrue(large8.retainBackBufferFromKeyframe)
  }

  @Test
  fun `backward-compatible loadControlFor and loadControlForMemory preserve live vs VOD invariants (#150, #262, #422)`() {
    val regularVod = loadControlFor(lowRam = false, live = false)
    assertEquals(15_000, regularVod.minBufferMs)
    assertEquals(30_000, regularVod.maxBufferMs)
    assertEquals(1_000, regularVod.bufferForPlaybackMs)
    assertEquals(2_500, regularVod.bufferForPlaybackAfterRebufferMs)
    assertEquals(96 * mib, regularVod.targetBufferBytes)
    assertEquals(12_000, regularVod.backBufferMs)
    assertTrue(regularVod.retainBackBufferFromKeyframe)
    assertTrue(regularVod.prioritizeTimeOverSizeThresholds)

    val lowRamLive = loadControlFor(lowRam = true, live = true)
    assertEquals(10_000, lowRamLive.minBufferMs)
    assertEquals(20_000, lowRamLive.maxBufferMs)
    assertEquals(3_500, lowRamLive.bufferForPlaybackAfterRebufferMs)
    assertEquals(16 * mib, lowRamLive.targetBufferBytes)
    assertEquals(0, lowRamLive.backBufferMs)
    assertFalse(lowRamLive.retainBackBufferFromKeyframe)
    assertFalse(lowRamLive.prioritizeTimeOverSizeThresholds)

    val highRamLive = loadControlForMemory(isLowRamDevice = false, totalMemBytes = 4 * gib, live = true)
    assertEquals(96 * mib, highRamLive.targetBufferBytes)
    assertEquals(0, highRamLive.backBufferMs)
    assertFalse(highRamLive.retainBackBufferFromKeyframe)
    assertTrue(highRamLive.prioritizeTimeOverSizeThresholds)
  }

  @Test
  fun `every LoadControlValues satisfies ExoPlayer DefaultLoadControl buffer duration invariants`() {
    val mems = listOf(512L * mib, 1 * gib, 1536L * mib, 2 * gib, 4 * gib, 8 * gib)
    for (mem in mems) {
      for (lowFlag in listOf(false, true)) {
        for (kind in StreamKind.entries) {
          for (preset in BufferPreset.entries) {
            val v = loadControlForStream(lowFlag, mem, kind, preset)
            assertTrue(v.bufferForPlaybackMs >= 0)
            assertTrue(v.bufferForPlaybackAfterRebufferMs >= 0)
            assertTrue(v.minBufferMs >= v.bufferForPlaybackMs)
            assertTrue(v.minBufferMs >= v.bufferForPlaybackAfterRebufferMs)
            assertTrue(v.maxBufferMs >= v.minBufferMs)
            assertTrue(v.targetBufferBytes >= 16 * mib)
            assertTrue(v.backBufferMs >= 0)
          }
        }
      }
    }
  }

  @Test
  fun `a device is low-RAM when Android says so or it has under 1,5 GB`() {
    assertTrue(isLowRam(isLowRamDevice = true, totalMemBytes = 4 * gib))
    assertTrue(isLowRam(isLowRamDevice = false, totalMemBytes = 3 * gib / 2 - 1))
    assertFalse(isLowRam(isLowRamDevice = false, totalMemBytes = 3 * gib / 2))
    assertFalse(isLowRam(isLowRamDevice = false, totalMemBytes = 2 * gib))
  }
}

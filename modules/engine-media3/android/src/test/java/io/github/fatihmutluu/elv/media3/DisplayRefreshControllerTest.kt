package io.github.fatihmutluu.elv.media3

import android.app.Activity
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class DisplayRefreshControllerTest {
  private val tv4kModes = listOf(
    DisplayModeInfo(modeId = 1, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 60f),
    DisplayModeInfo(modeId = 2, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 59.94f),
    DisplayModeInfo(modeId = 3, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 50f),
    DisplayModeInfo(modeId = 4, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 24f),
    DisplayModeInfo(modeId = 5, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 23.976f),
    DisplayModeInfo(modeId = 6, physicalWidth = 1920, physicalHeight = 1080, refreshRate = 23.976f),
    DisplayModeInfo(modeId = 7, physicalWidth = 1920, physicalHeight = 1080, refreshRate = 25f),
  )

  @Test
  fun `selectBestDisplayMode returns null when OFF or invalid contentFps (#116)`() {
    assertNull(selectBestDisplayMode(tv4kModes, currentModeId = 1, contentFps = 23.976f, mode = AutoFrameRateMode.OFF))
    assertNull(selectBestDisplayMode(tv4kModes, currentModeId = 1, contentFps = 0f, mode = AutoFrameRateMode.ALWAYS))
    assertNull(selectBestDisplayMode(tv4kModes, currentModeId = 1, contentFps = Float.NaN, mode = AutoFrameRateMode.ALWAYS))
    assertNull(selectBestDisplayMode(tv4kModes, currentModeId = 999, contentFps = 23.976f, mode = AutoFrameRateMode.ALWAYS))
  }

  @Test
  fun `selectBestDisplayMode preserves current pixel resolution and prefers exact match over multiples (#116)`() {
    // 23.976 fps on 4K@60Hz -> picks 4K@23.976Hz (modeId 5), NOT 1080p@23.976Hz (modeId 6) and NOT 4K@24Hz (modeId 4)
    assertEquals(
      5,
      selectBestDisplayMode(tv4kModes, currentModeId = 1, contentFps = 23.976f, mode = AutoFrameRateMode.ALWAYS),
    )
    // 24 fps -> picks 4K@24Hz (modeId 4)
    assertEquals(
      4,
      selectBestDisplayMode(tv4kModes, currentModeId = 1, contentFps = 24f, mode = AutoFrameRateMode.ALWAYS),
    )
    // 25 fps on 4K@60Hz -> 4K has no 25Hz (only 1080p has 25Hz), so picks 4K@50Hz (2x multiple, modeId 3)!
    assertEquals(
      3,
      selectBestDisplayMode(tv4kModes, currentModeId = 1, contentFps = 25f, mode = AutoFrameRateMode.ALWAYS),
    )
    // 59.94 fps on 4K@60Hz -> 60Hz is already within ±0.15 of 59.94, but 59.94Hz is exact (0.0 error vs 0.06)
    assertEquals(
      2,
      selectBestDisplayMode(tv4kModes, currentModeId = 1, contentFps = 59.94f, mode = AutoFrameRateMode.ALWAYS),
    )
  }

  @Test
  fun `selectBestDisplayMode matches 2x, 3x, 4x, and 5x integer multiples and returns null when current matches (#116)`() {
    val highHzModes = listOf(
      DisplayModeInfo(modeId = 1, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 60f),
      DisplayModeInfo(modeId = 2, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 100f),
      DisplayModeInfo(modeId = 3, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 119.88f),
      DisplayModeInfo(modeId = 4, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 72f),
    )
    // 23.976 * 5 = 119.88 -> picks modeId 3
    assertEquals(
      3,
      selectBestDisplayMode(highHzModes, currentModeId = 1, contentFps = 23.976f, mode = AutoFrameRateMode.SEAMLESS),
    )
    // 25 * 4 = 100 -> picks modeId 2
    assertEquals(
      2,
      selectBestDisplayMode(highHzModes, currentModeId = 1, contentFps = 25f, mode = AutoFrameRateMode.SEAMLESS),
    )
    // 24 * 3 = 72 -> picks modeId 4
    assertEquals(
      4,
      selectBestDisplayMode(highHzModes, currentModeId = 1, contentFps = 24f, mode = AutoFrameRateMode.SEAMLESS),
    )
    // Already at 4K@60Hz for 60fps or 30fps (2x) -> returns null (no redundant switch!)
    assertNull(
      selectBestDisplayMode(highHzModes, currentModeId = 1, contentFps = 60f, mode = AutoFrameRateMode.ALWAYS),
    )
    assertNull(
      selectBestDisplayMode(highHzModes, currentModeId = 1, contentFps = 30f, mode = AutoFrameRateMode.ALWAYS),
    )
    // Already at 4K@23.976Hz for 23.976fps -> returns null
    assertNull(
      selectBestDisplayMode(tv4kModes, currentModeId = 5, contentFps = 23.976f, mode = AutoFrameRateMode.ALWAYS),
    )
  }

  @Test
  fun `DisplayRefreshController applies preferredDisplayModeId in ALWAYS mode, respects seamless alternatives, and restores default (#116)`() {
    val activity = Robolectric.buildActivity(Activity::class.java).create().get()
    val applied = mutableListOf<Int>()
    var restores = 0
    val reportedRates = mutableListOf<Float?>()
    val modes = listOf(
      DisplayModeInfo(
        modeId = 1,
        physicalWidth = 3840,
        physicalHeight = 2160,
        refreshRate = 60f,
        alternativeRefreshRates = listOf(50f),
      ),
      DisplayModeInfo(modeId = 2, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 50f),
      DisplayModeInfo(modeId = 3, physicalWidth = 3840, physicalHeight = 2160, refreshRate = 23.976f),
    )
    val controller = DisplayRefreshController(
      activityProvider = { activity },
      readModes = { 1 to modes },
      applyMode = { _, modeId ->
        applied += modeId
        true
      },
      restoreMode = {
        restores += 1
        true
      },
      onActiveRefreshRateChanged = { reportedRates += it },
    )

    // SEAMLESS mode: 23.976 is NOT in alternativeRefreshRates -> does NOT force non-seamless window switch
    controller.setMode(AutoFrameRateMode.SEAMLESS)
    controller.onContentFrameRate(23.976f)
    assertTrue(applied.isEmpty())

    // SEAMLESS mode: 50Hz IS in alternativeRefreshRates -> applies seamlessly
    controller.onContentFrameRate(50f)
    assertEquals(listOf(2), applied)
    assertEquals(50f, controller.activeRefreshRateHz!!, 0.01f)

    // ALWAYS mode: 23.976Hz applies window preferredDisplayModeId even if non-seamless
    controller.setMode(AutoFrameRateMode.ALWAYS)
    controller.onContentFrameRate(23.976f)
    assertEquals(listOf(2, 3), applied)
    assertEquals(23.976f, controller.activeRefreshRateHz!!, 0.01f)

    // restoreDefault resets preferredDisplayModeId = 0 once and clears active state
    controller.restoreDefault()
    assertEquals(1, restores)
    assertNull(controller.activeRefreshRateHz)
    controller.restoreDefault()
    assertEquals(1, restores)
  }

  @Test
  fun `resolves per-refresh-rate A/V delay offset with canonical snapping and +-1000ms clamp (#115)`() {
    val offsets = mapOf("23.976" to 45L, "24" to 20L, "50" to -35L, "60" to 1_500L)
    assertEquals(45L, resolveAudioDelayOffsetForRefreshRate(offsets, 23.98f))
    assertEquals(20L, resolveAudioDelayOffsetForRefreshRate(offsets, 24.0f))
    assertEquals(-35L, resolveAudioDelayOffsetForRefreshRate(offsets, 50.0f))
    assertEquals(1_000L, resolveAudioDelayOffsetForRefreshRate(offsets, 60.0f))
    // Fallback to rounded integer bucket when exact fractional bucket is absent
    assertEquals(20L, resolveAudioDelayOffsetForRefreshRate(mapOf("24" to 20L), 23.976f))
    assertEquals(0L, resolveAudioDelayOffsetForRefreshRate(offsets, null))
    assertEquals(0L, resolveAudioDelayOffsetForRefreshRate(emptyMap(), 50f))
  }
}

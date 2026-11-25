package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.Format
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

@OptIn(UnstableApi::class)
class PtsFrameRateEstimatorTest {
  private fun feedConstantInterval(
    estimator: PtsFrameRateEstimator,
    intervalUs: Long,
    frames: Int,
    startPtsUs: Long = 1_000_000L,
    formatFrameRate: Float = Format.NO_VALUE.toFloat(),
  ): List<Float> {
    val emitted = mutableListOf<Float>()
    for (i in 0 until frames) {
      val pts = startPtsUs + i * intervalUs
      estimator.onSample(pts, formatFrameRate)?.let { emitted += it }
    }
    return emitted
  }

  @Test
  fun `snaps standard cinema and broadcast rates within plus or minus 0_15 fps (#199)`() {
    assertEquals(23.976f, snapStandardFrameRate(23.976f)!!, 0.0001f)
    assertEquals(23.976f, snapStandardFrameRate(23.90f)!!, 0.0001f)
    assertEquals(24f, snapStandardFrameRate(24.05f)!!, 0.0001f)
    assertEquals(25f, snapStandardFrameRate(25.08f)!!, 0.0001f)
    assertEquals(29.97f, snapStandardFrameRate(29.92f)!!, 0.0001f)
    assertEquals(30f, snapStandardFrameRate(30.10f)!!, 0.0001f)
    assertEquals(50f, snapStandardFrameRate(49.90f)!!, 0.0001f)
    assertEquals(59.94f, snapStandardFrameRate(59.90f)!!, 0.0001f)
    assertEquals(60f, snapStandardFrameRate(60.12f)!!, 0.0001f)
    assertNull(snapStandardFrameRate(48f))
    assertNull(snapStandardFrameRate(15f))
    assertNull(snapStandardFrameRate(Float.NaN))
    assertNull(snapStandardFrameRate(-1f))
  }

  @Test
  fun `estimates 23_976, 25, 29_97, 50, and 59_94 fps from PTS deltas when format frameRate is NO_VALUE (#199)`() {
    val cases = listOf(
      41_708L to 23.976f,
      40_000L to 25f,
      33_367L to 29.97f,
      20_000L to 50f,
      16_683L to 59.94f,
    )
    for ((intervalUs, expectedFps) in cases) {
      val callbacks = mutableListOf<Float>()
      val estimator = PtsFrameRateEstimator(onStabilized = { callbacks += it })
      // 24 frames produce only 23 deltas -> must not emit early
      assertEquals(emptyList<Float>(), feedConstantInterval(estimator, intervalUs, frames = 24))
      assertEquals(emptyList<Float>(), callbacks)
      // 25th frame produces the 24th delta -> stabilizes and emits exactly once
      val on25 = estimator.onSample(1_000_000L + 24L * intervalUs, Format.NO_VALUE.toFloat())
      assertEquals("intervalUs=$intervalUs", expectedFps, on25!!, 0.001f)
      assertEquals(listOf(expectedFps), callbacks)
      // Subsequent frames are ignored until reset
      val extra = feedConstantInterval(estimator, intervalUs, frames = 40, startPtsUs = 5_000_000L)
      assertEquals(emptyList<Float>(), extra)
      assertEquals(1, callbacks.size)
    }
  }

  @Test
  fun `ignores non-monotonic deltas, zero deltas, and large gaps >= 500_000 us (#199)`() {
    val estimator = PtsFrameRateEstimator()
    // Feed 20 valid 40_000us (25fps) deltas, interspersed with bad deltas
    var pts = 1_000_000L
    estimator.onSample(pts, Format.NO_VALUE.toFloat())
    for (i in 0 until 20) {
      pts += 40_000L
      assertNull(estimator.onSample(pts, Format.NO_VALUE.toFloat()))
    }
    // Duplicate PTS (delta == 0)
    assertNull(estimator.onSample(pts, Format.NO_VALUE.toFloat()))
    // Backward PTS (seek / B-frame anomaly)
    pts -= 80_000L
    assertNull(estimator.onSample(pts, Format.NO_VALUE.toFloat()))
    // Stall gap >= 500_000 us
    pts += 600_000L
    assertNull(estimator.onSample(pts, Format.NO_VALUE.toFloat()))
    // 4 more valid 40_000us deltas bring valid count from 20 -> 24 and emit 25f
    var stabilized: Float? = null
    for (i in 0 until 4) {
      pts += 40_000L
      val res = estimator.onSample(pts, Format.NO_VALUE.toFloat())
      if (res != null) stabilized = res
    }
    assertEquals(25f, stabilized!!, 0.001f)
  }

  @Test
  fun `skips estimation when format already carries a valid positive frameRate (#199)`() {
    val callbacks = mutableListOf<Float>()
    val estimator = PtsFrameRateEstimator(onStabilized = { callbacks += it })
    val emitted = feedConstantInterval(estimator, intervalUs = 40_000L, frames = 65, formatFrameRate = 50f)
    assertEquals(emptyList<Float>(), emitted)
    assertEquals(emptyList<Float>(), callbacks)
    assertNull(estimator.stabilizedFps)
  }

  @Test
  fun `collects up to 60 deltas for non-standard frame rates before stabilizing and resets cleanly (#199)`() {
    val callbacks = mutableListOf<Float>()
    val estimator = PtsFrameRateEstimator(onStabilized = { callbacks += it })
    // 48 fps = 20_833 us -> does not snap to standard rate, waits until 60 deltas (61 frames)
    val before60 = feedConstantInterval(estimator, intervalUs = 20_833L, frames = 60)
    assertEquals(emptyList<Float>(), before60)
    val at60 = estimator.onSample(1_000_000L + 60L * 20_833L, Format.NO_VALUE.toFloat())
    assertEquals(48.0f, at60!!, 0.05f)
    assertEquals(1, callbacks.size)

    // Reset clears stabilized state and allows fresh estimation on next stream
    estimator.reset()
    assertNull(estimator.stabilizedFps)
    val next = feedConstantInterval(estimator, intervalUs = 20_000L, frames = 25)
    assertEquals(listOf(50f), next)
    assertEquals(2, callbacks.size)
  }

  @Test
  fun `tolerates outlier frame deltas via median calculation (#199)`() {
    val estimator = PtsFrameRateEstimator()
    var pts = 0L
    estimator.onSample(pts, Format.NO_VALUE.toFloat())
    // Mix 3 brief jitter outliers into 24 deltas of 41_708us (23.976fps)
    var stabilized: Float? = null
    for (i in 1..24) {
      val delta = when (i) {
        5 -> 83_416L // dropped frame (2x)
        12 -> 125_124L // dropped 2 frames (3x)
        18 -> 20_000L // burst frame
        else -> 41_708L
      }
      pts += delta
      val res = estimator.onSample(pts, Format.NO_VALUE.toFloat())
      if (res != null) stabilized = res
    }
    assertEquals(23.976f, stabilized!!, 0.001f)
  }
}

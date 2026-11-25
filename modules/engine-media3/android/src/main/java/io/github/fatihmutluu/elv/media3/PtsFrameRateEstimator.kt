package io.github.fatihmutluu.elv.media3

import android.media.MediaFormat
import androidx.annotation.OptIn
import androidx.media3.common.Format
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.video.VideoFrameMetadataListener
import kotlin.math.abs
import kotlin.math.roundToLong

internal const val PTS_FPS_MIN_SAMPLES = 24
internal const val PTS_FPS_MAX_SAMPLES = 60
internal const val PTS_FPS_MAX_DELTA_US = 500_000L
internal const val PTS_FPS_SNAP_TOLERANCE = 0.15f

internal val STANDARD_CINEMA_BROADCAST_FPS: FloatArray = floatArrayOf(
  23.976f,
  24f,
  25f,
  29.97f,
  30f,
  50f,
  59.94f,
  60f,
)

/** Snaps [rawFps] to the closest standard cinema/broadcast frame rate within ±[tolerance], or `null` if none matches (#199). */
internal fun snapStandardFrameRate(rawFps: Float, tolerance: Float = PTS_FPS_SNAP_TOLERANCE): Float? {
  if (!rawFps.isFinite() || rawFps <= 0f) return null
  var best: Float? = null
  var bestDiff = Float.MAX_VALUE
  for (candidate in STANDARD_CINEMA_BROADCAST_FPS) {
    val diff = abs(rawFps - candidate)
    if (diff <= tolerance && diff < bestDiff) {
      bestDiff = diff
      best = candidate
    }
  }
  return best
}

/**
 * Fallback frame-rate estimator sampling decoded video `presentationTimeUs` deltas when the container or codec
 * [Format.frameRate] is [Format.NO_VALUE] (common on IPTV MPEG-TS/H.264/HEVC streams, #199).
 *
 * Collects 24..60 monotonically increasing deltas strictly in `(0, 500_000)` microseconds, computes the median
 * delta, snaps within `±0.15` to standard cinema/broadcast rates, and emits once per stream until [reset].
 * Thread-safe for use directly as an ExoPlayer [VideoFrameMetadataListener].
 */
@OptIn(UnstableApi::class)
internal class PtsFrameRateEstimator(
  minSamples: Int = PTS_FPS_MIN_SAMPLES,
  maxSamples: Int = PTS_FPS_MAX_SAMPLES,
  private val onStabilized: (Float, Long) -> Unit = { _, _ -> },
) : VideoFrameMetadataListener {
  private val minCount = minSamples.coerceAtLeast(1)
  private val maxCount = maxSamples.coerceAtLeast(minCount)
  private val lock = Any()
  private val deltasUs = LongArray(maxCount)
  private var generation: Long = 0L
  private var sampleCount = 0
  private var lastPtsUs = Long.MIN_VALUE

  @Volatile
  var stabilizedFps: Float? = null
    private set

  /** Clears accumulated PTS samples and binds [nextGeneration] atomically under the estimator lock. */
  fun reset(nextGeneration: Long = 0L) {
    synchronized(lock) {
      generation = nextGeneration
      sampleCount = 0
      lastPtsUs = Long.MIN_VALUE
      stabilizedFps = null
    }
  }

  override fun onVideoFrameAboutToBeRendered(
    presentationTimeUs: Long,
    releaseTimeNs: Long,
    format: Format,
    mediaFormat: MediaFormat?,
  ) {
    if (stabilizedFps != null) return
    onSample(presentationTimeUs, format.frameRate)
  }

  /**
   * Feeds one video frame's [presentationTimeUs] and declared [formatFrameRate].
   * Returns the newly stabilized FPS on the exact frame it settles, or `null` otherwise.
   */
  fun onSample(presentationTimeUs: Long, formatFrameRate: Float): Float? {
    if (stabilizedFps != null) return null
    if (hasValidFormatFrameRate(formatFrameRate)) return null
    val emitted: Pair<Float, Long>? = synchronized(lock) {
      if (stabilizedFps != null) return@synchronized null
      val previous = lastPtsUs
      lastPtsUs = presentationTimeUs
      if (previous == Long.MIN_VALUE) return@synchronized null
      val delta = presentationTimeUs - previous
      if (delta <= 0L || delta >= PTS_FPS_MAX_DELTA_US) return@synchronized null
      if (sampleCount < maxCount) {
        deltasUs[sampleCount] = delta
        sampleCount += 1
      }
      if (sampleCount < minCount) return@synchronized null
      val medianUs = medianOf(deltasUs, sampleCount)
      if (medianUs <= 0.0) return@synchronized null
      val rawFps = (1_000_000.0 / medianUs).toFloat()
      if (!rawFps.isFinite() || rawFps <= 0f) return@synchronized null
      val snapped = snapStandardFrameRate(rawFps)
      val chosen = when {
        snapped != null -> snapped
        sampleCount >= maxCount -> ((rawFps.toDouble() * 100.0).roundToLong() / 100.0).toFloat()
        else -> null
      }
      if (chosen != null) {
        stabilizedFps = chosen
        chosen to generation
      } else {
        null
      }
    }
    if (emitted != null) {
      onStabilized(emitted.first, emitted.second)
    }
    return emitted?.first
  }

  private companion object {
    fun hasValidFormatFrameRate(frameRate: Float): Boolean =
      frameRate != Format.NO_VALUE.toFloat() && frameRate.isFinite() && frameRate > 0f

    fun medianOf(values: LongArray, count: Int): Double {
      val sorted = values.copyOf(count)
      sorted.sort()
      val mid = count / 2
      return if (count % 2 == 1) {
        sorted[mid].toDouble()
      } else {
        (sorted[mid - 1].toDouble() + sorted[mid].toDouble()) / 2.0
      }
    }
  }
}

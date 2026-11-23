package io.github.fatihmutluu.elv.media3

import androidx.media3.common.PlaybackParameters

/**
 * Pure playback-speed clamping and pitch-lock calculation for VOD streams (#264).
 * Clamps playback speed to `[0.25, 4.0]` (falling back to `1.0` for non-finite values) and sets pitch to `1.0` when
 * pitch-lock is enabled or matches the clamped speed when unlocked.
 */
internal object PlaybackSpeedPolicy {
  const val MIN_SPEED: Float = 0.25f
  const val MAX_SPEED: Float = 4.0f
  const val DEFAULT_SPEED: Float = 1.0f

  fun clampSpeed(rate: Double): Float {
    if (!rate.isFinite()) return DEFAULT_SPEED
    return rate.toFloat().coerceIn(MIN_SPEED, MAX_SPEED)
  }

  fun parameters(rate: Double, pitchLock: Boolean): PlaybackParameters {
    val speed = clampSpeed(rate)
    val pitch = if (pitchLock) DEFAULT_SPEED else speed
    return PlaybackParameters(speed, pitch)
  }

  fun parameters(speed: Float, pitchLock: Boolean): PlaybackParameters =
    parameters(speed.toDouble(), pitchLock)
}

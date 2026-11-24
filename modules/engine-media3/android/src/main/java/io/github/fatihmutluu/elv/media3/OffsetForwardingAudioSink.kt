package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioSink
import androidx.media3.exoplayer.audio.ForwardingAudioSink
import java.util.concurrent.atomic.AtomicLong

internal const val MIN_SYNC_DELAY_MS = -30_000L
internal const val MAX_SYNC_DELAY_MS = 30_000L
private const val MIN_SYNC_DELAY_US = MIN_SYNC_DELAY_MS * 1_000L
private const val MAX_SYNC_DELAY_US = MAX_SYNC_DELAY_MS * 1_000L

/** Clamps live audio or subtitle sync delay in milliseconds to `[-30_000, 30_000]` ms (`#203`, `#59`). */
internal fun clampSyncDelayMs(delayMs: Long): Long =
  delayMs.coerceIn(MIN_SYNC_DELAY_MS, MAX_SYNC_DELAY_MS)

/** Converts a clamped millisecond sync delay into microseconds. */
internal fun syncDelayMsToUs(delayMs: Long): Long =
  clampSyncDelayMs(delayMs) * 1_000L

/**
 * Applies a live A/V sync offset to [AudioSink.getCurrentPositionUs] (`#203`, `#59`):
 * - Preserves [AudioSink.CURRENT_POSITION_NOT_SET] verbatim.
 * - Adds clamped [audioDelayUs] (`MediaCodecAudioRenderer` drives ExoPlayer's `MediaClock`, so
 *   returning `rawPositionUs + clampedDelayUs` makes video render `clampedDelayUs` earlier than
 *   audio — delaying audio by `+clampedDelayUs` relative to video, matching `mpv` `audio-delay`
 *   and `AetherEngine.setAudioDelay`) and clamps at `0L` so timestamps never go negative.
 */
@OptIn(UnstableApi::class)
internal fun applyAudioDelayOffsetUs(rawPositionUs: Long, audioDelayUs: Long): Long {
  if (rawPositionUs == AudioSink.CURRENT_POSITION_NOT_SET) {
    return AudioSink.CURRENT_POSITION_NOT_SET
  }
  val clampedDelayUs = audioDelayUs.coerceIn(MIN_SYNC_DELAY_US, MAX_SYNC_DELAY_US)
  return (rawPositionUs + clampedDelayUs).coerceAtLeast(0L)
}

/**
 * [ForwardingAudioSink] wrapper applying a live, zero-reallocation A/V sync offset via [getCurrentPositionUs]
 * backed by a lock-free [AtomicLong] shared with `Media3Engine` (`#203`, `#59`).
 */
@OptIn(UnstableApi::class)
internal class OffsetForwardingAudioSink(
  delegate: AudioSink,
  private val sharedDelayUs: AtomicLong = AtomicLong(0L),
) : ForwardingAudioSink(delegate) {
  /** Live audio sync offset in microseconds (`[-30_000_000, 30_000_000]`). */
  var audioDelayUs: Long
    get() = sharedDelayUs.get()
    set(value) {
      sharedDelayUs.set(value.coerceIn(MIN_SYNC_DELAY_US, MAX_SYNC_DELAY_US))
    }

  /** Updates the live audio delay in milliseconds (`[-30_000, 30_000]`) with zero buffer reallocation. */
  fun setAudioDelayMs(delayMs: Long) {
    sharedDelayUs.set(syncDelayMsToUs(delayMs))
  }

  override fun getCurrentPositionUs(sourceEnded: Boolean): Long {
    val rawUs = super.getCurrentPositionUs(sourceEnded)
    return applyAudioDelayOffsetUs(rawUs, sharedDelayUs.get())
  }
}

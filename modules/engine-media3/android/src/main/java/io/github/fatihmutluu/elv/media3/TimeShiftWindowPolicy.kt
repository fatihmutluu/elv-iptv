package io.github.fatihmutluu.elv.media3

import androidx.media3.common.C

internal const val MIN_LIVE_TIMESHIFT_WINDOW_MS = 2_000L
internal const val LIVE_EDGE_SNAP_THRESHOLD_MS = 1_500L

/** Computed live time-shift clock metadata emitted on `ClockAnchor` (#28). */
internal data class LiveTimeShiftWindowState(
  val liveSeekableStartMs: Long?,
  val liveEdgeMs: Long?,
  val timeShiftSupported: Boolean,
)

/** Resolved live seek action for `Media3Engine.seek()` (#28). */
internal sealed class LiveSeekResolution {
  data object Ignore : LiveSeekResolution()
  data object JumpToDefaultLiveEdge : LiveSeekResolution()
  data class SeekTo(val positionMs: Long) : LiveSeekResolution()
}

/**
 * Computes `liveSeekableStartMs`, `liveEdgeMs`, and `timeShiftSupported` from Media3's current timeline window
 * and player state (#28). A live stream exposes bounded time-shift only when the current media item is seekable,
 * the timeline window is live, and the seekable window duration exceeds [minWindowMs] (default `2_000 ms`).
 */
internal fun evaluateLiveTimeShiftWindow(
  isLive: Boolean,
  isCurrentMediaItemSeekable: Boolean,
  isWindowLive: Boolean,
  windowDurationMs: Long,
  fallbackDurationMs: Long,
  minWindowMs: Long = MIN_LIVE_TIMESHIFT_WINDOW_MS,
  ringWindow: RingBufferTimeShiftWindow? = null,
): LiveTimeShiftWindowState {
  if (!isLive) {
    return LiveTimeShiftWindowState(
      liveSeekableStartMs = null,
      liveEdgeMs = null,
      timeShiftSupported = false,
    )
  }
  val validWindowDuration =
    if (windowDurationMs != C.TIME_UNSET && windowDurationMs > 0L) windowDurationMs else null
  val validFallbackDuration =
    if (fallbackDurationMs != C.TIME_UNSET && fallbackDurationMs > 0L) fallbackDurationMs else null

  if (isCurrentMediaItemSeekable && isWindowLive && validWindowDuration != null && validWindowDuration > minWindowMs) {
    return LiveTimeShiftWindowState(
      liveSeekableStartMs = 0L,
      liveEdgeMs = validWindowDuration,
      timeShiftSupported = true,
    )
  }

  if (
    ringWindow != null &&
    ringWindow.bufferedWindowMs >= minWindowMs &&
    ringWindow.liveEdgeMs > ringWindow.liveSeekableStartMs
  ) {
    return LiveTimeShiftWindowState(
      liveSeekableStartMs = ringWindow.liveSeekableStartMs,
      liveEdgeMs = ringWindow.liveEdgeMs,
      timeShiftSupported = true,
    )
  }

  return LiveTimeShiftWindowState(
    liveSeekableStartMs = null,
    liveEdgeMs = validWindowDuration ?: validFallbackDuration ?: ringWindow?.liveEdgeMs?.takeIf { it > 0L },
    timeShiftSupported = false,
  )
}

/**
 * Resolves a live seek request in `Media3Engine`: ignores non-seekable live streams, clamps targets to
 * `[minStartMs, durationMs]`, and snaps seeks within [snapToLiveThresholdMs] (default `1_500 ms`) of the live edge to
 * `seekToDefaultPosition()` (#28).
 */
internal fun resolveMedia3LiveSeek(
  requestedPositionMs: Long,
  isSeekable: Boolean,
  durationMs: Long,
  snapToLiveThresholdMs: Long = LIVE_EDGE_SNAP_THRESHOLD_MS,
  minStartMs: Long = 0L,
): LiveSeekResolution {
  if (!isSeekable) return LiveSeekResolution.Ignore
  val safeStart = minStartMs.coerceAtLeast(0L)
  val hasFiniteDuration = durationMs != C.TIME_UNSET && durationMs > safeStart
  val clamped = if (hasFiniteDuration) {
    requestedPositionMs.coerceIn(safeStart, durationMs)
  } else {
    requestedPositionMs.coerceAtLeast(safeStart)
  }
  if (hasFiniteDuration && durationMs - clamped <= snapToLiveThresholdMs) {
    return LiveSeekResolution.JumpToDefaultLiveEdge
  }
  return LiveSeekResolution.SeekTo(clamped)
}

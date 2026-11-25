package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer

/**
 * Executes a live time-shift or VOD seek on [player], clearing buffered subtitles and returning the updated
 * `lastVodPositionMs` (or `null` when unchanged) (#28, #141, #313).
 */
@OptIn(UnstableApi::class)
internal fun performEngineSeek(
  player: ExoPlayer,
  request: LoadRequest?,
  positionMs: Long,
  timeShiftTracker: TimeShiftWindowTracker?,
  clearSubtitles: () -> Unit,
): Long? {
  if (request?.live == true) {
    val ringWindow = timeShiftTracker?.currentWindow()
    val ringSeekable = ringWindow != null && ringWindow.bufferedWindowMs >= MIN_LIVE_TIMESHIFT_WINDOW_MS
    val isSeekable = player.isCurrentMediaItemSeekable || ringSeekable
    if (!isSeekable) return null
    val edgeMs = if (player.isCurrentMediaItemSeekable && player.duration != C.TIME_UNSET) {
      player.duration
    } else {
      ringWindow?.liveEdgeMs ?: player.duration
    }
    val minStartMs = if (player.isCurrentMediaItemSeekable) 0L else (ringWindow?.liveSeekableStartMs ?: 0L)
    when (val resolution = resolveMedia3LiveSeek(positionMs, isSeekable, edgeMs, minStartMs = minStartMs)) {
      LiveSeekResolution.Ignore -> return null
      LiveSeekResolution.JumpToDefaultLiveEdge -> {
        clearSubtitles()
        if (player.isCurrentMediaItemSeekable) {
          player.seekToDefaultPosition()
        } else if (edgeMs != C.TIME_UNSET && edgeMs >= 0L) {
          player.seekTo(edgeMs)
        }
      }
      is LiveSeekResolution.SeekTo -> {
        clearSubtitles()
        player.seekTo(resolution.positionMs)
      }
    }
    return null
  }
  if (!player.isCurrentMediaItemSeekable) return null
  val clamped = positionMs.coerceAtLeast(0L)
  val updatedVodPos = if (request?.live == false) {
    player.setSeekParameters(vodSeekParametersFor(clamped, player.currentPosition))
    clamped
  } else {
    null
  }
  clearSubtitles()
  player.seekTo(clamped)
  return updatedVodPos
}

package io.github.fatihmutluu.elv.media3

import android.os.Handler
import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer

private const val SUBTITLE_DELAY_TICK_MS = 50L

/**
 * Coordinates delayed primary, secondary, and dynamic sidecar subtitle cue delivery on [Media3Engine]'s playback
 * handler so `Media3Engine` stays focused on lifecycle and command orchestration (#32, #203, #402).
 */
@OptIn(UnstableApi::class)
internal class EngineSubtitleDelivery(
  private val handler: Handler,
  private val surfaces: SurfaceController,
  private val onTick: () -> Unit,
) {
  private val primaryCueBuffer = TimedSubtitleCueBuffer()
  private val secondarySubs = SecondarySubtitleController(onSecondaryCues = surfaces::onSecondaryCues)
  private var lastDeliveredCues: List<Cue>? = null
  private val tickRunnable = Runnable { onTick() }

  fun onPrimaryCues(
    player: ExoPlayer,
    cues: List<Cue>,
    filterSdh: Boolean,
    isTextDisabled: Boolean,
    isRendererOpen: Boolean,
    selectedExternalPrimaryId: String?,
    selectedSecondarySubtitleId: String?,
  ) {
    if (!isRendererOpen || isTextDisabled) return
    val sanitized = sanitizeCues(cues, filterSdh = filterSdh)
    val positionUs = player.currentPosition.coerceAtLeast(0L) * 1_000L
    primaryCueBuffer.record(positionUs, sanitized)
    applyResolved(
      player = player,
      filterSdh = filterSdh,
      isTextDisabled = isTextDisabled,
      isRendererOpen = isRendererOpen,
      selectedExternalPrimaryId = selectedExternalPrimaryId,
      selectedSecondarySubtitleId = selectedSecondarySubtitleId,
    )
  }

  fun onSecondaryRendererCues(
    player: ExoPlayer,
    cues: List<Cue>,
    filterSdh: Boolean,
    isTextDisabled: Boolean,
    isRendererOpen: Boolean,
    selectedExternalPrimaryId: String?,
    selectedSecondarySubtitleId: String?,
  ) {
    if (!isRendererOpen || selectedSecondarySubtitleId == null) return
    val positionUs = player.currentPosition.coerceAtLeast(0L) * 1_000L
    secondarySubs.onRendererCues(positionUs, cues, filterSdh = filterSdh)
    applyResolved(
      player = player,
      filterSdh = filterSdh,
      isTextDisabled = isTextDisabled,
      isRendererOpen = isRendererOpen,
      selectedExternalPrimaryId = selectedExternalPrimaryId,
      selectedSecondarySubtitleId = selectedSecondarySubtitleId,
    )
  }

  fun setDelayMs(delayMs: Long) {
    primaryCueBuffer.setDelayMs(delayMs)
    secondarySubs.setDelayMs(delayMs)
  }

  fun clearPrimary(resetDelay: Boolean) {
    if (resetDelay) primaryCueBuffer.reset() else primaryCueBuffer.clearCues()
    lastDeliveredCues = null
    surfaces.clearCues()
  }

  fun clearSecondary(resetDelay: Boolean) {
    secondarySubs.clearSecondaryCues(resetDelay = resetDelay)
  }

  fun clearAll(resetDelay: Boolean) {
    handler.removeCallbacks(tickRunnable)
    clearPrimary(resetDelay = resetDelay)
    secondarySubs.clearSecondaryCues(resetDelay = resetDelay)
  }

  fun resetAll() {
    handler.removeCallbacks(tickRunnable)
    secondarySubs.resetAll()
    clearAll(resetDelay = true)
  }

  fun cancelTick() {
    handler.removeCallbacks(tickRunnable)
  }

  fun registerExternalTrack(track: ExternalSubtitleConfig): Boolean = secondarySubs.registerExternalTrack(track)

  fun storeSidecarCues(trackId: String, cues: List<TimedSidecarCue>) = secondarySubs.storeSidecarCues(trackId, cues)

  fun dynamicExternalTrackSnapshots(): List<TrackInfoSnapshot> = secondarySubs.dynamicExternalTrackSnapshots()

  fun applyResolved(
    player: ExoPlayer,
    filterSdh: Boolean,
    isTextDisabled: Boolean,
    isRendererOpen: Boolean,
    selectedExternalPrimaryId: String?,
    selectedSecondarySubtitleId: String?,
  ) {
    handler.removeCallbacks(tickRunnable)
    if (!isRendererOpen) return
    val positionMs = player.currentPosition.coerceAtLeast(0L)
    val positionUs = positionMs * 1_000L
    if (selectedExternalPrimaryId != null) {
      val extCues = secondarySubs.resolvePrimarySidecar(positionMs, selectedExternalPrimaryId, filterSdh) ?: emptyList()
      if (extCues != lastDeliveredCues) {
        lastDeliveredCues = extCues
        surfaces.onCues(extCues)
      }
    } else if (!isTextDisabled) {
      val resolved = primaryCueBuffer.resolveCues(positionUs)
      if (resolved != lastDeliveredCues) {
        lastDeliveredCues = resolved
        surfaces.onCues(resolved)
      }
    }
    secondarySubs.resolveAndDeliverSecondary(positionMs, selectedSecondarySubtitleId, filterSdh)
    val needsTick = player.isPlaying && (
      (primaryCueBuffer.delayMs != 0L && (primaryCueBuffer.isNotEmpty || secondarySubs.isSecondaryBufferNotEmpty)) ||
        secondarySubs.hasActiveSidecars
      )
    if (needsTick) handler.postDelayed(tickRunnable, SUBTITLE_DELAY_TICK_MS)
  }
}

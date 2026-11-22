package io.github.fatihmutluu.elv.media3

import android.app.ActivityManager
import android.content.Context
import android.os.Looper
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector

private const val TAG = "ElvMedia3"
internal const val PLAYER_RELEASE_TIMEOUT_MS = 500L
internal const val PLAYER_DETACH_SURFACE_TIMEOUT_MS = 2_000L
internal const val PLAYER_STUCK_BUFFERING_TIMEOUT_MS = 30_000

/**
 * Selects keyframe-aligned VOD [SeekParameters] (#313): `PREVIOUS_SYNC` on initial `startMs` resume and backward seeks,
 * and `CLOSEST_SYNC` on forward seeks (never `NEXT_SYNC`, avoiding premature `STATE_ENDED` jumps near EOF).
 */
@OptIn(UnstableApi::class)
internal fun vodSeekParametersFor(targetPositionMs: Long, currentPositionMs: Long?): SeekParameters =
  if (currentPositionMs == null || targetPositionMs <= currentPositionMs) {
    SeekParameters.PREVIOUS_SYNC
  } else {
    SeekParameters.CLOSEST_SYNC
  }

internal fun readDeviceMemoryProfile(context: Context): Pair<Boolean, LoadControlValues> {
  val activity = context.getSystemService(ActivityManager::class.java)
    ?: return true to loadControlFor(lowRam = true)
  val memory = ActivityManager.MemoryInfo().also { activity.getMemoryInfo(it) }
  return isLowRam(activity.isLowRamDevice, memory.totalMem) to
    loadControlForMemory(activity.isLowRamDevice, memory.totalMem)
}

/**
 * Builds configured [ExoPlayer] instances on the engine's playback [looper] (#111, #127, #191, #248, #249, #260, #307):
 * - [DefaultLoadControl] with time-over-size priority and RAM-tiered back-buffer.
 * - [DefaultTrackSelector] with mixed-audio adaptiveness, renderer capability-change invalidation, and Android
 *   `CaptioningManager` accessibility defaults.
 * - `C.WAKE_MODE_NETWORK`, pinned release/detach/stuck-buffering timeouts, and `enablePerStreamMediaProgression(true)`.
 * - Automatic fallback to `handleAudioFocus = false` on firmwares throwing `SecurityException` on `TAKE_AUDIO_FOCUS`.
 */
@OptIn(UnstableApi::class)
internal class PlayerFactory(
  private val context: Context,
  private val looper: Looper,
  private val buffers: LoadControlValues,
  private val codecPolicy: CodecPolicy,
  private val audioFocusProbe: (Boolean) -> Unit = {},
) {
  @Volatile
  var audioFocusAllowed: Boolean = true
    private set

  fun disableAudioFocus() {
    audioFocusAllowed = false
  }

  fun build(softwareAudio: Boolean, preferHevcOverDolbyVision: Boolean = false): ExoPlayer {
    if (audioFocusAllowed) {
      try {
        audioFocusProbe(true)
        return buildInternal(softwareAudio, preferHevcOverDolbyVision, handleAudioFocus = true)
      } catch (e: SecurityException) {
        Log.w(TAG, "TAKE_AUDIO_FOCUS denied (${e.javaClass.simpleName}); falling back to handleAudioFocus=false")
        audioFocusAllowed = false
      }
    }
    audioFocusProbe(false)
    return buildInternal(softwareAudio, preferHevcOverDolbyVision, handleAudioFocus = false)
  }

  private fun buildInternal(
    softwareAudio: Boolean,
    preferHevcOverDolbyVision: Boolean,
    handleAudioFocus: Boolean,
  ): ExoPlayer {
    val renderers = createRenderersFactory(context, codecPolicy, softwareAudio, preferHevcOverDolbyVision)
    val loadControl = DefaultLoadControl.Builder()
      .setBufferDurationsMs(
        buffers.minBufferMs,
        buffers.maxBufferMs,
        buffers.bufferForPlaybackMs,
        buffers.bufferForPlaybackAfterRebufferMs,
      )
      .setTargetBufferBytes(buffers.targetBufferBytes)
      .setPrioritizeTimeOverSizeThresholds(buffers.prioritizeTimeOverSizeThresholds)
      .setBackBuffer(buffers.backBufferMs, buffers.retainBackBufferFromKeyframe)
      .build()
    val trackSelector = DefaultTrackSelector(context).apply {
      setParameters(
        buildUponParameters()
          .setAllowAudioMixedMimeTypeAdaptiveness(true)
          .setAllowAudioMixedSampleRateAdaptiveness(true)
          .setAllowAudioMixedChannelCountAdaptiveness(true)
          .setAllowAudioMixedDecoderSupportAdaptiveness(true)
          .setAllowInvalidateSelectionsOnRendererCapabilitiesChange(true)
          .setPreferredTextLanguageAndRoleFlagsToCaptioningManagerSettings()
      )
    }
    return ExoPlayer.Builder(context, renderers)
      .setLooper(looper)
      .setTrackSelector(trackSelector)
      .setLoadControl(loadControl)
      .setAudioAttributes(STREAM_AUDIO_ATTRIBUTES, handleAudioFocus)
      .setHandleAudioBecomingNoisy(true)
      .setWakeMode(C.WAKE_MODE_NETWORK)
      .setReleaseTimeoutMs(PLAYER_RELEASE_TIMEOUT_MS)
      .setDetachSurfaceTimeoutMs(PLAYER_DETACH_SURFACE_TIMEOUT_MS)
      .setStuckBufferingDetectionTimeoutMs(PLAYER_STUCK_BUFFERING_TIMEOUT_MS)
      .enablePerStreamMediaProgression(true)
      .build()
  }
}

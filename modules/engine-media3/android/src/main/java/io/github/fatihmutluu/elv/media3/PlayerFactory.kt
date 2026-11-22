package io.github.fatihmutluu.elv.media3

import android.app.ActivityManager
import android.content.Context
import android.os.Looper
import android.util.Log
import android.view.accessibility.CaptioningManager
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

/** Snapshot of Android device memory tier used to derive live vs VOD [LoadControlValues] (#422). */
internal data class DeviceMemoryProfile(
  val isLowRamDevice: Boolean,
  val totalMemBytes: Long,
  val lowRam: Boolean = isLowRam(isLowRamDevice, totalMemBytes),
) {
  fun loadControl(live: Boolean): LoadControlValues =
    loadControlForMemory(isLowRamDevice, totalMemBytes, live = live)
}

internal fun readDeviceMemoryProfile(context: Context): DeviceMemoryProfile {
  val activity = context.getSystemService(ActivityManager::class.java)
    ?: return DeviceMemoryProfile(isLowRamDevice = true, totalMemBytes = 0L, lowRam = true)
  val memory = ActivityManager.MemoryInfo().also { activity.getMemoryInfo(it) }
  return DeviceMemoryProfile(
    isLowRamDevice = activity.isLowRamDevice,
    totalMemBytes = memory.totalMem,
    lowRam = isLowRam(activity.isLowRamDevice, memory.totalMem),
  )
}

/** True only when Android system accessibility captioning is explicitly enabled (#438). */
internal fun isSystemCaptioningEnabled(context: Context): Boolean =
  runCatching { context.getSystemService(CaptioningManager::class.java)?.isEnabled == true }
    .getOrDefault(false)

/**
 * Builds configured [ExoPlayer] instances on the engine's playback [looper] (#111, #127, #191, #248, #249, #260, #307,
 * #422, #438):
 * - [DefaultLoadControl] split by live vs VOD and RAM tier (hard byte cap on low-RAM).
 * - [DefaultTrackSelector] with mixed-audio adaptiveness, renderer capability-change invalidation, and
 *   `CaptioningManager` defaults applied only when system captioning is enabled.
 * - `C.WAKE_MODE_NETWORK`, pinned release/detach/stuck-buffering timeouts, and `enablePerStreamMediaProgression(true)`.
 * - Automatic fallback to `handleAudioFocus = false` on firmwares throwing `SecurityException` on `TAKE_AUDIO_FOCUS`.
 */
@OptIn(UnstableApi::class)
internal class PlayerFactory(
  private val context: Context,
  private val looper: Looper,
  private val loadControlForLive: (Boolean) -> LoadControlValues,
  private val codecPolicy: CodecPolicy,
  private val audioFocusProbe: (Boolean) -> Unit = {},
  private val captioningEnabled: () -> Boolean = { isSystemCaptioningEnabled(context) },
) {
  constructor(
    context: Context,
    looper: Looper,
    buffers: LoadControlValues,
    codecPolicy: CodecPolicy,
    audioFocusProbe: (Boolean) -> Unit = {},
    captioningEnabled: () -> Boolean = { isSystemCaptioningEnabled(context) },
  ) : this(
    context = context,
    looper = looper,
    loadControlForLive = { buffers },
    codecPolicy = codecPolicy,
    audioFocusProbe = audioFocusProbe,
    captioningEnabled = captioningEnabled,
  )

  @Volatile
  var audioFocusAllowed: Boolean = true
    private set

  fun disableAudioFocus() {
    audioFocusAllowed = false
  }

  fun build(
    softwareAudio: Boolean,
    preferHevcOverDolbyVision: Boolean = false,
    live: Boolean = false,
  ): ExoPlayer {
    if (audioFocusAllowed) {
      try {
        audioFocusProbe(true)
        return buildInternal(softwareAudio, preferHevcOverDolbyVision, live, handleAudioFocus = true)
      } catch (e: SecurityException) {
        Log.w(TAG, "TAKE_AUDIO_FOCUS denied (${e.javaClass.simpleName}); falling back to handleAudioFocus=false")
        audioFocusAllowed = false
      }
    }
    audioFocusProbe(false)
    return buildInternal(softwareAudio, preferHevcOverDolbyVision, live, handleAudioFocus = false)
  }

  private fun buildInternal(
    softwareAudio: Boolean,
    preferHevcOverDolbyVision: Boolean,
    live: Boolean,
    handleAudioFocus: Boolean,
  ): ExoPlayer {
    val buffers = loadControlForLive(live)
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
      val params = buildUponParameters()
        .setAllowAudioMixedMimeTypeAdaptiveness(true)
        .setAllowAudioMixedSampleRateAdaptiveness(true)
        .setAllowAudioMixedChannelCountAdaptiveness(true)
        .setAllowAudioMixedDecoderSupportAdaptiveness(true)
        .setAllowInvalidateSelectionsOnRendererCapabilitiesChange(true)
      if (captioningEnabled()) {
        params.setPreferredTextLanguageAndRoleFlagsToCaptioningManagerSettings()
      } else {
        params.setPreferredTextLanguage(null).setPreferredTextRoleFlags(0)
      }
      setParameters(params)
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

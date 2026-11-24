package io.github.fatihmutluu.elv.media3

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.os.Looper
import android.util.Log
import android.view.accessibility.CaptioningManager
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.TrackSelectionParameters.AudioOffloadPreferences
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.text.TextOutput
import java.util.concurrent.atomic.AtomicLong

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

/** Snapshot of Android device memory tier used to derive stream-specific [LoadControlValues] (#147, #262, #422). */
internal data class DeviceMemoryProfile(
  val isLowRamDevice: Boolean,
  val totalMemBytes: Long,
  val lowRam: Boolean = isLowRam(isLowRamDevice, totalMemBytes),
) {
  fun loadControl(live: Boolean): LoadControlValues =
    loadControlForMemory(isLowRamDevice, totalMemBytes, live = live)

  fun loadControl(streamKind: StreamKind, preset: BufferPreset = BufferPreset.AUTO): LoadControlValues =
    loadControlForStream(isLowRamDevice, totalMemBytes, streamKind, preset)
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
 * Selects Media3's video frame-rate switching strategy by Android API level (#151):
 * enables seamless-only frame-rate switching on Android 11+ (API 30+) and disables it on older APIs.
 */
@OptIn(UnstableApi::class)
internal fun videoChangeFrameRateStrategyForApi(sdkInt: Int): Int =
  if (sdkInt >= Build.VERSION_CODES.R) {
    C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS
  } else {
    C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF
  }

/**
 * Builds configured [ExoPlayer] instances on the engine's playback [looper] (#111, #127, #147, #191, #222, #248, #249,
 * #260, #261, #262, #307, #422, #438):
 * - [DefaultLoadControl] split by [StreamKind], [BufferPreset], and RAM tier (hard `16 MiB` cap on low-RAM).
 * - [DefaultTrackSelector] with mixed-audio adaptiveness, renderer capability-change invalidation,
 *   [AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED] (tunneling disabled), and `CaptioningManager` gated on
 *   system `isEnabled`.
 * - `C.WAKE_MODE_NETWORK`, pinned release/detach/stuck-buffering timeouts, and `enablePerStreamMediaProgression(true)`.
 * - Automatic fallback to `handleAudioFocus = false` on firmwares throwing `SecurityException` on `TAKE_AUDIO_FOCUS`.
 */
@OptIn(UnstableApi::class)
internal class PlayerFactory(
  private val context: Context,
  private val looper: Looper,
  private val loadControlForStream: (StreamKind, BufferPreset) -> LoadControlValues,
  private val codecPolicy: CodecPolicy,
  private val audioFocusProbe: (Boolean) -> Unit = {},
  private val captioningEnabled: () -> Boolean = { isSystemCaptioningEnabled(context) },
  private val deviceQuirks: DeviceQuirks = DeviceQuirks.fromBuild(),
  private val sdkInt: Int = Build.VERSION.SDK_INT,
  private val audioDelayUs: AtomicLong = AtomicLong(0L),
  private val secondaryTextOutput: TextOutput? = null,
  private val assOverlayBridge: AssOverlayBridge? = null,
) {
  constructor(
    context: Context,
    looper: Looper,
    buffers: LoadControlValues,
    codecPolicy: CodecPolicy,
    audioFocusProbe: (Boolean) -> Unit = {},
    captioningEnabled: () -> Boolean = { isSystemCaptioningEnabled(context) },
    deviceQuirks: DeviceQuirks = DeviceQuirks.fromBuild(),
    sdkInt: Int = Build.VERSION.SDK_INT,
    audioDelayUs: AtomicLong = AtomicLong(0L),
    secondaryTextOutput: TextOutput? = null,
    assOverlayBridge: AssOverlayBridge? = null,
  ) : this(
    context = context,
    looper = looper,
    loadControlForStream = { _, _ -> buffers },
    codecPolicy = codecPolicy,
    audioFocusProbe = audioFocusProbe,
    captioningEnabled = captioningEnabled,
    deviceQuirks = deviceQuirks,
    sdkInt = sdkInt,
    audioDelayUs = audioDelayUs,
    secondaryTextOutput = secondaryTextOutput,
    assOverlayBridge = assOverlayBridge,
  )

  @Volatile
  var audioFocusAllowed: Boolean = true
    private set

  @Volatile
  var lastTrackSelector: DualSubtitleTrackSelector? = null
    private set

  fun disableAudioFocus() {
    audioFocusAllowed = false
  }

  fun build(
    softwareAudio: Boolean,
    preferHevcOverDolbyVision: Boolean = false,
    live: Boolean = false,
    streamKind: StreamKind = if (live) StreamKind.HLS_LIVE else StreamKind.VOD,
    bufferPreset: BufferPreset = BufferPreset.AUTO,
    decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
  ): ExoPlayer {
    if (audioFocusAllowed) {
      try {
        audioFocusProbe(true)
        return buildInternal(
          softwareAudio = softwareAudio,
          preferHevcOverDolbyVision = preferHevcOverDolbyVision,
          streamKind = streamKind,
          bufferPreset = bufferPreset,
          decoderMode = decoderMode,
          handleAudioFocus = true,
        )
      } catch (e: SecurityException) {
        Log.w(TAG, "TAKE_AUDIO_FOCUS denied (${e.javaClass.simpleName}); falling back to handleAudioFocus=false")
        audioFocusAllowed = false
      }
    }
    audioFocusProbe(false)
    return buildInternal(
      softwareAudio = softwareAudio,
      preferHevcOverDolbyVision = preferHevcOverDolbyVision,
      streamKind = streamKind,
      bufferPreset = bufferPreset,
      decoderMode = decoderMode,
      handleAudioFocus = false,
    )
  }

  private fun buildInternal(
    softwareAudio: Boolean,
    preferHevcOverDolbyVision: Boolean,
    streamKind: StreamKind,
    bufferPreset: BufferPreset,
    decoderMode: VideoDecoderMode,
    handleAudioFocus: Boolean,
  ): ExoPlayer {
    val buffers = loadControlForStream(streamKind, bufferPreset)
    assOverlayBridge?.beginPlayerSession()
    val baseRenderers = createRenderersFactory(
      context = context,
      codecPolicy = codecPolicy,
      softwareAudio = softwareAudio,
      preferHevcOverDolbyVision = preferHevcOverDolbyVision,
      deviceQuirks = deviceQuirks,
      decoderMode = decoderMode,
      audioDelayUs = audioDelayUs,
      secondaryTextOutput = secondaryTextOutput,
    )
    val renderers = assOverlayBridge?.wrapRenderersFactory(baseRenderers) ?: baseRenderers
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
    val audioOffload = AudioOffloadPreferences.Builder()
      .setAudioOffloadMode(AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED)
      .build()
    val trackSelector = DualSubtitleTrackSelector(context).apply {
      val params = buildUponParameters()
        .setAllowAudioMixedMimeTypeAdaptiveness(true)
        .setAllowAudioMixedSampleRateAdaptiveness(true)
        .setAllowAudioMixedChannelCountAdaptiveness(true)
        .setAllowAudioMixedDecoderSupportAdaptiveness(true)
        .setAllowInvalidateSelectionsOnRendererCapabilitiesChange(true)
        .setAudioOffloadPreferences(audioOffload)
      if (captioningEnabled()) {
        params.setPreferredTextLanguageAndRoleFlagsToCaptioningManagerSettings()
      } else {
        params.setPreferredTextLanguage(null).setPreferredTextRoleFlags(0)
      }
      setParameters(params)
    }
    lastTrackSelector = trackSelector
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
      .setVideoChangeFrameRateStrategy(videoChangeFrameRateStrategyForApi(sdkInt))
      .enablePerStreamMediaProgression(true)
      .build()
      .also { built ->
        assOverlayBridge?.attachPlayer(built)
      }
  }
}

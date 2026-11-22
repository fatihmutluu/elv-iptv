package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.media.MediaCodecInfo.CodecProfileLevel
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioCapabilitiesReceiver
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import androidx.media3.exoplayer.video.MediaCodecVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

private const val REPEATED_FAILURE_THRESHOLD = 2

private val HEAVY_VIDEO_MIMES = setOf(
  MimeTypes.VIDEO_H265,
  MimeTypes.VIDEO_VP9,
  MimeTypes.VIDEO_AV1,
  MimeTypes.VIDEO_DOLBY_VISION,
)

private val DTS_AUDIO_MIMES = setOf(
  MimeTypes.AUDIO_DTS,
  MimeTypes.AUDIO_DTS_HD,
  MimeTypes.AUDIO_DTS_EXPRESS,
)

internal val STREAM_AUDIO_ATTRIBUTES: AudioAttributes = AudioAttributes.Builder()
  .setUsage(C.USAGE_MEDIA)
  .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
  .build()

/** Expected audio decode path for diagnostics and capability verification (#331). */
internal enum class AudioDecodePath {
  HARDWARE_MEDIACODEC,
  SOFTWARE_MEDIACODEC,
  FFMPEG_JNI,
  UNSUPPORTED,
}

@OptIn(UnstableApi::class)
internal fun extensionRendererModeFor(softwareAudio: Boolean): Int =
  if (softwareAudio) {
    DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER
  } else {
    DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON
  }

/** True when [codecs] declares a Dolby Vision Profile 7 stream (`dvhe.07.*` or `dvh1.07.*`, case-insensitive). */
internal fun isDolbyVisionProfile7Codec(codecs: String?): Boolean {
  val raw = codecs?.trim()?.takeIf { it.isNotEmpty() } ?: return false
  return raw.split(',').any { entry ->
    val token = entry.trim().lowercase(Locale.ROOT)
    token == "dvhe.07" ||
      token.startsWith("dvhe.07.") ||
      token == "dvh1.07" ||
      token.startsWith("dvh1.07.")
  }
}

/** True when any hardware Dolby Vision decoder in [decoders] advertises [profile]. */
@OptIn(UnstableApi::class)
internal fun supportsDolbyVisionProfile(decoders: List<MediaCodecInfo>, profile: Int): Boolean =
  decoders.any { info ->
    !info.softwareOnly &&
      info.mimeType.equals(MimeTypes.VIDEO_DOLBY_VISION, ignoreCase = true) &&
      info.profileLevels.any { it.profile == profile }
  }

/** True when any hardware decoder in [decoders] advertises Dolby Vision Profile 7 (`DolbyVisionProfileDvheDtb`). */
@OptIn(UnstableApi::class)
internal fun supportsDolbyVisionProfile7(decoders: List<MediaCodecInfo>): Boolean =
  supportsDolbyVisionProfile(decoders, CodecProfileLevel.DolbyVisionProfileDvheDtb)

/** True when any hardware decoder in [decoders] advertises Dolby Vision Profile 8.1 (`DolbyVisionProfileDvheSt`). */
@OptIn(UnstableApi::class)
internal fun supportsDolbyVisionProfile81(decoders: List<MediaCodecInfo>): Boolean =
  supportsDolbyVisionProfile(decoders, CodecProfileLevel.DolbyVisionProfileDvheSt)

/**
 * True when Dolby Vision should fall back to HEVC base-layer decoding (#189): explicitly requested, latched after a
 * prior DV decoder failure, or a Profile 7 stream on hardware decoders that do not expose Profile 7.
 */
@OptIn(UnstableApi::class)
internal fun shouldFallbackDolbyVisionToHevc(
  codecs: String?,
  dvDecoders: List<MediaCodecInfo>,
  preferHevcOverDolbyVision: Boolean,
  dvFallbackLatched: Boolean,
): Boolean =
  preferHevcOverDolbyVision ||
    dvFallbackLatched ||
    (isDolbyVisionProfile7Codec(codecs) && !supportsDolbyVisionProfile7(dvDecoders))

/**
 * Per-engine decoder selection policy (#109, #128, #184, #189, #312, #331):
 * - Orders hardware video decoders ahead of software decoders.
 * - Excludes `softwareOnly` heavy/UHD decoders on initial pass when a hardware decoder exists so Rung 1 retries
 *   hardware after transient zap HAL contention, then unlocks software fallback and deprioritizes repeatedly failing
 *   hardware decoders (`>= 2` failures) or on Rung 4 (`softwareAudio = true`).
 * - Falls back from `VIDEO_DOLBY_VISION` to HEVC (`VIDEO_H265`) base-layer decoders when `preferHevcOverDolbyVision`
 *   is set, no DV decoder exists, or a DV decoder failed on this stream.
 * - Filters silent stub platform DTS `MediaCodec`s when FFmpeg JNI supports DTS and HDMI passthrough is absent.
 */
@OptIn(UnstableApi::class)
internal class CodecPolicy {
  private val videoFailures = ConcurrentHashMap<String, Int>()
  private val dolbyVisionFallback = AtomicBoolean(false)
  @Volatile private var cachedAudioCapabilities: AudioCapabilities? = null
  private val capabilitiesLock = Any()
  private var audioCapabilitiesReceiver: AudioCapabilitiesReceiver? = null
  private var audioCapabilitiesStarted = false
  private var audioCapabilitiesEpoch = 0

  val isDolbyVisionFallbackActive: Boolean
    get() = dolbyVisionFallback.get()

  /** Starts caching HDMI/output [AudioCapabilities] via [AudioCapabilitiesReceiver] on [handler]; idempotent (#438). */
  fun startAudioCapabilities(context: Context, handler: Handler) {
    val appContext = context.applicationContext ?: context
    val startEpoch = synchronized(capabilitiesLock) {
      if (audioCapabilitiesStarted) return
      audioCapabilitiesStarted = true
      audioCapabilitiesEpoch += 1
      audioCapabilitiesEpoch
    }
    val register = Runnable {
      val receiver = runCatching {
        AudioCapabilitiesReceiver(
          appContext,
          AudioCapabilitiesReceiver.Listener { caps ->
            synchronized(capabilitiesLock) {
              if (audioCapabilitiesStarted && audioCapabilitiesEpoch == startEpoch) {
                cachedAudioCapabilities = caps
              }
            }
          },
          STREAM_AUDIO_ATTRIBUTES,
          null,
        )
      }.getOrNull()
      if (receiver == null) {
        synchronized(capabilitiesLock) {
          if (audioCapabilitiesEpoch == startEpoch) audioCapabilitiesStarted = false
        }
        return@Runnable
      }
      val initial = runCatching { receiver.register() }.getOrNull()
      val keep = synchronized(capabilitiesLock) {
        if (audioCapabilitiesStarted && audioCapabilitiesEpoch == startEpoch && audioCapabilitiesReceiver == null) {
          audioCapabilitiesReceiver = receiver
          if (initial != null) cachedAudioCapabilities = initial
          true
        } else {
          false
        }
      }
      if (!keep) runCatching { receiver.unregister() }
    }
    if (Looper.myLooper() == handler.looper) {
      register.run()
    } else if (!handler.post(register)) {
      synchronized(capabilitiesLock) {
        if (audioCapabilitiesEpoch == startEpoch) audioCapabilitiesStarted = false
      }
    }
  }

  /** Stops the [AudioCapabilitiesReceiver] and clears cached capabilities; idempotent (#438). */
  fun stopAudioCapabilities() {
    val receiver = synchronized(capabilitiesLock) {
      audioCapabilitiesStarted = false
      audioCapabilitiesEpoch += 1
      cachedAudioCapabilities = null
      audioCapabilitiesReceiver.also { audioCapabilitiesReceiver = null }
    }
    if (receiver != null) runCatching { receiver.unregister() }
  }

  internal fun updateAudioCapabilitiesForTest(caps: AudioCapabilities?) {
    cachedAudioCapabilities = caps
  }

  fun recordDolbyVisionFallback() {
    dolbyVisionFallback.set(true)
  }

  fun clearDolbyVisionFallback() {
    dolbyVisionFallback.set(false)
  }

  fun recordVideoCodecFailure(codecInfo: MediaCodecInfo) {
    if (codecInfo.mimeType.equals(MimeTypes.VIDEO_DOLBY_VISION, ignoreCase = true)) {
      recordDolbyVisionFallback()
    }
    if (!codecInfo.softwareOnly && codecInfo.name.isNotEmpty()) {
      videoFailures.merge(codecInfo.name, 1, Int::plus)
    }
  }

  fun selectDecoders(
    mimeType: String,
    decoders: List<MediaCodecInfo>,
    softwareAudio: Boolean,
    ffmpegSupportsMime: Boolean,
    hasDtsPassthrough: Boolean,
    preferHevcOverDolbyVision: Boolean = false,
    hevcFallbackDecoders: List<MediaCodecInfo> = emptyList(),
  ): List<MediaCodecInfo> {
    if (mimeType == MimeTypes.VIDEO_DOLBY_VISION &&
      (preferHevcOverDolbyVision || dolbyVisionFallback.get() || decoders.isEmpty()) &&
      hevcFallbackDecoders.isNotEmpty()
    ) {
      return selectDecoders(
        mimeType = MimeTypes.VIDEO_H265,
        decoders = hevcFallbackDecoders,
        softwareAudio = softwareAudio,
        ffmpegSupportsMime = false,
        hasDtsPassthrough = false,
      )
    }
    if (MimeTypes.isVideo(mimeType)) {
      val ordered = decoders.sortedBy { info ->
        when {
          !info.softwareOnly && (videoFailures[info.name] ?: 0) >= REPEATED_FAILURE_THRESHOLD -> 2
          info.softwareOnly -> 1
          else -> 0
        }
      }
      val anyRepeatedFailure = decoders.any {
        !it.softwareOnly && (videoFailures[it.name] ?: 0) >= REPEATED_FAILURE_THRESHOLD
      }
      if (mimeType in HEAVY_VIDEO_MIMES && !softwareAudio && !anyRepeatedFailure) {
        val hardwareOnly = ordered.filter { !it.softwareOnly }
        if (hardwareOnly.isNotEmpty()) return hardwareOnly
      }
      return ordered
    }
    if (MimeTypes.isAudio(mimeType)) {
      if (mimeType in DTS_AUDIO_MIMES && ffmpegSupportsMime && !hasDtsPassthrough) {
        return emptyList()
      }
      return if (softwareAudio) MediaCodecUtil.getDecoderInfosSortedBySoftwareOnly(decoders) else decoders
    }
    return decoders
  }

  fun resolveAudioDecodePath(
    mimeType: String,
    decoders: List<MediaCodecInfo>,
    softwareAudio: Boolean,
    ffmpegSupportsMime: Boolean,
    hasDtsPassthrough: Boolean,
  ): AudioDecodePath {
    if (softwareAudio && ffmpegSupportsMime) return AudioDecodePath.FFMPEG_JNI
    val selected = selectDecoders(mimeType, decoders, softwareAudio, ffmpegSupportsMime, hasDtsPassthrough)
    val first = selected.firstOrNull()
    if (first != null) {
      return if (first.softwareOnly) AudioDecodePath.SOFTWARE_MEDIACODEC else AudioDecodePath.HARDWARE_MEDIACODEC
    }
    return if (ffmpegSupportsMime) AudioDecodePath.FFMPEG_JNI else AudioDecodePath.UNSUPPORTED
  }

  fun createSelector(
    context: Context,
    softwareAudio: Boolean,
    preferHevcOverDolbyVision: Boolean = false,
  ): MediaCodecSelector =
    MediaCodecSelector { mimeType, secure, tunneling ->
      val decoders = MediaCodecSelector.DEFAULT.getDecoderInfos(mimeType, secure, tunneling)
      val hevcFallback =
        if (mimeType == MimeTypes.VIDEO_DOLBY_VISION) {
          MediaCodecSelector.DEFAULT.getDecoderInfos(MimeTypes.VIDEO_H265, secure, tunneling)
        } else {
          emptyList()
        }
      val dtsMime = mimeType in DTS_AUDIO_MIMES
      val ffmpegSupports = dtsMime && runCatching { FfmpegAudio.supportsMimeType(mimeType) }.getOrDefault(false)
      val passthrough = dtsMime && hasDtsPassthrough(context, mimeType)
      selectDecoders(
        mimeType = mimeType,
        decoders = decoders,
        softwareAudio = softwareAudio,
        ffmpegSupportsMime = ffmpegSupports,
        hasDtsPassthrough = passthrough,
        preferHevcOverDolbyVision = preferHevcOverDolbyVision,
        hevcFallbackDecoders = hevcFallback,
      )
    }

  internal fun hasDtsPassthrough(context: Context, mimeType: String): Boolean {
    val caps = cachedAudioCapabilities ?: runCatching {
      AudioCapabilities.getCapabilities(context, STREAM_AUDIO_ATTRIBUTES, null, emptyList())
    }.getOrDefault(AudioCapabilities.DEFAULT_AUDIO_CAPABILITIES)
    return when (mimeType) {
      MimeTypes.AUDIO_DTS_HD -> caps.supportsEncoding(C.ENCODING_DTS_HD)
      else -> caps.supportsEncoding(C.ENCODING_DTS) || caps.supportsEncoding(C.ENCODING_DTS_HD)
    }
  }
}

/**
 * Video renderer enforcing proactive Dolby Vision Profile 7 -> HEVC base-layer fallback (#189) where
 * [Format.codecs] is available (before opening an incompatible hardware DV decoder).
 */
@OptIn(UnstableApi::class)
internal class PolicyVideoRenderer(
  builder: Builder,
  private val codecPolicy: CodecPolicy,
  private val preferHevcOverDolbyVision: Boolean,
) : MediaCodecVideoRenderer(builder) {
  override fun getDecoderInfos(
    mediaCodecSelector: MediaCodecSelector,
    format: Format,
    requiresSecureDecoder: Boolean,
  ): List<MediaCodecInfo> {
    if (MimeTypes.VIDEO_DOLBY_VISION.equals(format.sampleMimeType, ignoreCase = true)) {
      val dvDecoders = mediaCodecSelector.getDecoderInfos(
        MimeTypes.VIDEO_DOLBY_VISION,
        requiresSecureDecoder,
        /* requiresTunnelingDecoder = */ false,
      )
      if (shouldFallbackDolbyVisionToHevc(
          codecs = format.codecs,
          dvDecoders = dvDecoders,
          preferHevcOverDolbyVision = preferHevcOverDolbyVision,
          dvFallbackLatched = codecPolicy.isDolbyVisionFallbackActive,
        )
      ) {
        val hevcDecoders = mediaCodecSelector.getDecoderInfos(
          MimeTypes.VIDEO_H265,
          requiresSecureDecoder,
          /* requiresTunnelingDecoder = */ false,
        )
        if (hevcDecoders.isNotEmpty()) return hevcDecoders
      }
    }
    return super.getDecoderInfos(mediaCodecSelector, format, requiresSecureDecoder)
  }

  internal fun resolveDecoderInfosForTest(
    mediaCodecSelector: MediaCodecSelector,
    format: Format,
    requiresSecureDecoder: Boolean = false,
  ): List<MediaCodecInfo> = getDecoderInfos(mediaCodecSelector, format, requiresSecureDecoder)
}

@OptIn(UnstableApi::class)
internal fun createRenderersFactory(
  context: Context,
  codecPolicy: CodecPolicy,
  softwareAudio: Boolean,
  preferHevcOverDolbyVision: Boolean = false,
): DefaultRenderersFactory {
  FfmpegAudio.ensureConfigured()
  return object : DefaultRenderersFactory(context) {
    override fun buildVideoRenderers(
      context: Context,
      extensionRendererMode: Int,
      mediaCodecSelector: MediaCodecSelector,
      enableDecoderFallback: Boolean,
      eventHandler: Handler,
      eventListener: VideoRendererEventListener,
      allowedVideoJoiningTimeMs: Long,
      out: ArrayList<Renderer>,
    ) {
      val builder = MediaCodecVideoRenderer.Builder(context)
        .setCodecAdapterFactory(codecAdapterFactory)
        .setMediaCodecSelector(mediaCodecSelector)
        .setAllowedJoiningTimeMs(allowedVideoJoiningTimeMs)
        .setEnableDecoderFallback(enableDecoderFallback)
        .setEventHandler(eventHandler)
        .setEventListener(eventListener)
        .setMaxDroppedFramesToNotify(MAX_DROPPED_VIDEO_FRAME_COUNT_TO_NOTIFY)
      out.add(PolicyVideoRenderer(builder, codecPolicy, preferHevcOverDolbyVision))
    }
  }
    .setEnableDecoderFallback(true)
    .setExtensionRendererMode(extensionRendererModeFor(softwareAudio))
    .setMediaCodecSelector(codecPolicy.createSelector(context, softwareAudio, preferHevcOverDolbyVision))
}

@OptIn(UnstableApi::class)
internal fun createRenderersFactory(context: Context, softwareAudio: Boolean): DefaultRenderersFactory =
  createRenderersFactory(context, CodecPolicy(), softwareAudio)

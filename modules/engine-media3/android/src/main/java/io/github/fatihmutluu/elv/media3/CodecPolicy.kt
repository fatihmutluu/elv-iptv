package io.github.fatihmutluu.elv.media3

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import java.util.concurrent.ConcurrentHashMap

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

/**
 * Per-engine decoder selection policy (#109, #128, #184, #312, #331):
 * - Orders hardware video decoders ahead of software decoders.
 * - Excludes `softwareOnly` heavy/UHD decoders on initial pass when a hardware decoder exists so Rung 1 retries
 *   hardware after transient zap HAL contention, then unlocks software fallback and deprioritizes repeatedly failing
 *   hardware decoders (`>= 2` failures) or on Rung 4 (`softwareAudio = true`).
 * - Filters silent stub platform DTS `MediaCodec`s when FFmpeg JNI supports DTS and HDMI passthrough is absent.
 */
@OptIn(UnstableApi::class)
internal class CodecPolicy {
  private val videoFailures = ConcurrentHashMap<String, Int>()

  fun recordVideoCodecFailure(codecInfo: MediaCodecInfo) {
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
  ): List<MediaCodecInfo> {
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

  fun createSelector(context: Context, softwareAudio: Boolean): MediaCodecSelector =
    MediaCodecSelector { mimeType, secure, tunneling ->
      val decoders = MediaCodecSelector.DEFAULT.getDecoderInfos(mimeType, secure, tunneling)
      val dtsMime = mimeType in DTS_AUDIO_MIMES
      val ffmpegSupports = dtsMime && runCatching { FfmpegAudio.supportsMimeType(mimeType) }.getOrDefault(false)
      val passthrough = dtsMime && hasDtsPassthrough(context, mimeType)
      selectDecoders(mimeType, decoders, softwareAudio, ffmpegSupports, passthrough)
    }

  private fun hasDtsPassthrough(context: Context, mimeType: String): Boolean {
    val caps = runCatching {
      AudioCapabilities.getCapabilities(context, STREAM_AUDIO_ATTRIBUTES, null, emptyList())
    }.getOrDefault(AudioCapabilities.DEFAULT_AUDIO_CAPABILITIES)
    return when (mimeType) {
      MimeTypes.AUDIO_DTS_HD -> caps.supportsEncoding(C.ENCODING_DTS_HD)
      else -> caps.supportsEncoding(C.ENCODING_DTS) || caps.supportsEncoding(C.ENCODING_DTS_HD)
    }
  }
}

@OptIn(UnstableApi::class)
internal fun createRenderersFactory(
  context: Context,
  codecPolicy: CodecPolicy,
  softwareAudio: Boolean,
): DefaultRenderersFactory {
  FfmpegAudio.ensureConfigured()
  return DefaultRenderersFactory(context)
    .setEnableDecoderFallback(true)
    .setExtensionRendererMode(extensionRendererModeFor(softwareAudio))
    .setMediaCodecSelector(codecPolicy.createSelector(context, softwareAudio))
}

@OptIn(UnstableApi::class)
internal fun createRenderersFactory(context: Context, softwareAudio: Boolean): DefaultRenderersFactory =
  createRenderersFactory(context, CodecPolicy(), softwareAudio)

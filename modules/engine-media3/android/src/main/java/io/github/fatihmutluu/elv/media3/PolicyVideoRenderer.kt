package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.os.Handler
import androidx.annotation.OptIn
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.video.MediaCodecVideoRenderer
import androidx.media3.exoplayer.video.VideoRendererEventListener
import java.util.Locale

private const val AMLOGIC_MIN_MAX_WIDTH = 1920
private const val AMLOGIC_MIN_MAX_HEIGHT = 1089
private const val BRAVIA_DROP_LATE_THRESHOLD_US = -60_000L
private const val BRAVIA_DROP_TO_KEYFRAME_THRESHOLD_US = -1_000_000L
private const val BRAVIA_MAX_CONSECUTIVE_DROPS = 2

@OptIn(UnstableApi::class)
private fun isCodecFormatSupportedSafely(context: Context, info: MediaCodecInfo, format: Format): Boolean =
  runCatching { info.capabilities != null && info.isFormatSupported(context, format) }.getOrDefault(false)

private fun amlogicMinInputSize(mimeType: String?, width: Int, height: Int): Int {
  val macroblocks = ((width + 15) / 16) * ((height + 15) / 16)
  val pixels = macroblocks * 16 * 16
  val compressionRatio = when (mimeType) {
    MimeTypes.VIDEO_H265, MimeTypes.VIDEO_VP9, MimeTypes.VIDEO_AV1, MimeTypes.VIDEO_DOLBY_VISION -> 4
    else -> 2
  }
  return (pixels * 3) / (2 * compressionRatio)
}

private fun isBrokenOutputSurfaceCodec(name: String, deviceQuirks: DeviceQuirks): Boolean {
  val lower = name.lowercase(Locale.ROOT)
  if (isSoftwareDecoderName(lower)) return false
  if (lower.startsWith("omx.allwinner.") || lower.startsWith("omx.rk.video_decoder.") || lower.startsWith("omx.realtek.")) {
    return true
  }
  return deviceQuirks.isAmlogic && lower.startsWith("omx.amlogic.") && lower.endsWith(".awesome")
}

/**
 * Video renderer enforcing (#184, #189, #261, #411):
 * - Manual [VideoDecoderMode] enforcement (`HARDWARE`, `SOFTWARE`, or `AUTO` format-aware hardware-first filtering).
 * - Proactive Dolby Vision Profile 7 -> HEVC base-layer fallback.
 * - Amlogic `CodecMaxValues` `>= 1920x1089` floor for adaptive 720p -> 1080p transitions.
 * - Sony Bravia bounded consecutive frame-drop mitigation and output-surface workarounds.
 */
@OptIn(UnstableApi::class)
internal class PolicyVideoRenderer(
  builder: Builder,
  private val appContext: Context,
  private val codecPolicy: CodecPolicy,
  private val softwareAudio: Boolean,
  private val preferHevcOverDolbyVision: Boolean,
  private val deviceQuirks: DeviceQuirks = DeviceQuirks.fromBuild(),
  private val formatSupportChecker: (MediaCodecInfo, Format) -> Boolean = { info, fmt ->
    isCodecFormatSupportedSafely(appContext, info, fmt)
  },
  private val decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
) : MediaCodecVideoRenderer(builder) {
  private var consecutiveBraviaDrops = 0

  internal val decoderModeForTest: VideoDecoderMode
    get() = decoderMode

  override fun getDecoderInfos(
    mediaCodecSelector: MediaCodecSelector,
    format: Format,
    requiresSecureDecoder: Boolean,
  ): List<MediaCodecInfo> {
    val candidates = resolveInitialDecoderInfos(mediaCodecSelector, format, requiresSecureDecoder)
    return when (decoderMode) {
      VideoDecoderMode.HARDWARE ->
        candidates
          .filter { !isSoftwareVideoCodec(it) }
          .sortedBy { info -> if (codecPolicy.isRepeatedlyFailing(info)) 1 else 0 }

      VideoDecoderMode.SOFTWARE -> {
        val softwareOnly = candidates.filter { isSoftwareVideoCodec(it) }
        if (softwareOnly.isNotEmpty()) softwareOnly else candidates
      }

      VideoDecoderMode.AUTO -> {
        if (candidates.size <= 1 || softwareAudio) return candidates
        val confirmedHardware = candidates.filter { info ->
          !isSoftwareVideoCodec(info) &&
            !codecPolicy.isRepeatedlyFailing(info) &&
            formatSupportChecker(info, format)
        }
        if (confirmedHardware.isNotEmpty()) confirmedHardware else candidates
      }
    }
  }

  private fun resolveInitialDecoderInfos(
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

  override fun getCodecMaxValues(
    codecInfo: MediaCodecInfo,
    format: Format,
    streamFormats: Array<Format>,
  ): CodecMaxValues {
    val base = super.getCodecMaxValues(codecInfo, format, streamFormats)
    if (!deviceQuirks.isAmlogic && !isAmlogicCodec(codecInfo.name)) return base
    val width = maxOf(base.width, AMLOGIC_MIN_MAX_WIDTH)
    val height = maxOf(base.height, AMLOGIC_MIN_MAX_HEIGHT)
    val minInput = amlogicMinInputSize(format.sampleMimeType, width, height)
    val inputSize = if (base.inputSize == Format.NO_VALUE) minInput else maxOf(base.inputSize, minInput)
    return CodecMaxValues(width, height, inputSize)
  }

  override fun shouldDropOutputBuffer(
    earlyUs: Long,
    elapsedRealtimeUs: Long,
    isLastBuffer: Boolean,
  ): Boolean {
    if (!deviceQuirks.isSonyBravia) {
      return super.shouldDropOutputBuffer(earlyUs, elapsedRealtimeUs, isLastBuffer)
    }
    if (isLastBuffer || earlyUs >= BRAVIA_DROP_LATE_THRESHOLD_US) {
      consecutiveBraviaDrops = 0
      return false
    }
    if (consecutiveBraviaDrops >= BRAVIA_MAX_CONSECUTIVE_DROPS) {
      consecutiveBraviaDrops = 0
      return false
    }
    consecutiveBraviaDrops += 1
    return true
  }

  override fun shouldDropBuffersToKeyframe(
    earlyUs: Long,
    elapsedRealtimeUs: Long,
    isLastBuffer: Boolean,
  ): Boolean {
    if (!deviceQuirks.isSonyBravia) {
      return super.shouldDropBuffersToKeyframe(earlyUs, elapsedRealtimeUs, isLastBuffer)
    }
    return !isLastBuffer && earlyUs < BRAVIA_DROP_TO_KEYFRAME_THRESHOLD_US
  }

  override fun codecNeedsSetOutputSurfaceWorkaround(name: String): Boolean =
    if (isSoftwareDecoderName(name)) {
      false
    } else {
      super.codecNeedsSetOutputSurfaceWorkaround(name) || isBrokenOutputSurfaceCodec(name, deviceQuirks)
    }

  override fun onPositionReset(positionUs: Long, joining: Boolean, sampleStreamIsResetToKeyFrame: Boolean) {
    consecutiveBraviaDrops = 0
    super.onPositionReset(positionUs, joining, sampleStreamIsResetToKeyFrame)
  }

  override fun onDisabled() {
    consecutiveBraviaDrops = 0
    super.onDisabled()
  }

  internal fun resolveDecoderInfosForTest(
    mediaCodecSelector: MediaCodecSelector,
    format: Format,
    requiresSecureDecoder: Boolean = false,
  ): List<MediaCodecInfo> = getDecoderInfos(mediaCodecSelector, format, requiresSecureDecoder)

  internal data class CodecMaxValuesSnapshot(val width: Int, val height: Int, val inputSize: Int)

  internal fun resolveCodecMaxValuesForTest(
    codecInfo: MediaCodecInfo,
    format: Format,
    streamFormats: Array<Format> = arrayOf(format),
  ): CodecMaxValuesSnapshot {
    val max = getCodecMaxValues(codecInfo, format, streamFormats)
    return CodecMaxValuesSnapshot(max.width, max.height, max.inputSize)
  }

  internal fun shouldDropOutputBufferForTest(
    earlyUs: Long,
    elapsedRealtimeUs: Long,
    isLastBuffer: Boolean = false,
  ): Boolean = shouldDropOutputBuffer(earlyUs, elapsedRealtimeUs, isLastBuffer)

  internal fun shouldDropBuffersToKeyframeForTest(
    earlyUs: Long,
    elapsedRealtimeUs: Long,
    isLastBuffer: Boolean = false,
  ): Boolean = shouldDropBuffersToKeyframe(earlyUs, elapsedRealtimeUs, isLastBuffer)

  internal fun codecNeedsSetOutputSurfaceWorkaroundForTest(name: String): Boolean =
    codecNeedsSetOutputSurfaceWorkaround(name)
}

@OptIn(UnstableApi::class)
internal fun createRenderersFactory(
  context: Context,
  codecPolicy: CodecPolicy,
  softwareAudio: Boolean,
  preferHevcOverDolbyVision: Boolean = false,
  deviceQuirks: DeviceQuirks = DeviceQuirks.fromBuild(),
  decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
): DefaultRenderersFactory {
  FfmpegAudio.ensureConfigured()
  val appContext = context.applicationContext ?: context
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
      out.add(
        PolicyVideoRenderer(
          builder = builder,
          appContext = appContext,
          codecPolicy = codecPolicy,
          softwareAudio = softwareAudio,
          preferHevcOverDolbyVision = preferHevcOverDolbyVision,
          deviceQuirks = deviceQuirks,
          decoderMode = decoderMode,
        )
      )
    }
  }
    .setEnableDecoderFallback(true)
    .setExtensionRendererMode(extensionRendererModeFor(softwareAudio, decoderMode))
    .setMediaCodecSelector(
      codecPolicy.createSelector(
        context = context,
        softwareAudio = softwareAudio,
        preferHevcOverDolbyVision = preferHevcOverDolbyVision,
        stripHeavySoftwareWithoutFormatCheck = false,
        decoderMode = decoderMode,
      )
    )
}

@OptIn(UnstableApi::class)
internal fun createRenderersFactory(context: Context, softwareAudio: Boolean): DefaultRenderersFactory =
  createRenderersFactory(context, CodecPolicy(), softwareAudio)

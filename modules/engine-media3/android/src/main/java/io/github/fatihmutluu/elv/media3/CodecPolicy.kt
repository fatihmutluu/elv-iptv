package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.media.MediaCodecInfo.CodecProfileLevel
import android.media.MediaCodecList
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioCapabilities
import androidx.media3.exoplayer.audio.AudioCapabilitiesReceiver
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

private const val REPEATED_FAILURE_THRESHOLD = 2
private const val UHD_WIDTH = 3840
private const val UHD_HEIGHT = 2160

private val AMLOGIC_SUBSTRING_TOKENS = listOf("amlogic", "meson", "s905", "s912", "s922", "g12a", "g12b")
private val AMLOGIC_EXACT_BOARD_TOKENS = setOf("sabrina", "gxl", "gxm", "sm1", "sc2")

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

/** Injectable Android build/SoC fingerprint driving deterministic video renderer quirks (#261). */
internal data class DeviceQuirks(
  val manufacturer: String,
  val brand: String,
  val model: String,
  val hardware: String,
  val board: String,
  val socModel: String,
) {
  val isAmlogic: Boolean
    get() {
      val fields = listOf(hardware, board, socModel, model, manufacturer, brand)
        .map { it.trim().lowercase(Locale.ROOT) }
        .filter { it.isNotEmpty() }
      return fields.any { field ->
        AMLOGIC_SUBSTRING_TOKENS.any { token -> field.contains(token) } || field in AMLOGIC_EXACT_BOARD_TOKENS
      }
    }

  val isSonyBravia: Boolean
    get() {
      val mfg = manufacturer.lowercase(Locale.ROOT)
      val br = brand.lowercase(Locale.ROOT)
      val mdl = model.lowercase(Locale.ROOT)
      val brd = board.lowercase(Locale.ROOT)
      val isSony = mfg.contains("sony") || br.contains("sony")
      val isBraviaModel = mdl.contains("bravia") ||
        brd.contains("bravia") ||
        mdl.startsWith("kd-") ||
        mdl.startsWith("xr-") ||
        mdl.startsWith("xbr-") ||
        mdl.startsWith("kdl-")
      return isSony && isBraviaModel
    }

  companion object {
    fun fromBuild(): DeviceQuirks = DeviceQuirks(
      manufacturer = Build.MANUFACTURER.orEmpty(),
      brand = Build.BRAND.orEmpty(),
      model = Build.MODEL.orEmpty(),
      hardware = Build.HARDWARE.orEmpty(),
      board = Build.BOARD.orEmpty(),
      socModel = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) Build.SOC_MODEL.orEmpty() else "",
    )
  }
}

/** Pure snapshot of a platform `MediaCodecInfo` entry for unit-testing the 4K HEVC hardware probe (#150). */
internal data class HevcCodecProbeEntry(
  val name: String,
  val isEncoder: Boolean,
  val isHardwareAccelerated: Boolean,
  val isSoftwareOnly: Boolean,
  val supportedTypes: List<String>,
  val supports4k: Boolean,
)

/** True when [name] matches a known Android platform software decoder (`omx.google.*`, `c2.android.*`, `c2.google.*`). */
internal fun isSoftwareDecoderName(name: String): Boolean {
  val lower = name.lowercase(Locale.ROOT)
  return lower.startsWith("omx.google.") || lower.startsWith("c2.android.") || lower.startsWith("c2.google.")
}

/** True when [name] is an Amlogic hardware MediaCodec name (`omx.amlogic.*` / `c2.amlogic.*`). */
internal fun isAmlogicCodec(name: String): Boolean {
  val lower = name.lowercase(Locale.ROOT)
  return lower.startsWith("omx.amlogic.") || lower.startsWith("c2.amlogic.") || lower.contains(".amlogic.")
}

/** True when at least one non-encoder hardware-accelerated HEVC decoder supports 3840x2160 (#150). */
internal fun probeHardwareHevc4kFromEntries(entries: List<HevcCodecProbeEntry>): Boolean =
  entries.any { entry ->
    !entry.isEncoder &&
      entry.isHardwareAccelerated &&
      !entry.isSoftwareOnly &&
      !isSoftwareDecoderName(entry.name) &&
      entry.supportedTypes.any { it.equals(MimeTypes.VIDEO_H265, ignoreCase = true) } &&
      entry.supports4k
  }

private fun probeHardwareHevc4kFromPlatformCodecs(codecs: Array<android.media.MediaCodecInfo>): Boolean {
  val entries = codecs.map { info ->
    val types = runCatching { info.supportedTypes.toList() }.getOrDefault(emptyList())
    val hasHevc = types.any { it.equals(MimeTypes.VIDEO_H265, ignoreCase = true) }
    val supports4k = if (!info.isEncoder && hasHevc) {
      runCatching {
        info.getCapabilitiesForType(MimeTypes.VIDEO_H265)
          ?.videoCapabilities
          ?.isSizeSupported(UHD_WIDTH, UHD_HEIGHT) == true
      }.getOrDefault(false)
    } else {
      false
    }
    val hwAccelerated = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      info.isHardwareAccelerated && !info.isSoftwareOnly
    } else {
      !isSoftwareDecoderName(info.name)
    }
    val swOnly = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      info.isSoftwareOnly || isSoftwareDecoderName(info.name)
    } else {
      isSoftwareDecoderName(info.name)
    }
    HevcCodecProbeEntry(
      name = info.name.orEmpty(),
      isEncoder = info.isEncoder,
      isHardwareAccelerated = hwAccelerated,
      isSoftwareOnly = swOnly,
      supportedTypes = types,
      supports4k = supports4k,
    )
  }
  return probeHardwareHevc4kFromEntries(entries)
}

@OptIn(UnstableApi::class)
internal fun extensionRendererModeFor(
  softwareAudio: Boolean,
  decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
): Int =
  if (softwareAudio || decoderMode == VideoDecoderMode.SOFTWARE) {
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
 * Per-engine decoder selection policy (#109, #128, #150, #184, #189, #261, #312, #331, #411):
 * - Enforces manual [VideoDecoderMode] (`HARDWARE` hardware-only, `SOFTWARE` immediate software preference, or `AUTO`
 *   hardware-first with automatic software fallback after repeated hardware failures).
 * - Probes hardware 4K HEVC decoding asynchronously off the UI thread.
 * - Falls back from `VIDEO_DOLBY_VISION` to HEVC (`VIDEO_H265`) base-layer decoders when requested, unsupported, or
 *   after a prior DV decoder failure.
 * - Filters silent stub platform DTS `MediaCodec`s when FFmpeg JNI supports DTS and HDMI passthrough is absent.
 */
@OptIn(UnstableApi::class)
internal class CodecPolicy {
  private val videoFailures = ConcurrentHashMap<String, Int>()
  private val dolbyVisionFallback = AtomicBoolean(false)
  private val hevc4kProbeStarted = AtomicBoolean(false)
  @Volatile private var cachedAudioCapabilities: AudioCapabilities? = null
  private val capabilitiesLock = Any()
  private var audioCapabilitiesReceiver: AudioCapabilitiesReceiver? = null
  private var audioCapabilitiesStarted = false
  private var audioCapabilitiesEpoch = 0

  @Volatile
  var supportsHardwareHevc4k: Boolean = false
    private set

  val isDolbyVisionFallbackActive: Boolean
    get() = dolbyVisionFallback.get()

  /** Probes `MediaCodecList` for hardware 3840x2160 HEVC support asynchronously on [handler] (#150); idempotent. */
  fun startHardwareHevc4kProbe(handler: Handler) {
    if (!hevc4kProbeStarted.compareAndSet(false, true)) return
    val posted = handler.post {
      supportsHardwareHevc4k = runCatching {
        probeHardwareHevc4kFromPlatformCodecs(MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos)
      }.getOrDefault(false)
    }
    if (!posted) hevc4kProbeStarted.set(false)
  }

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

  internal fun isRepeatedlyFailing(codecInfo: MediaCodecInfo): Boolean =
    !codecInfo.softwareOnly && (videoFailures[codecInfo.name] ?: 0) >= REPEATED_FAILURE_THRESHOLD

  fun selectDecoders(
    mimeType: String,
    decoders: List<MediaCodecInfo>,
    softwareAudio: Boolean,
    ffmpegSupportsMime: Boolean,
    hasDtsPassthrough: Boolean,
    preferHevcOverDolbyVision: Boolean = false,
    hevcFallbackDecoders: List<MediaCodecInfo> = emptyList(),
    stripHeavySoftwareWithoutFormatCheck: Boolean = true,
    decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
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
        stripHeavySoftwareWithoutFormatCheck = stripHeavySoftwareWithoutFormatCheck,
        decoderMode = decoderMode,
      )
    }
    if (MimeTypes.isVideo(mimeType)) {
      return when (decoderMode) {
        VideoDecoderMode.HARDWARE ->
          decoders
            .filter { !isSoftwareVideoCodec(it) }
            .sortedBy { info -> if (isRepeatedlyFailing(info)) 1 else 0 }

        VideoDecoderMode.SOFTWARE -> {
          val softwareOnly = decoders.filter { isSoftwareVideoCodec(it) }
          if (softwareOnly.isNotEmpty()) {
            softwareOnly
          } else {
            decoders.sortedBy { info -> if (isRepeatedlyFailing(info)) 1 else 0 }
          }
        }

        VideoDecoderMode.AUTO -> {
          val ordered = decoders.sortedBy { info ->
            when {
              isRepeatedlyFailing(info) -> 2
              isSoftwareVideoCodec(info) -> 1
              else -> 0
            }
          }
          val anyRepeatedFailure = decoders.any { isRepeatedlyFailing(it) }
          if (stripHeavySoftwareWithoutFormatCheck && mimeType in HEAVY_VIDEO_MIMES && !softwareAudio && !anyRepeatedFailure) {
            val hardwareOnly = ordered.filter { !isSoftwareVideoCodec(it) }
            if (hardwareOnly.isNotEmpty()) return hardwareOnly
          }
          ordered
        }
      }
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
    stripHeavySoftwareWithoutFormatCheck: Boolean = true,
    baseSelector: MediaCodecSelector = MediaCodecSelector.DEFAULT,
    decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
  ): MediaCodecSelector =
    MediaCodecSelector { mimeType, secure, tunneling ->
      val decoders = baseSelector.getDecoderInfos(mimeType, secure, tunneling)
      val hevcFallback =
        if (mimeType == MimeTypes.VIDEO_DOLBY_VISION) {
          baseSelector.getDecoderInfos(MimeTypes.VIDEO_H265, secure, tunneling)
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
        stripHeavySoftwareWithoutFormatCheck = stripHeavySoftwareWithoutFormatCheck,
        decoderMode = decoderMode,
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

@OptIn(UnstableApi::class)
internal fun isSoftwareVideoCodec(info: MediaCodecInfo): Boolean =
  info.softwareOnly || isSoftwareDecoderName(info.name)

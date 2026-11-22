package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import java.util.Locale
import kotlin.math.roundToLong

/** Decoded video stream metadata emitted via `mediaInfo` engine events (#58). */
internal data class VideoInfoSnapshot(
  val width: Int? = null,
  val height: Int? = null,
  val fps: Double? = null,
  val codec: String? = null,
  val hdr: String? = null,
) {
  val isEmpty: Boolean
    get() = width == null && height == null && fps == null && codec == null && hdr == null

  fun toMap(): Map<String, Any> = buildMap {
    if (width != null) put("width", width)
    if (height != null) put("height", height)
    if (fps != null) put("fps", fps)
    if (codec != null) put("codec", codec)
    if (hdr != null) put("hdr", hdr)
  }
}

/** Normalizes a Media3 video MIME type and optional RFC 6381 codecs string to a short codec identifier. */
internal fun normalizeVideoCodec(sampleMimeType: String?, codecs: String? = null): String? {
  val mime = sampleMimeType?.trim()?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() }
  val codecTag = codecs?.trim()?.lowercase(Locale.ROOT)
  return when (mime) {
    MimeTypes.VIDEO_H265 -> "hevc"
    MimeTypes.VIDEO_H264 -> "h264"
    MimeTypes.VIDEO_AV1 -> "av1"
    MimeTypes.VIDEO_VP9 -> "vp9"
    MimeTypes.VIDEO_VP8 -> "vp8"
    MimeTypes.VIDEO_MPEG2 -> "mpeg2"
    MimeTypes.VIDEO_MP4V -> "mpeg4"
    MimeTypes.VIDEO_VC1 -> "vc1"
    MimeTypes.VIDEO_DOLBY_VISION -> when {
      codecTag == null -> "dolby-vision"
      codecTag.startsWith("dvhe") || codecTag.startsWith("dvh1") -> "hevc"
      codecTag.startsWith("dav1") -> "av1"
      codecTag.startsWith("dvav") || codecTag.startsWith("dva1") -> "h264"
      else -> "dolby-vision"
    }
    null -> null
    else -> mime.removePrefix("video/").takeIf { it.isNotEmpty() }
  }
}

/** Classifies HDR transfer from Media3 MIME type and `ColorInfo.colorTransfer`. */
@OptIn(UnstableApi::class)
internal fun classifyVideoHdr(sampleMimeType: String?, colorTransfer: Int?): String = when {
  sampleMimeType.equals(MimeTypes.VIDEO_DOLBY_VISION, ignoreCase = true) -> "dv"
  colorTransfer == C.COLOR_TRANSFER_ST2084 -> "hdr10"
  colorTransfer == C.COLOR_TRANSFER_HLG -> "hlg"
  else -> "sdr"
}

/** Finds the currently selected video track's [Format], if any. */
@OptIn(UnstableApi::class)
internal fun extractSelectedVideoFormat(tracks: Tracks): Format? {
  for (group in tracks.groups) {
    if (group.type != C.TRACK_TYPE_VIDEO || !group.isSelected) continue
    for (i in 0 until group.length) {
      if (group.isTrackSelected(i)) return group.getTrackFormat(i)
    }
  }
  return null
}

/** Derives a [VideoInfoSnapshot] from active Media3 video [format] and decoded [videoSize]. */
@OptIn(UnstableApi::class)
internal fun deriveVideoInfo(format: Format?, videoSize: VideoSize?): VideoInfoSnapshot? {
  val width = videoSize?.width?.takeIf { it > 0 }
    ?: format?.width?.takeIf { it != Format.NO_VALUE && it > 0 }
  val height = videoSize?.height?.takeIf { it > 0 }
    ?: format?.height?.takeIf { it != Format.NO_VALUE && it > 0 }
  val fps = format?.frameRate
    ?.takeIf { it != Format.NO_VALUE.toFloat() && it.isFinite() && it > 0f }
    ?.let { (it.toDouble() * 100.0).roundToLong() / 100.0 }
  val codec = normalizeVideoCodec(format?.sampleMimeType, format?.codecs)
  val hdr = if (format != null || (width != null && height != null)) {
    classifyVideoHdr(format?.sampleMimeType, format?.colorInfo?.colorTransfer)
  } else {
    null
  }
  val snapshot = VideoInfoSnapshot(width = width, height = height, fps = fps, codec = codec, hdr = hdr)
  return snapshot.takeUnless { it.isEmpty }
}

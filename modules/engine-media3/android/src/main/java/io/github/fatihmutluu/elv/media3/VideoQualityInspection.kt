package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import java.util.Locale
import kotlin.math.roundToInt

/** Snapshot of one selectable adaptive video rendition exposed to JavaScript (`#59`). */
internal data class VideoQualitySnapshot(
  val id: String,
  val label: String,
  val width: Int? = null,
  val height: Int? = null,
  val bitrateBps: Int? = null,
  val fps: Double? = null,
  val programId: String? = null,
) {
  fun toMap(): Map<String, Any> = buildMap {
    put("id", id)
    put("label", label)
    if (width != null) put("width", width)
    if (height != null) put("height", height)
    if (bitrateBps != null) put("bitrateBps", bitrateBps)
    if (fps != null) put("fps", fps)
    if (programId != null) put("programId", programId)
  }
}

/** Internal candidate pairing a Media3 [Tracks.Group] rendition with its [VideoQualitySnapshot]. */
internal data class VideoQualityCandidate(
  val group: Tracks.Group,
  val trackIndex: Int,
  val option: VideoQualitySnapshot,
)

/** Saved user video quality selection used to reconcile across reloads/re-prepares. */
internal data class VideoQualityChoice(
  val id: String,
  val width: Int?,
  val height: Int?,
  val bitrateBps: Int?,
)

private fun formatBitrateLabel(bitrateBps: Int): String =
  if (bitrateBps >= 1_000_000) {
    String.format(Locale.US, "%.1f Mbps", bitrateBps / 1_000_000.0)
  } else {
    "${(bitrateBps / 1_000).coerceAtLeast(1)} kbps"
  }

/**
 * Extracts supported adaptive `C.TRACK_TYPE_VIDEO` renditions from [tracks], deduplicated by
 * `(height, width, bitrateBps)` and sorted descending by height then bitrate (`#59`).
 *
 * Returns an empty list when fewer than 2 distinct selectable renditions exist (non-adaptive streams).
 */
@OptIn(UnstableApi::class)
internal fun videoQualityCandidatesOf(
  tracks: Tracks,
  includeProgramId: Boolean = false,
): List<VideoQualityCandidate> {
  data class DedupKey(
    val programId: String?,
    val height: Int?,
    val width: Int?,
    val bitrateBps: Int?,
  )

  data class RawCandidate(
    val group: Tracks.Group,
    val trackIndex: Int,
    val id: String,
    val width: Int?,
    val height: Int?,
    val bitrateBps: Int?,
    val fps: Double?,
    val baseLabel: String,
    val programId: String?,
  )

  val seenKeys = mutableSetOf<DedupKey>()
  val raw = mutableListOf<RawCandidate>()

  tracks.groups.forEachIndexed { groupIndex, group ->
    if (group.type != C.TRACK_TYPE_VIDEO) return@forEachIndexed
    for (trackIndex in 0 until group.length) {
      if (!group.isTrackSupported(trackIndex)) continue
      val format = group.getTrackFormat(trackIndex)
      val width = format.width.takeIf { it != Format.NO_VALUE && it > 0 }
      val height = format.height.takeIf { it != Format.NO_VALUE && it > 0 }
      val bitrateBps = format.bitrate.takeIf { it != Format.NO_VALUE && it > 0 }
      if (height == null && bitrateBps == null) continue
      val programId = if (includeProgramId) extractTrackProgramId(group, trackIndex) else null
      val key = DedupKey(programId, height, width, bitrateBps)
      if (!seenKeys.add(key)) continue
      val fps = format.frameRate
        .takeIf { it != Format.NO_VALUE.toFloat() && it.isFinite() && it > 0f }
        ?.let { (it.toDouble() * 100.0).roundToInt() / 100.0 }
      val baseLabel = when {
        height != null -> "${height}p"
        bitrateBps != null -> formatBitrateLabel(bitrateBps)
        else -> format.label?.trim()?.takeIf { it.isNotEmpty() } ?: "Video ${trackIndex + 1}"
      }
      raw += RawCandidate(
        group = group,
        trackIndex = trackIndex,
        id = "$groupIndex:$trackIndex",
        width = width,
        height = height,
        bitrateBps = bitrateBps,
        fps = fps,
        baseLabel = baseLabel,
        programId = programId,
      )
    }
  }

  if (raw.size <= 1) return emptyList()

  val labelCounts = raw.groupingBy { it.baseLabel }.eachCount()
  return raw
    .sortedWith(
      compareByDescending<RawCandidate> { it.height ?: 0 }
        .thenByDescending { it.bitrateBps ?: 0 }
        .thenByDescending { it.width ?: 0 }
        .thenByDescending { it.fps ?: 0.0 }
        .thenBy { it.id }
    )
    .map { item ->
      val label = if ((labelCounts[item.baseLabel] ?: 0) > 1 && item.height != null && item.bitrateBps != null) {
        "${item.baseLabel} (${formatBitrateLabel(item.bitrateBps)})"
      } else {
        item.baseLabel
      }
      VideoQualityCandidate(
        group = item.group,
        trackIndex = item.trackIndex,
        option = VideoQualitySnapshot(
          id = item.id,
          label = label,
          width = item.width,
          height = item.height,
          bitrateBps = item.bitrateBps,
          fps = item.fps,
          programId = item.programId,
        ),
      )
    }
}

/** Resolves a saved [VideoQualityChoice] against current adaptive candidates (exact ID, then resolution/bitrate fallback). */
internal fun resolveVideoQualityCandidate(
  candidates: List<VideoQualityCandidate>,
  wanted: VideoQualityChoice,
): VideoQualityCandidate? {
  candidates.firstOrNull { it.option.id == wanted.id }?.let { return it }
  if (wanted.height != null) {
    candidates.firstOrNull {
      it.option.height == wanted.height && it.option.width == wanted.width && it.option.bitrateBps == wanted.bitrateBps
    }?.let { return it }
    candidates.firstOrNull { it.option.height == wanted.height }?.let { return it }
  }
  if (wanted.bitrateBps != null) {
    candidates.firstOrNull { it.option.bitrateBps == wanted.bitrateBps }?.let { return it }
  }
  return null
}

package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi

private val NUMERIC_SLASH_PROGRAM_RE = Regex("^(\\d+)/(.+)$")
private val NUMERIC_COLON_PROGRAM_RE = Regex("^(\\d+):(.+)$")
private val NAMED_PROGRAM_RE = Regex("^(?:program|prog|service)[-_:/]?(\\d+)(?:[/:_-].*)?$", RegexOption.IGNORE_CASE)

/** Snapshot of one selectable service/program inside a multi-program MPEG-TS transport stream (#304). */
internal data class ProgramInfoSnapshot(
  val id: String,
  val label: String,
  val serviceName: String? = null,
  val programNumber: Int? = null,
) {
  fun toMap(): Map<String, Any> = buildMap {
    put("id", id)
    put("label", label)
    if (serviceName != null) put("serviceName", serviceName)
    if (programNumber != null) put("programNumber", programNumber)
  }
}

/** Result of inspecting multi-program MPEG-TS service metadata across a Media3 [Tracks] snapshot (#304). */
internal data class ProgramInspectionResult(
  val programs: List<ProgramInfoSnapshot>,
  val selectedProgramId: String?,
) {
  val isMultiProgram: Boolean
    get() = programs.size > 1
}

/**
 * Extracts a numeric MPEG-TS program number from a Media3 track's `Format.id` (e.g. `"1/256"` or `"101:512"`)
 * or fallback `mediaTrackGroup.id` (e.g. `"program-1"`, `"1/video"`). Returns `null` for external sidecar
 * subtitles (`ext:...`) and regular single-program tracks.
 */
internal fun extractTrackProgramNumber(formatId: String?, groupId: String?): Int? {
  val cleanFormatId = formatId?.trim()?.takeIf { it.isNotEmpty() }
  if (cleanFormatId != null && cleanFormatId.startsWith(EXTERNAL_SUBTITLE_ID_PREFIX)) return null

  if (cleanFormatId != null) {
    NUMERIC_SLASH_PROGRAM_RE.matchEntire(cleanFormatId)?.groupValues?.get(1)?.toIntOrNull()?.let { return it }
    NUMERIC_COLON_PROGRAM_RE.matchEntire(cleanFormatId)?.groupValues?.get(1)?.toIntOrNull()?.let { return it }
    NAMED_PROGRAM_RE.matchEntire(cleanFormatId)?.groupValues?.get(1)?.toIntOrNull()?.let { return it }
  }

  val cleanGroupId = groupId?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  NUMERIC_SLASH_PROGRAM_RE.matchEntire(cleanGroupId)?.groupValues?.get(1)?.toIntOrNull()?.let { return it }
  // Require >= 1 for colon-prefixed group IDs so MergingMediaSource primary index "0:..." never triggers false positives.
  NUMERIC_COLON_PROGRAM_RE.matchEntire(cleanGroupId)?.groupValues?.get(1)?.toIntOrNull()
    ?.takeIf { it >= 1 }
    ?.let { return it }
  NAMED_PROGRAM_RE.matchEntire(cleanGroupId)?.groupValues?.get(1)?.toIntOrNull()?.let { return it }
  return null
}

/** Convenience wrapper returning the canonical string program ID (`programNumber.toString()`) for a track. */
@OptIn(UnstableApi::class)
internal fun extractTrackProgramId(group: Tracks.Group, trackIndex: Int): String? {
  val format = group.getTrackFormat(trackIndex)
  return extractTrackProgramNumber(format.id, group.mediaTrackGroup.id)?.toString()
}

/**
 * Inspects selectable video, audio, and embedded text tracks in [tracks] to discover multi-program MPEG-TS
 * services (#304). When `<= 1` distinct program exists, returns empty `programs` and `selectedProgramId = null`.
 */
@OptIn(UnstableApi::class)
internal fun inspectPrograms(
  tracks: Tracks,
  activeProgramId: String? = null,
  ffmpegSupportsAudio: (String?) -> Boolean = ::defaultFfmpegSupportsAudio,
): ProgramInspectionResult {
  val programNumbers = linkedSetOf<Int>()
  var selectedVideoProgram: String? = null
  var selectedAudioProgram: String? = null
  var selectedTextProgram: String? = null

  for (group in tracks.groups) {
    val type = group.type
    if (type != C.TRACK_TYPE_VIDEO && type != C.TRACK_TYPE_AUDIO && type != C.TRACK_TYPE_TEXT) continue
    for (trackIndex in 0 until group.length) {
      val selectable = when (type) {
        C.TRACK_TYPE_VIDEO -> group.isTrackSupported(trackIndex)
        else -> isSelectableTrack(group, trackIndex, ffmpegSupportsAudio)
      }
      if (!selectable) continue
      val programNumber = extractTrackProgramNumber(
        formatId = group.getTrackFormat(trackIndex).id,
        groupId = group.mediaTrackGroup.id,
      ) ?: continue
      programNumbers += programNumber
      if (group.isTrackSelected(trackIndex)) {
        val pid = programNumber.toString()
        when (type) {
          C.TRACK_TYPE_VIDEO -> if (selectedVideoProgram == null) selectedVideoProgram = pid
          C.TRACK_TYPE_AUDIO -> if (selectedAudioProgram == null) selectedAudioProgram = pid
          C.TRACK_TYPE_TEXT -> if (selectedTextProgram == null) selectedTextProgram = pid
        }
      }
    }
  }

  if (programNumbers.size <= 1) {
    return ProgramInspectionResult(programs = emptyList(), selectedProgramId = null)
  }

  val programs = programNumbers.sorted().map { num ->
    ProgramInfoSnapshot(
      id = num.toString(),
      label = "Program $num",
      programNumber = num,
    )
  }
  val validIds = programs.mapTo(HashSet(programs.size)) { it.id }
  val resolvedSelectedId = when {
    activeProgramId != null && activeProgramId in validIds -> activeProgramId
    selectedVideoProgram != null && selectedVideoProgram in validIds -> selectedVideoProgram
    selectedAudioProgram != null && selectedAudioProgram in validIds -> selectedAudioProgram
    selectedTextProgram != null && selectedTextProgram in validIds -> selectedTextProgram
    else -> programs.first().id
  }
  return ProgramInspectionResult(programs = programs, selectedProgramId = resolvedSelectedId)
}

/** Returns [TrackSelectionOverride]s covering all supported video tracks that belong to [programId]. */
@OptIn(UnstableApi::class)
internal fun videoGroupOverridesForProgram(
  tracks: Tracks,
  programId: String,
): List<TrackSelectionOverride> {
  val overrides = mutableListOf<TrackSelectionOverride>()
  for (group in tracks.groups) {
    if (group.type != C.TRACK_TYPE_VIDEO) continue
    val matchingIndices = mutableListOf<Int>()
    for (trackIndex in 0 until group.length) {
      if (!group.isTrackSupported(trackIndex)) continue
      if (extractTrackProgramId(group, trackIndex) == programId) {
        matchingIndices += trackIndex
      }
    }
    if (matchingIndices.isNotEmpty()) {
      overrides += TrackSelectionOverride(group.mediaTrackGroup, matchingIndices)
    }
  }
  return overrides
}

/** True when at least one currently selected video track in [tracks] belongs to [programId]. */
@OptIn(UnstableApi::class)
internal fun isSelectedVideoInProgram(tracks: Tracks, programId: String): Boolean {
  for (group in tracks.groups) {
    if (group.type != C.TRACK_TYPE_VIDEO) continue
    for (trackIndex in 0 until group.length) {
      if (group.isTrackSelected(trackIndex) && extractTrackProgramId(group, trackIndex) == programId) {
        return true
      }
    }
  }
  return false
}

/** True when at least one currently selected audio track in [tracks] belongs to [programId]. */
@OptIn(UnstableApi::class)
internal fun isSelectedAudioInProgram(tracks: Tracks, programId: String): Boolean {
  for (group in tracks.groups) {
    if (group.type != C.TRACK_TYPE_AUDIO) continue
    for (trackIndex in 0 until group.length) {
      if (group.isTrackSelected(trackIndex) && extractTrackProgramId(group, trackIndex) == programId) {
        return true
      }
    }
  }
  return false
}

/** Picks the best selectable audio candidate belonging to [programId] (preferred language -> default -> first). */
@OptIn(UnstableApi::class)
internal fun selectBestAudioForProgram(
  tracks: Tracks,
  programId: String,
  preferredLanguage: String?,
  ffmpegSupportsAudio: (String?) -> Boolean = ::defaultFfmpegSupportsAudio,
): TrackCandidate? {
  val inProgram = candidatesOf(tracks, C.TRACK_TYPE_AUDIO, ffmpegSupportsAudio, includeProgramId = true)
    .filter { it.info.programId == programId }
  if (inProgram.isEmpty()) return null
  if (preferredLanguage != null) {
    inProgram.firstOrNull { sameLanguage(it.info.language, preferredLanguage) }?.let { return it }
  }
  return inProgram.firstOrNull { it.info.isDefault } ?: inProgram.first()
}

/** Picks an embedded text track in [programId] matching [preferredLanguage], or `null` if none matches. */
@OptIn(UnstableApi::class)
internal fun selectBestTextForProgram(
  tracks: Tracks,
  programId: String,
  preferredLanguage: String?,
  ffmpegSupportsAudio: (String?) -> Boolean = ::defaultFfmpegSupportsAudio,
): TrackCandidate? {
  if (preferredLanguage == null) return null
  val inProgram = candidatesOf(tracks, C.TRACK_TYPE_TEXT, ffmpegSupportsAudio, includeProgramId = true)
    .filter { !it.info.external && it.info.programId == programId }
  return inProgram.firstOrNull { sameLanguage(it.info.language, preferredLanguage) }
}

package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import java.util.Locale

private val UNDETERMINED_LANGS = setOf("und", "zxx", "mul", "mis", "unknown")

private val AMBIGUOUS_TWO_LETTER = setOf("no", "is", "it", "hi", "id", "my", "he")
private val LABEL_SPLIT_REGEX = Regex("[\\s\\[\\](){},.;:/|\\\\+]+")
private val BCP47_TOKEN_REGEX = Regex("^([a-z]{2,3})[-_]([a-z]{2}|[a-z]{4}|\\d{3})(?:[-_][a-z0-9]{2,8})*$")
private val SHORT_ALPHA_REGEX = Regex("^[a-z]{2,3}$")

private val ISO_639_2_TO_1 = mapOf(
  "alb" to "sq", "sqi" to "sq",
  "ara" to "ar",
  "arm" to "hy", "hye" to "hy",
  "aze" to "az",
  "baq" to "eu", "eus" to "eu",
  "ben" to "bn",
  "bod" to "bo", "tib" to "bo",
  "bos" to "bs",
  "bul" to "bg",
  "bur" to "my", "mya" to "my",
  "cat" to "ca",
  "ces" to "cs", "cze" to "cs",
  "chi" to "zh", "zho" to "zh",
  "cym" to "cy", "wel" to "cy",
  "dan" to "da",
  "deu" to "de", "ger" to "de",
  "dut" to "nl", "nld" to "nl",
  "ell" to "el", "gre" to "el",
  "eng" to "en",
  "fas" to "fa", "per" to "fa",
  "fin" to "fi",
  "fra" to "fr", "fre" to "fr",
  "geo" to "ka", "kat" to "ka",
  "glg" to "gl",
  "heb" to "he",
  "hin" to "hi",
  "hrv" to "hr",
  "hun" to "hu",
  "ice" to "is", "isl" to "is",
  "ind" to "id",
  "ita" to "it",
  "jpn" to "ja",
  "kor" to "ko",
  "kur" to "ku",
  "mac" to "mk", "mkd" to "mk",
  "mao" to "mi", "mri" to "mi",
  "may" to "ms", "msa" to "ms",
  "nno" to "nn",
  "nob" to "nb",
  "nor" to "no",
  "pol" to "pl",
  "por" to "pt",
  "ron" to "ro", "rum" to "ro",
  "rus" to "ru",
  "slk" to "sk", "slo" to "sk",
  "slv" to "sl",
  "spa" to "es",
  "srp" to "sr",
  "swe" to "sv",
  "tam" to "ta",
  "tel" to "te",
  "tha" to "th",
  "tur" to "tr",
  "ukr" to "uk",
  "urd" to "ur",
  "vie" to "vi",
)

private val KNOWN_ISO_639_1 = ISO_639_2_TO_1.values.toSet()

private val LANGUAGE_LABEL_NAMES = mapOf(
  "english" to "en",
  "turkish" to "tr", "türkçe" to "tr", "turkce" to "tr",
  "german" to "de", "deutsch" to "de",
  "french" to "fr", "français" to "fr", "francais" to "fr",
  "spanish" to "es", "español" to "es", "espanol" to "es", "castellano" to "es",
  "arabic" to "ar",
  "russian" to "ru",
  "italian" to "it", "italiano" to "it",
  "portuguese" to "pt", "português" to "pt", "portugues" to "pt",
  "dutch" to "nl", "nederlands" to "nl",
  "polish" to "pl", "polski" to "pl",
  "chinese" to "zh", "mandarin" to "zh", "cantonese" to "zh",
  "japanese" to "ja",
  "korean" to "ko",
  "persian" to "fa", "farsi" to "fa",
  "greek" to "el",
  "czech" to "cs",
  "romanian" to "ro",
  "swedish" to "sv",
  "ukrainian" to "uk",
  "kurdish" to "ku",
  "azerbaijani" to "az",
  "bulgarian" to "bg",
  "bosnian" to "bs",
  "danish" to "da",
  "finnish" to "fi",
  "hebrew" to "he",
  "hindi" to "hi",
  "croatian" to "hr",
  "hungarian" to "hu",
  "indonesian" to "id",
  "malay" to "ms",
  "norwegian" to "no",
  "slovak" to "sk",
  "slovenian" to "sl",
  "serbian" to "sr",
  "thai" to "th",
  "vietnamese" to "vi",
  "albanian" to "sq",
  "macedonian" to "mk",
  "georgian" to "ka",
  "armenian" to "hy",
  "icelandic" to "is",
  "welsh" to "cy",
  "basque" to "eu",
  "tibetan" to "bo",
  "burmese" to "my",
  "maori" to "mi",
  "bengali" to "bn",
  "catalan" to "ca",
  "galician" to "gl",
  "tamil" to "ta",
  "telugu" to "te",
  "urdu" to "ur",
)

/** Snapshot of one selectable audio or subtitle track in [Tracks]. */
internal data class TrackInfoSnapshot(
  val id: String,
  val language: String? = null,
  val label: String? = null,
  val codec: String? = null,
  val channels: Int? = null,
  val forced: Boolean = false,
  val isDefault: Boolean = false,
  val formatId: String? = null,
  val external: Boolean = false,
  val programId: String? = null,
) {
  fun toMap(): Map<String, Any> = buildMap {
    put("id", id)
    if (language != null) put("language", language)
    if (label != null) put("label", label)
    if (codec != null) put("codec", codec)
    if (channels != null) put("channels", channels)
    if (forced) put("forced", true)
    if (isDefault) put("isDefault", true)
    if (external) put("external", true)
    if (programId != null) put("programId", programId)
  }
}

/** Snapshot of all supported audio, text, and adaptive video tracks and active selections. */
internal data class MediaTracksSnapshot(
  val audio: List<TrackInfoSnapshot>,
  val subtitles: List<TrackInfoSnapshot>,
  val selectedAudioId: String?,
  val selectedSubtitleId: String?,
  val selectedSecondarySubtitleId: String? = null,
  val videoQualities: List<VideoQualitySnapshot> = emptyList(),
  val selectedVideoQualityId: String? = null,
  val programs: List<ProgramInfoSnapshot> = emptyList(),
  val selectedProgramId: String? = null,
) {
  fun toMap(): Map<String, Any?> = buildMap {
    put("audio", audio.map { it.toMap() })
    put("subtitles", subtitles.map { it.toMap() })
    put("selectedAudioId", selectedAudioId)
    put("selectedSubtitleId", selectedSubtitleId)
    put("selectedSecondarySubtitleId", selectedSecondarySubtitleId)
    if (videoQualities.isNotEmpty()) {
      put("videoQualities", videoQualities.map { it.toMap() })
      put("selectedVideoQualityId", selectedVideoQualityId)
    }
    if (programs.size > 1) {
      put("programs", programs.map { it.toMap() })
      put("selectedProgramId", selectedProgramId)
    }
  }
}

internal data class TrackChoice(
  val id: String,
  val language: String?,
  val label: String?,
  val formatId: String? = null,
  val codec: String? = null,
  val channels: Int? = null,
)

internal data class TrackCandidate(
  val group: Tracks.Group,
  val trackIndex: Int,
  val info: TrackInfoSnapshot,
)

@OptIn(UnstableApi::class)
internal fun canonicalLanguageKey(raw: String?): String? {
  val cleaned = raw?.trim()?.replace('_', '-')?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: return null
  val primary = cleaned.substringBefore('-')
  if (primary.isEmpty() || primary in UNDETERMINED_LANGS) return null
  ISO_639_2_TO_1[primary]?.let { return it }
  val normalized = Util.normalizeLanguageCode(primary)?.lowercase(Locale.ROOT)?.substringBefore('-') ?: primary
  if (normalized.isEmpty() || normalized in UNDETERMINED_LANGS) return null
  return ISO_639_2_TO_1[normalized] ?: normalized
}

@OptIn(UnstableApi::class)
internal fun normalizeLang(raw: String?): String? {
  val trimmed = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val primaryKey = canonicalLanguageKey(trimmed) ?: return null
  val normalized = Util.normalizeLanguageCode(trimmed)?.takeIf { it.isNotEmpty() } ?: return primaryKey
  return if ('-' in normalized) {
    "$primaryKey-${normalized.substringAfter('-')}"
  } else {
    ISO_639_2_TO_1[normalized.lowercase(Locale.ROOT)] ?: primaryKey
  }
}

/** True when [a] and [b] share the same canonical ISO 639-1 / 639-2(T+B) / BCP-47 primary language subtag. */
internal fun sameLanguage(a: String?, b: String?): Boolean {
  val keyA = canonicalLanguageKey(a) ?: return false
  val keyB = canonicalLanguageKey(b) ?: return false
  return keyA == keyB
}

/**
 * Extracts a canonical ISO 639-1 code from a free-text track label using whole-word token matching only
 * (never substring matching, so `"es"` never matches `"Chinese"` or `"Japanese"`).
 */
internal fun extractLanguageFromLabel(label: String?): String? {
  val trimmed = label?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  val tokens = trimmed.split(LABEL_SPLIT_REGEX).filter { it.isNotEmpty() && it != "-" && it != "_" }
  if (tokens.isEmpty()) return null

  for (token in tokens) {
    LANGUAGE_LABEL_NAMES[token.lowercase(Locale.ROOT)]?.let { return it }
  }

  for (token in tokens) {
    val lower = token.lowercase(Locale.ROOT)
    val bcp = BCP47_TOKEN_REGEX.matchEntire(lower)
    if (bcp != null) {
      val primary = bcp.groupValues[1]
      val subtag = bcp.groupValues[2]
      if (!(primary == "hi" && subtag == "fi")) {
        val canonical = ISO_639_2_TO_1[primary] ?: primary.takeIf { it in KNOWN_ISO_639_1 }
        if (canonical != null) return canonical
      }
      continue
    }
    if (!SHORT_ALPHA_REGEX.matches(lower) || lower in UNDETERMINED_LANGS) continue
    val canonical = ISO_639_2_TO_1[lower] ?: lower.takeIf { it in KNOWN_ISO_639_1 } ?: continue
    if (lower.length == 3 || tokens.size == 1 || lower !in AMBIGUOUS_TWO_LETTER) {
      return canonical
    }
  }
  return null
}

/** Default FFmpeg software-audio probe used to expose decodable `FORMAT_EXCEEDS_CAPABILITIES` audio tracks (#438). */
internal fun defaultFfmpegSupportsAudio(mimeType: String?): Boolean =
  mimeType != null && runCatching { FfmpegAudio.supportsMimeType(mimeType) }.getOrDefault(false)

/** Includes supported tracks plus `FORMAT_EXCEEDS_CAPABILITIES` audio that is selected or FFmpeg-decodable (#438). */
@OptIn(UnstableApi::class)
internal fun isSelectableTrack(
  group: Tracks.Group,
  trackIndex: Int,
  ffmpegSupportsAudio: (String?) -> Boolean = ::defaultFfmpegSupportsAudio,
): Boolean =
  group.isTrackSupported(trackIndex) ||
    (group.type == C.TRACK_TYPE_AUDIO &&
      group.isTrackSupported(trackIndex, /* allowExceedsCapabilities = */ true) &&
      (group.isTrackSelected(trackIndex) || ffmpegSupportsAudio(group.getTrackFormat(trackIndex).sampleMimeType)))

@OptIn(UnstableApi::class)
private fun snapshotOf(
  group: Tracks.Group,
  groupIndex: Int,
  trackIndex: Int,
  includeProgramId: Boolean = false,
): TrackInfoSnapshot {
  val format = group.getTrackFormat(trackIndex)
  val label = format.label?.trim()?.takeIf { it.isNotEmpty() }
  val language = normalizeLang(format.language) ?: extractLanguageFromLabel(label)
  val codec =
    format.codecs?.trim()?.takeIf { it.isNotEmpty() }
      ?: format.sampleMimeType?.trim()?.takeIf { it.isNotEmpty() }
  val channels =
    if (group.type == C.TRACK_TYPE_AUDIO && format.channelCount != Format.NO_VALUE && format.channelCount > 0) {
      format.channelCount
    } else {
      null
    }
  val cleanFormatId = format.id?.trim()?.takeIf { it.isNotEmpty() }
  val isExternalText = group.type == C.TRACK_TYPE_TEXT && cleanFormatId?.startsWith(EXTERNAL_SUBTITLE_ID_PREFIX) == true
  val stableId = if (isExternalText) cleanFormatId!! else "$groupIndex:$trackIndex"
  val programId = if (includeProgramId && !isExternalText) extractTrackProgramId(group, trackIndex) else null
  return TrackInfoSnapshot(
    id = stableId,
    language = language,
    label = label,
    codec = codec,
    channels = channels,
    forced = (format.selectionFlags and C.SELECTION_FLAG_FORCED) != 0,
    isDefault = (format.selectionFlags and C.SELECTION_FLAG_DEFAULT) != 0,
    formatId = cleanFormatId,
    external = isExternalText,
    programId = programId,
  )
}

/**
 * Inspects [tracks] and maps selectable `C.TRACK_TYPE_AUDIO` and `C.TRACK_TYPE_TEXT` entries to stable
 * `"$groupIndex:$trackIndex"` IDs (or `"ext:<id>"` for external sidecars). When [textDisabled] is true,
 * `selectedSubtitleId` is always `null` unless [selectedExternalPrimaryId] is active.
 */
@OptIn(UnstableApi::class)
internal fun inspectMediaTracks(
  tracks: Tracks,
  textDisabled: Boolean,
  selectedVideoQualityId: String? = null,
  ffmpegSupportsAudio: (String?) -> Boolean = ::defaultFfmpegSupportsAudio,
  selectedSecondarySubtitleId: String? = null,
  extraExternalSubtitles: List<TrackInfoSnapshot> = emptyList(),
  selectedExternalPrimaryId: String? = null,
  preferredPrimarySubtitleId: String? = null,
  activeProgramId: String? = null,
): MediaTracksSnapshot {
  val programInspection = inspectPrograms(tracks, activeProgramId = activeProgramId, ffmpegSupportsAudio = ffmpegSupportsAudio)
  val includeProgramId = programInspection.isMultiProgram
  val audio = mutableListOf<TrackInfoSnapshot>()
  val subtitles = mutableListOf<TrackInfoSnapshot>()
  val seenSubtitleIds = HashSet<String>()
  val selectedTextIds = mutableListOf<String>()
  var selectedAudioId: String? = null

  tracks.groups.forEachIndexed { groupIndex, group ->
    if (group.type != C.TRACK_TYPE_AUDIO && group.type != C.TRACK_TYPE_TEXT) return@forEachIndexed
    for (trackIndex in 0 until group.length) {
      if (!isSelectableTrack(group, trackIndex, ffmpegSupportsAudio)) continue
      val info = snapshotOf(group, groupIndex, trackIndex, includeProgramId = includeProgramId)
      if (group.type == C.TRACK_TYPE_AUDIO) {
        audio += info
        if (selectedAudioId == null && group.isTrackSelected(trackIndex)) selectedAudioId = info.id
      } else {
        if (seenSubtitleIds.add(info.id)) subtitles += info
        if (!textDisabled && group.isTrackSelected(trackIndex)) {
          selectedTextIds += info.id
        }
      }
    }
  }

  for (ext in extraExternalSubtitles) {
    if (seenSubtitleIds.add(ext.id)) {
      subtitles += ext
    }
  }

  val cleanSecondaryId = selectedSecondarySubtitleId?.takeIf { it.isNotEmpty() }
  val selectedSubtitleId = when {
    textDisabled -> null
    preferredPrimarySubtitleId != null &&
      preferredPrimarySubtitleId != cleanSecondaryId &&
      preferredPrimarySubtitleId in selectedTextIds -> preferredPrimarySubtitleId
    else -> selectedTextIds.firstOrNull { it != cleanSecondaryId }
  }

  val resolvedPrimaryId = when {
    selectedExternalPrimaryId != null && seenSubtitleIds.contains(selectedExternalPrimaryId) -> selectedExternalPrimaryId
    textDisabled -> null
    else -> selectedSubtitleId
  }
  val resolvedSecondaryId =
    cleanSecondaryId
      ?.takeIf { it != resolvedPrimaryId && seenSubtitleIds.contains(it) }

  val videoQualities = videoQualityCandidatesOf(tracks, includeProgramId = includeProgramId).map { it.option }
  val confirmedVideoQualityId = selectedVideoQualityId?.takeIf { wanted ->
    videoQualities.any { it.id == wanted }
  }

  return MediaTracksSnapshot(
    audio = audio,
    subtitles = subtitles,
    selectedAudioId = selectedAudioId,
    selectedSubtitleId = resolvedPrimaryId,
    selectedSecondarySubtitleId = resolvedSecondaryId,
    videoQualities = videoQualities,
    selectedVideoQualityId = if (videoQualities.isEmpty()) null else confirmedVideoQualityId,
    programs = programInspection.programs,
    selectedProgramId = programInspection.selectedProgramId,
  )
}

@OptIn(UnstableApi::class)
internal fun candidatesOf(
  tracks: Tracks,
  trackType: Int,
  ffmpegSupportsAudio: (String?) -> Boolean = ::defaultFfmpegSupportsAudio,
  includeProgramId: Boolean = false,
): List<TrackCandidate> {
  val result = mutableListOf<TrackCandidate>()
  tracks.groups.forEachIndexed { groupIndex, group ->
    if (group.type != trackType) return@forEachIndexed
    for (trackIndex in 0 until group.length) {
      if (!isSelectableTrack(group, trackIndex, ffmpegSupportsAudio)) continue
      result += TrackCandidate(
        group = group,
        trackIndex = trackIndex,
        info = snapshotOf(group, groupIndex, trackIndex, includeProgramId = includeProgramId),
      )
    }
  }
  return result
}

internal fun findCandidateById(
  tracks: Tracks,
  trackType: Int,
  id: String,
  ffmpegSupportsAudio: (String?) -> Boolean = ::defaultFfmpegSupportsAudio,
): TrackCandidate? =
  candidatesOf(tracks, trackType, ffmpegSupportsAudio).firstOrNull { it.info.id == id }

internal fun resolveCandidate(
  tracks: Tracks,
  trackType: Int,
  wanted: TrackChoice,
  ffmpegSupportsAudio: (String?) -> Boolean = ::defaultFfmpegSupportsAudio,
): TrackCandidate? {
  val candidates = candidatesOf(tracks, trackType, ffmpegSupportsAudio)
  val exact = candidates.firstOrNull { it.info.id == wanted.id }
  if (wanted.language == null && wanted.label == null) {
    if (wanted.formatId != null) {
      if (exact != null && exact.info.formatId == wanted.formatId) return exact
      candidates.firstOrNull { it.info.formatId == wanted.formatId }?.let { return it }
    }
    if (wanted.codec != null) {
      if (exact != null && exact.info.codec == wanted.codec && exact.info.channels == wanted.channels) return exact
      candidates.firstOrNull { it.info.codec == wanted.codec && it.info.channels == wanted.channels }?.let { return it }
    }
    return exact
  }
  if (exact != null) {
    val langOk = wanted.language == null || sameLanguage(exact.info.language, wanted.language)
    val labelOk =
      wanted.label == null ||
        exact.info.label == wanted.label ||
        (exact.info.label == null && candidates.none { it.info.label == wanted.label })
    if (langOk && labelOk) return exact
  }
  if (wanted.language != null && wanted.label != null) {
    candidates.firstOrNull {
      sameLanguage(it.info.language, wanted.language) && it.info.label == wanted.label
    }?.let { return it }
  }
  if (wanted.language != null) {
    candidates.firstOrNull { sameLanguage(it.info.language, wanted.language) }?.let { return it }
  }
  if (wanted.label != null) {
    candidates.firstOrNull { it.info.label == wanted.label }?.let { return it }
  }
  return exact
}

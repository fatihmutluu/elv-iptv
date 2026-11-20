package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util

private val UNDETERMINED_LANGS = setOf("und", "zxx", "mul", "mis", "unknown")

private val ISO_639_2_TO_1 = mapOf(
  "alb" to "sq", "sqi" to "sq",
  "ara" to "ar",
  "arm" to "hy", "hye" to "hy",
  "aze" to "az",
  "baq" to "eu", "eus" to "eu",
  "ben" to "bn",
  "bos" to "bs",
  "bul" to "bg",
  "cat" to "ca",
  "ces" to "cs", "cze" to "cs",
  "chi" to "zh", "zho" to "zh",
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
  "ind" to "id",
  "ita" to "it",
  "jpn" to "ja",
  "kor" to "ko",
  "kur" to "ku",
  "mac" to "mk", "mkd" to "mk",
  "may" to "ms", "msa" to "ms",
  "nob" to "no", "nno" to "no", "nor" to "no",
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

/** Snapshot of one selectable audio or subtitle track in [Tracks]. */
internal data class TrackInfoSnapshot(
  val id: String,
  val language: String? = null,
  val label: String? = null,
  val codec: String? = null,
  val channels: Int? = null,
  val forced: Boolean = false,
  val isDefault: Boolean = false,
) {
  fun toMap(): Map<String, Any> = buildMap {
    put("id", id)
    if (language != null) put("language", language)
    if (label != null) put("label", label)
    if (codec != null) put("codec", codec)
    if (channels != null) put("channels", channels)
    if (forced) put("forced", true)
    if (isDefault) put("isDefault", true)
  }
}

/** Snapshot of all supported audio and text tracks and active selections. */
internal data class MediaTracksSnapshot(
  val audio: List<TrackInfoSnapshot>,
  val subtitles: List<TrackInfoSnapshot>,
  val selectedAudioId: String?,
  val selectedSubtitleId: String?,
) {
  fun toMap(): Map<String, Any?> = mapOf(
    "audio" to audio.map { it.toMap() },
    "subtitles" to subtitles.map { it.toMap() },
    "selectedAudioId" to selectedAudioId,
    "selectedSubtitleId" to selectedSubtitleId,
  )
}

internal data class TrackChoice(
  val id: String,
  val language: String?,
  val label: String?,
)

internal data class TrackCandidate(
  val group: Tracks.Group,
  val trackIndex: Int,
  val info: TrackInfoSnapshot,
)

@OptIn(UnstableApi::class)
internal fun canonicalLanguageKey(raw: String?): String? {
  val cleaned = raw?.trim()?.replace('_', '-')?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
  val primary = cleaned.substringBefore('-')
  if (primary.isEmpty() || primary in UNDETERMINED_LANGS) return null
  ISO_639_2_TO_1[primary]?.let { return it }
  val normalized = Util.normalizeLanguageCode(primary)?.lowercase()?.substringBefore('-') ?: primary
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
    ISO_639_2_TO_1[normalized.lowercase()] ?: primaryKey
  }
}

/** True when [a] and [b] share the same canonical ISO 639-1 / 639-2(T+B) / BCP-47 primary language subtag. */
internal fun sameLanguage(a: String?, b: String?): Boolean {
  val keyA = canonicalLanguageKey(a) ?: return false
  val keyB = canonicalLanguageKey(b) ?: return false
  return keyA == keyB
}

/** Includes supported tracks plus actively selected `FORMAT_EXCEEDS_CAPABILITIES` audio tracks. */
@OptIn(UnstableApi::class)
internal fun isSelectableTrack(group: Tracks.Group, trackIndex: Int): Boolean =
  group.isTrackSupported(trackIndex) ||
    (group.type == C.TRACK_TYPE_AUDIO &&
      group.isTrackSelected(trackIndex) &&
      group.isTrackSupported(trackIndex, /* allowExceedsCapabilities = */ true))

/**
 * Inspects [tracks] and maps selectable `C.TRACK_TYPE_AUDIO` and `C.TRACK_TYPE_TEXT` entries to stable
 * `"$groupIndex:$trackIndex"` IDs. When [textDisabled] is true, `selectedSubtitleId` is always `null`.
 */
@OptIn(UnstableApi::class)
internal fun inspectMediaTracks(tracks: Tracks, textDisabled: Boolean): MediaTracksSnapshot {
  val audio = mutableListOf<TrackInfoSnapshot>()
  val subtitles = mutableListOf<TrackInfoSnapshot>()
  var selectedAudioId: String? = null
  var selectedSubtitleId: String? = null

  tracks.groups.forEachIndexed { groupIndex, group ->
    if (group.type != C.TRACK_TYPE_AUDIO && group.type != C.TRACK_TYPE_TEXT) return@forEachIndexed
    for (trackIndex in 0 until group.length) {
      if (!isSelectableTrack(group, trackIndex)) continue
      val id = "$groupIndex:$trackIndex"
      val format = group.getTrackFormat(trackIndex)
      val language = normalizeLang(format.language)
      val label = format.label?.trim()?.takeIf { it.isNotEmpty() }
      val codec =
        format.codecs?.trim()?.takeIf { it.isNotEmpty() }
          ?: format.sampleMimeType?.trim()?.takeIf { it.isNotEmpty() }
      val channels =
        if (group.type == C.TRACK_TYPE_AUDIO && format.channelCount != Format.NO_VALUE && format.channelCount > 0) {
          format.channelCount
        } else {
          null
        }
      val info = TrackInfoSnapshot(
        id = id,
        language = language,
        label = label,
        codec = codec,
        channels = channels,
        forced = (format.selectionFlags and C.SELECTION_FLAG_FORCED) != 0,
        isDefault = (format.selectionFlags and C.SELECTION_FLAG_DEFAULT) != 0,
      )
      if (group.type == C.TRACK_TYPE_AUDIO) {
        audio += info
        if (selectedAudioId == null && group.isTrackSelected(trackIndex)) selectedAudioId = id
      } else {
        subtitles += info
        if (!textDisabled && selectedSubtitleId == null && group.isTrackSelected(trackIndex)) {
          selectedSubtitleId = id
        }
      }
    }
  }

  return MediaTracksSnapshot(
    audio = audio,
    subtitles = subtitles,
    selectedAudioId = selectedAudioId,
    selectedSubtitleId = if (textDisabled) null else selectedSubtitleId,
  )
}

@OptIn(UnstableApi::class)
internal fun candidatesOf(tracks: Tracks, trackType: Int): List<TrackCandidate> {
  val result = mutableListOf<TrackCandidate>()
  tracks.groups.forEachIndexed { groupIndex, group ->
    if (group.type != trackType) return@forEachIndexed
    for (trackIndex in 0 until group.length) {
      if (!isSelectableTrack(group, trackIndex)) continue
      val format = group.getTrackFormat(trackIndex)
      val info = TrackInfoSnapshot(
        id = "$groupIndex:$trackIndex",
        language = normalizeLang(format.language),
        label = format.label?.trim()?.takeIf { it.isNotEmpty() },
      )
      result += TrackCandidate(group = group, trackIndex = trackIndex, info = info)
    }
  }
  return result
}

internal fun findCandidateById(tracks: Tracks, trackType: Int, id: String): TrackCandidate? =
  candidatesOf(tracks, trackType).firstOrNull { it.info.id == id }

internal fun resolveCandidate(tracks: Tracks, trackType: Int, wanted: TrackChoice): TrackCandidate? {
  val candidates = candidatesOf(tracks, trackType)
  val exact = candidates.firstOrNull { it.info.id == wanted.id }
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

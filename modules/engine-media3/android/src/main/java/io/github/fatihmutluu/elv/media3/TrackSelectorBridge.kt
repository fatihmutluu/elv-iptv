package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import androidx.media3.exoplayer.ExoPlayer

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

@OptIn(UnstableApi::class)
private fun normalizeLang(raw: String?): String? {
  val trimmed = raw?.trim()?.takeIf { it.isNotEmpty() && !it.equals("und", ignoreCase = true) } ?: return null
  return Util.normalizeLanguageCode(trimmed)?.takeIf { it.isNotEmpty() && !it.equals("und", ignoreCase = true) }
}

/**
 * Inspects [tracks] and maps supported `C.TRACK_TYPE_AUDIO` and `C.TRACK_TYPE_TEXT` entries to stable
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
      if (!group.isTrackSupported(trackIndex)) continue
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

/**
 * Playback-thread bridge between `Player.Listener.onTracksChanged` / `TrackSelectionParameters` and the `@elv/playback`
 * track selection contract. Remembers user choices across recovery reloads (`load` with `LoadOptions`, `retry`,
 * `recreate`, HLS re-prepare), matching exact `"$groupIndex:$trackIndex"` IDs first and `(language, label)` /
 * `language` fallback when reloaded groups shift order.
 */
@OptIn(UnstableApi::class)
internal class TrackSelectorBridge(
  private val onTracks: (Map<String, Any?>) -> Unit,
  private val onClearCues: () -> Unit,
) {
  private data class TrackChoice(
    val id: String,
    val language: String?,
    val label: String?,
  )

  private sealed interface SubChoice {
    data object Default : SubChoice
    data object Off : SubChoice
    data class Selected(val choice: TrackChoice) : SubChoice
  }

  private data class Candidate(
    val group: Tracks.Group,
    val trackIndex: Int,
    val info: TrackInfoSnapshot,
  )

  private var audioChoice: TrackChoice? = null
  private var subtitleChoice: SubChoice = SubChoice.Default
  private var latestTracks: Tracks = Tracks.EMPTY
  private var lastEmitted: MediaTracksSnapshot? = null

  /** Whether `C.TRACK_TYPE_TEXT` is currently disabled by user choice (`subtitleTrackId === null`). */
  val isTextDisabled: Boolean
    get() = subtitleChoice is SubChoice.Off

  /** Updates desired track preferences from a new [LoadRequest], preserving cached language/label when reloading. */
  fun onLoad(request: LoadRequest) {
    latestTracks = Tracks.EMPTY
    lastEmitted = null
    audioChoice = request.audioTrackId?.let { wantedId ->
      audioChoice?.takeIf { it.id == wantedId } ?: TrackChoice(id = wantedId, language = null, label = null)
    }
    subtitleChoice = when (val pref = request.subtitlePreference) {
      SubtitlePreference.Default -> SubChoice.Default
      SubtitlePreference.Off -> SubChoice.Off
      is SubtitlePreference.Selected -> {
        val current = (subtitleChoice as? SubChoice.Selected)?.choice
        SubChoice.Selected(
          current?.takeIf { it.id == pref.id } ?: TrackChoice(id = pref.id, language = null, label = null)
        )
      }
    }
  }

  /** Resets per-prepare track cache while preserving active track choices across `retry`, `recreate` or HLS re-prepare. */
  fun onPrepareReuse() {
    latestTracks = Tracks.EMPTY
    lastEmitted = null
  }

  /** Clears all track choices and cached tracks on `stop` or `dispose`. */
  fun onStop() {
    audioChoice = null
    subtitleChoice = SubChoice.Default
    latestTracks = Tracks.EMPTY
    lastEmitted = null
  }

  /** Resets stale overrides from any prior media and applies initial track parameters before `player.prepare()`. */
  fun applyInitialParameters(player: ExoPlayer) {
    val builder = player.trackSelectionParameters.buildUpon()
      .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
      .clearOverridesOfType(C.TRACK_TYPE_TEXT)
      .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
      .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, subtitleChoice is SubChoice.Off)
      .setPreferredAudioLanguage(audioChoice?.language)
      .setPreferredTextLanguage((subtitleChoice as? SubChoice.Selected)?.choice?.language)
    player.trackSelectionParameters = builder.build()
  }

  /** Selects audio track [id] in place without restarting playback. */
  fun selectAudioTrack(player: ExoPlayer?, id: String) {
    val tracks = activeTracks(player)
    val matched = findById(tracks, C.TRACK_TYPE_AUDIO, id)
    audioChoice = TrackChoice(
      id = id,
      language = matched?.info?.language,
      label = matched?.info?.label,
    )
    if (player != null) {
      val builder = player.trackSelectionParameters.buildUpon()
        .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
        .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
      if (matched != null) {
        builder.addOverride(TrackSelectionOverride(matched.group.mediaTrackGroup, listOf(matched.trackIndex)))
        if (matched.info.language != null) builder.setPreferredAudioLanguage(matched.info.language)
      }
      player.trackSelectionParameters = builder.build()
    }
  }

  /** Selects subtitle track [id] in place, or disables `C.TRACK_TYPE_TEXT` and clears cues when [id] is `null`. */
  fun selectSubtitleTrack(player: ExoPlayer?, id: String?) {
    onClearCues()
    if (id == null) {
      subtitleChoice = SubChoice.Off
      if (player != null) {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
          .clearOverridesOfType(C.TRACK_TYPE_TEXT)
          .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
          .setPreferredTextLanguage(null)
          .build()
      }
      if (!latestTracks.isEmpty) {
        emitIfChanged(inspectMediaTracks(latestTracks, textDisabled = true))
      }
      return
    }

    val tracks = activeTracks(player)
    val matched = findById(tracks, C.TRACK_TYPE_TEXT, id)
    subtitleChoice = SubChoice.Selected(
      TrackChoice(
        id = id,
        language = matched?.info?.language,
        label = matched?.info?.label,
      )
    )
    if (player != null) {
      val builder = player.trackSelectionParameters.buildUpon()
        .clearOverridesOfType(C.TRACK_TYPE_TEXT)
        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
      if (matched != null) {
        builder.addOverride(TrackSelectionOverride(matched.group.mediaTrackGroup, listOf(matched.trackIndex)))
        if (matched.info.language != null) builder.setPreferredTextLanguage(matched.info.language)
      }
      player.trackSelectionParameters = builder.build()
    }
  }

  /** Handles Media3 `onTracksChanged`: reconciles saved track choices and emits deduplicated `MediaTracks`. */
  fun onTracksChanged(player: ExoPlayer, tracks: Tracks) {
    latestTracks = tracks
    val params = player.trackSelectionParameters
    val builder = params.buildUpon()
    var changedParams = false
    var overriddenAudioId: String? = null
    var overriddenSubtitleId: String? = null

    audioChoice?.let { wanted ->
      val target = resolveCandidate(tracks, C.TRACK_TYPE_AUDIO, wanted)
      if (target != null) {
        audioChoice = TrackChoice(target.info.id, target.info.language, target.info.label)
        overriddenAudioId = target.info.id
        val currentOverride = params.overrides[target.group.mediaTrackGroup]?.trackIndices
        if (currentOverride != listOf(target.trackIndex) || params.disabledTrackTypes.contains(C.TRACK_TYPE_AUDIO)) {
          builder.clearOverridesOfType(C.TRACK_TYPE_AUDIO)
            .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
            .addOverride(TrackSelectionOverride(target.group.mediaTrackGroup, listOf(target.trackIndex)))
          changedParams = true
        }
      }
    }

    when (val wantedSub = subtitleChoice) {
      SubChoice.Off -> {
        if (!params.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) {
          builder.clearOverridesOfType(C.TRACK_TYPE_TEXT)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .setPreferredTextLanguage(null)
          changedParams = true
        }
      }
      is SubChoice.Selected -> {
        val target = resolveCandidate(tracks, C.TRACK_TYPE_TEXT, wantedSub.choice)
        if (target != null) {
          subtitleChoice = SubChoice.Selected(TrackChoice(target.info.id, target.info.language, target.info.label))
          overriddenSubtitleId = target.info.id
          val currentOverride = params.overrides[target.group.mediaTrackGroup]?.trackIndices
          if (currentOverride != listOf(target.trackIndex) || params.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) {
            builder.clearOverridesOfType(C.TRACK_TYPE_TEXT)
              .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
              .addOverride(TrackSelectionOverride(target.group.mediaTrackGroup, listOf(target.trackIndex)))
            changedParams = true
          }
        }
      }
      SubChoice.Default -> Unit
    }

    if (changedParams) {
      player.trackSelectionParameters = builder.build()
    }

    val textDisabled =
      subtitleChoice is SubChoice.Off ||
        player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)
    val inspected = inspectMediaTracks(tracks, textDisabled = textDisabled)
    val effective = inspected.copy(
      selectedAudioId = overriddenAudioId ?: inspected.selectedAudioId,
      selectedSubtitleId = if (textDisabled) null else (overriddenSubtitleId ?: inspected.selectedSubtitleId),
    )
    emitIfChanged(effective)
  }

  private fun emitIfChanged(snapshot: MediaTracksSnapshot) {
    if (snapshot == lastEmitted) return
    lastEmitted = snapshot
    onTracks(snapshot.toMap())
  }

  private fun activeTracks(player: ExoPlayer?): Tracks =
    if (!latestTracks.isEmpty) latestTracks else (player?.currentTracks ?: Tracks.EMPTY)

  private fun candidatesOf(tracks: Tracks, trackType: Int): List<Candidate> {
    val result = mutableListOf<Candidate>()
    tracks.groups.forEachIndexed { groupIndex, group ->
      if (group.type != trackType) return@forEachIndexed
      for (trackIndex in 0 until group.length) {
        if (!group.isTrackSupported(trackIndex)) continue
        val format = group.getTrackFormat(trackIndex)
        val info = TrackInfoSnapshot(
          id = "$groupIndex:$trackIndex",
          language = normalizeLang(format.language),
          label = format.label?.trim()?.takeIf { it.isNotEmpty() },
        )
        result += Candidate(group = group, trackIndex = trackIndex, info = info)
      }
    }
    return result
  }

  private fun findById(tracks: Tracks, trackType: Int, id: String): Candidate? =
    candidatesOf(tracks, trackType).firstOrNull { it.info.id == id }

  private fun resolveCandidate(tracks: Tracks, trackType: Int, wanted: TrackChoice): Candidate? {
    val candidates = candidatesOf(tracks, trackType)
    val exact = candidates.firstOrNull { it.info.id == wanted.id }
    if (exact != null && (wanted.language == null || exact.info.language == wanted.language)) {
      return exact
    }
    if (wanted.language != null && wanted.label != null) {
      candidates.firstOrNull { it.info.language == wanted.language && it.info.label == wanted.label }?.let { return it }
    }
    if (wanted.language != null) {
      candidates.firstOrNull { it.info.language == wanted.language }?.let { return it }
    }
    if (wanted.label != null) {
      candidates.firstOrNull { it.info.label == wanted.label }?.let { return it }
    }
    return exact
  }
}

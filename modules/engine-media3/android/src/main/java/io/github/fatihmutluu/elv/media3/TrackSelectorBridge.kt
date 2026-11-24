package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer

/**
 * Playback-thread bridge between `Player.Listener.onTracksChanged` / `TrackSelectionParameters` and the `@elv/playback`
 * track selection contract. Ignores transient `Tracks.EMPTY`, gates Android `CaptioningManager` defaults on
 * [captioningEnabled], guards unmatched IDs, preserves active cues when re-selecting the already-active subtitle track,
 * and emits confirmed selections (#111, #438).
 */
@OptIn(UnstableApi::class)
internal class TrackSelectorBridge(
  private val isActivePlayer: (ExoPlayer) -> Boolean = { true },
  private val onTracks: (Map<String, Any?>) -> Unit,
  private val onClearCues: () -> Unit,
  private val captioningEnabled: () -> Boolean = { false },
  private val ffmpegSupportsAudio: (String?) -> Boolean = ::defaultFfmpegSupportsAudio,
  private val onClearSecondaryCues: () -> Unit = {},
  private val extraExternalSubtitles: () -> List<TrackInfoSnapshot> = { emptyList() },
  private val onSecondaryTargetChanged: (TrackChoice?, Boolean) -> Unit = { _, _ -> },
) {
  private sealed interface SubChoice {
    data object Default : SubChoice
    data object Off : SubChoice
    data class Selected(val choice: TrackChoice) : SubChoice
  }

  private var audioChoice: TrackChoice? = null
  private var subtitleChoice: SubChoice = SubChoice.Default
  private var secondarySubtitleChoice: TrackChoice? = null
  private var externalPrimarySubtitleId: String? = null
  private var videoQualityChoice: VideoQualityChoice? = null
  private var latestTracks: Tracks = Tracks.EMPTY
  private var lastEmitted: MediaTracksSnapshot? = null
  private var prepareEpoch = 0L

  internal val currentPrepareEpoch: Long
    get() = prepareEpoch

  /** Whether primary `C.TRACK_TYPE_TEXT` is disabled by user choice (`subtitleTrackId === null`) or dynamic external override. */
  val isTextDisabled: Boolean
    get() = subtitleChoice is SubChoice.Off || externalPrimarySubtitleId != null

  /** Currently selected secondary subtitle track ID, or `null` when off (`#402`). */
  val selectedSecondarySubtitleId: String?
    get() = secondarySubtitleChoice?.id

  /** Currently selected dynamic external primary subtitle track ID, or `null` when using Media3's text renderer. */
  val selectedExternalPrimaryId: String?
    get() = externalPrimarySubtitleId

  /** Updates desired track preferences from a new [LoadRequest], preserving cached language/label when reloading. */
  fun onLoad(request: LoadRequest) {
    prepareEpoch += 1
    latestTracks = Tracks.EMPTY
    lastEmitted = null
    videoQualityChoice = null
    externalPrimarySubtitleId = null
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
    val primaryId = (subtitleChoice as? SubChoice.Selected)?.choice?.id
    secondarySubtitleChoice = request.secondarySubtitleTrackId
      ?.takeIf { it.isNotEmpty() && it != primaryId }
      ?.let { wantedSec ->
        secondarySubtitleChoice?.takeIf { it.id == wantedSec }
          ?: TrackChoice(id = wantedSec, language = null, label = null)
      }
    onSecondaryTargetChanged(secondarySubtitleChoice, subtitleChoice is SubChoice.Off)
  }

  /** Resets per-prepare track cache while preserving active track choices across `retry`, `recreate` or HLS re-prepare. */
  fun onPrepareReuse() {
    prepareEpoch += 1
    latestTracks = Tracks.EMPTY
    lastEmitted = null
  }

  /** Clears all track choices and cached tracks on `stop` or `dispose`. */
  fun onStop() {
    prepareEpoch += 1
    audioChoice = null
    subtitleChoice = SubChoice.Default
    secondarySubtitleChoice = null
    externalPrimarySubtitleId = null
    videoQualityChoice = null
    latestTracks = Tracks.EMPTY
    lastEmitted = null
    onSecondaryTargetChanged(null, false)
  }

  /** Resets stale overrides from any prior media and applies initial track parameters before `player.prepare()`. */
  fun applyInitialParameters(player: ExoPlayer) {
    val disableAllText = (subtitleChoice is SubChoice.Off || externalPrimarySubtitleId != null) &&
      secondarySubtitleChoice == null
    val builder = player.trackSelectionParameters.buildUpon()
      .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
      .clearOverridesOfType(C.TRACK_TYPE_TEXT)
      .clearOverridesOfType(C.TRACK_TYPE_VIDEO)
      .clearVideoSizeConstraints()
      .setMaxVideoBitrate(Int.MAX_VALUE)
      .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
      .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, disableAllText)
      .setPreferredAudioLanguage(audioChoice?.language)
    when (val sub = subtitleChoice) {
      SubChoice.Default ->
        if (captioningEnabled()) {
          builder.setPreferredTextLanguageAndRoleFlagsToCaptioningManagerSettings()
        } else {
          builder.setPreferredTextLanguage(null).setPreferredTextRoleFlags(0)
        }
      SubChoice.Off -> builder.setPreferredTextLanguage(null).setPreferredTextRoleFlags(0)
      is SubChoice.Selected ->
        if (sub.choice.language != null) {
          builder.setPreferredTextLanguage(sub.choice.language)
        } else {
          builder.setPreferredTextLanguage(null).setPreferredTextRoleFlags(0)
        }
    }
    player.trackSelectionParameters = builder.build()
    onSecondaryTargetChanged(secondarySubtitleChoice, subtitleChoice is SubChoice.Off || externalPrimarySubtitleId != null)
  }

  /** Selects audio track [id] in place without restarting playback; ignores unmatched IDs once tracks are loaded. */
  fun selectAudioTrack(player: ExoPlayer?, id: String) {
    val tracks = activeTracks(player)
    val matched = findCandidateById(tracks, C.TRACK_TYPE_AUDIO, id, ffmpegSupportsAudio)
    if (!tracks.isEmpty && matched == null) return
    val prev = audioChoice?.takeIf { it.id == id }
    audioChoice = TrackChoice(
      id = id,
      language = matched?.info?.language ?: prev?.language,
      label = matched?.info?.label ?: prev?.label,
      formatId = matched?.info?.formatId ?: prev?.formatId,
      codec = matched?.info?.codec ?: prev?.codec,
      channels = matched?.info?.channels ?: prev?.channels,
    )
    if (player != null && matched != null) {
      val builder = player.trackSelectionParameters.buildUpon()
        .clearOverridesOfType(C.TRACK_TYPE_AUDIO)
        .setTrackTypeDisabled(C.TRACK_TYPE_AUDIO, false)
        .addOverride(TrackSelectionOverride(matched.group.mediaTrackGroup, listOf(matched.trackIndex)))
      if (matched.info.language != null) builder.setPreferredAudioLanguage(matched.info.language)
      player.trackSelectionParameters = builder.build()
    }
  }

  /** Selects subtitle track [id] in place, or disables `C.TRACK_TYPE_TEXT` and clears cues when [id] is `null`. */
  fun selectSubtitleTrack(player: ExoPlayer?, id: String?) {
    if (id == null) {
      onClearCues()
      subtitleChoice = SubChoice.Off
      externalPrimarySubtitleId = null
      val disableAllText = secondarySubtitleChoice == null
      if (player != null) {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
          .clearOverridesOfType(C.TRACK_TYPE_TEXT)
          .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, disableAllText)
          .setPreferredTextLanguage(null)
          .build()
      }
      onSecondaryTargetChanged(secondarySubtitleChoice, true)
      emitSnapshotIfTracksAvailable(player, textDisabled = true)
      return
    }

    val tracks = activeTracks(player)
    val matched = findCandidateById(tracks, C.TRACK_TYPE_TEXT, id, ffmpegSupportsAudio)
    val dynamicExternal = extraExternalSubtitles().firstOrNull { it.id == id }
    if (!tracks.isEmpty && matched == null && dynamicExternal == null) return

    // Enforce secondary != primary: selecting a primary equal to secondary clears secondary immediately (#402).
    val wasSecondary = secondarySubtitleChoice?.id == id
    if (wasSecondary) {
      secondarySubtitleChoice = null
      onClearSecondaryCues()
    }

    if (matched == null && dynamicExternal != null) {
      if (externalPrimarySubtitleId != id) onClearCues()
      externalPrimarySubtitleId = id
      subtitleChoice = SubChoice.Selected(choiceOf(dynamicExternal))
      val disableAllText = secondarySubtitleChoice == null
      if (player != null) {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
          .clearOverridesOfType(C.TRACK_TYPE_TEXT)
          .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, disableAllText)
          .setPreferredTextLanguage(null)
          .build()
      }
      onSecondaryTargetChanged(secondarySubtitleChoice, true)
      emitSnapshotIfTracksAvailable(player, textDisabled = true)
      return
    }

    val currentlyDisabled =
      isTextDisabled || (player?.trackSelectionParameters?.disabledTrackTypes?.contains(C.TRACK_TYPE_TEXT) == true)
    val alreadyActive =
      !currentlyDisabled && !wasSecondary && matched != null && matched.group.isTrackSelected(matched.trackIndex)
    if (!alreadyActive) onClearCues()

    externalPrimarySubtitleId = null
    val prev = (subtitleChoice as? SubChoice.Selected)?.choice?.takeIf { it.id == id }
    subtitleChoice = SubChoice.Selected(
      TrackChoice(
        id = id,
        language = matched?.info?.language ?: prev?.language,
        label = matched?.info?.label ?: prev?.label,
        formatId = matched?.info?.formatId ?: prev?.formatId,
        codec = matched?.info?.codec ?: prev?.codec,
        channels = matched?.info?.channels ?: prev?.channels,
      )
    )
    if (player != null && matched != null) {
      val builder = player.trackSelectionParameters.buildUpon()
        .clearOverridesOfType(C.TRACK_TYPE_TEXT)
        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
        .addOverride(TrackSelectionOverride(matched.group.mediaTrackGroup, listOf(matched.trackIndex)))
      if (matched.info.language != null) builder.setPreferredTextLanguage(matched.info.language)
      player.trackSelectionParameters = builder.build()
    }
    onSecondaryTargetChanged(secondarySubtitleChoice, false)
    emitSnapshotIfTracksAvailable(player, textDisabled = false, forcedPrimaryId = id)
  }

  /**
   * Selects a simultaneous secondary subtitle track [id] in place, or disables secondary subtitles when [id] is `null`
   * (`#402`). Enforces `secondary != primary` by clearing/rejecting any selection equal to the active primary track.
   */
  fun selectSecondarySubtitleTrack(player: ExoPlayer?, id: String?) {
    val cleanId = id?.trim()?.takeIf { it.isNotEmpty() }
    val activePrimaryId = currentPrimarySubtitleId(player)
    if (cleanId == null || cleanId == activePrimaryId) {
      secondarySubtitleChoice = null
      onClearSecondaryCues()
      val disableAllText = isTextDisabled
      if (player != null && disableAllText) {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
          .clearOverridesOfType(C.TRACK_TYPE_TEXT)
          .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
          .build()
      }
      onSecondaryTargetChanged(null, isTextDisabled)
      emitSnapshotIfTracksAvailable(player)
      return
    }

    val tracks = activeTracks(player)
    val matched = findCandidateById(tracks, C.TRACK_TYPE_TEXT, cleanId, ffmpegSupportsAudio)
    val dynamicExternal = extraExternalSubtitles().firstOrNull { it.id == cleanId }
    if (!tracks.isEmpty && matched == null && dynamicExternal == null) return

    if (secondarySubtitleChoice?.id != cleanId) {
      onClearSecondaryCues()
    }

    val prev = secondarySubtitleChoice?.takeIf { it.id == cleanId }
    val choice = TrackChoice(
      id = cleanId,
      language = matched?.info?.language ?: dynamicExternal?.language ?: prev?.language,
      label = matched?.info?.label ?: dynamicExternal?.label ?: prev?.label,
      formatId = matched?.info?.formatId ?: dynamicExternal?.formatId ?: prev?.formatId,
      codec = matched?.info?.codec ?: dynamicExternal?.codec ?: prev?.codec,
      channels = matched?.info?.channels ?: prev?.channels,
    )
    secondarySubtitleChoice = choice

    if (player != null && matched != null && player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) {
      player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
        .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, false)
        .build()
    }
    onSecondaryTargetChanged(choice, isTextDisabled)
    emitSnapshotIfTracksAvailable(player)
  }

  /** Re-emits the current track snapshot after a dynamic external subtitle track is attached mid-playback (`#32`). */
  fun onDynamicExternalSubtitlesChanged(player: ExoPlayer?) {
    val tracks = activeTracks(player)
    if (!tracks.isEmpty || extraExternalSubtitles().isNotEmpty()) {
      val textDisabled = if (player != null) isTextEffectivelyDisabled(player) else isTextDisabled
      emitIfChanged(buildSnapshot(tracks, textDisabled = textDisabled))
    }
  }

  /**
   * Constrains adaptive video selection to rendition [id] in place without restarting playback, or clears
   * video overrides and resolution/bitrate caps to restore automatic ABR when [id] is `null` (`#59`).
   */
  fun selectVideoQuality(player: ExoPlayer?, id: String?) {
    if (id == null) {
      videoQualityChoice = null
      if (player != null) {
        player.trackSelectionParameters = player.trackSelectionParameters.buildUpon()
          .clearOverridesOfType(C.TRACK_TYPE_VIDEO)
          .clearVideoSizeConstraints()
          .setMaxVideoBitrate(Int.MAX_VALUE)
          .build()
      }
      val tracks = activeTracks(player)
      if (!tracks.isEmpty) {
        val textDisabled = if (player != null) isTextEffectivelyDisabled(player) else isTextDisabled
        emitIfChanged(buildSnapshot(tracks, textDisabled = textDisabled, selectedVideoQualityId = null))
      }
      return
    }

    val tracks = activeTracks(player)
    val candidates = videoQualityCandidatesOf(tracks)
    val matched = candidates.firstOrNull { it.option.id == id }
    if (!tracks.isEmpty && matched == null) return

    val prev = videoQualityChoice?.takeIf { it.id == id }
    videoQualityChoice = VideoQualityChoice(
      id = id,
      width = matched?.option?.width ?: prev?.width,
      height = matched?.option?.height ?: prev?.height,
      bitrateBps = matched?.option?.bitrateBps ?: prev?.bitrateBps,
    )
    if (player != null && matched != null) {
      val builder = player.trackSelectionParameters.buildUpon()
        .clearOverridesOfType(C.TRACK_TYPE_VIDEO)
        .clearVideoSizeConstraints()
        .setMaxVideoBitrate(Int.MAX_VALUE)
        .addOverride(TrackSelectionOverride(matched.group.mediaTrackGroup, listOf(matched.trackIndex)))
      val maxW = matched.option.width
      val maxH = matched.option.height
      if (maxW != null && maxH != null) {
        builder.setMaxVideoSize(maxW, maxH)
      }
      matched.option.bitrateBps?.let { builder.setMaxVideoBitrate(it) }
      player.trackSelectionParameters = builder.build()
    }
    if (!tracks.isEmpty && matched != null) {
      val textDisabled = if (player != null) isTextEffectivelyDisabled(player) else isTextDisabled
      emitIfChanged(buildSnapshot(tracks, textDisabled = textDisabled, selectedVideoQualityId = matched.option.id))
    }
  }

  /** Handles Media3 `onTracksChanged`: ignores `Tracks.EMPTY`, reconciles saved choices and emits confirmed tracks. */
  fun onTracksChanged(player: ExoPlayer, tracks: Tracks) {
    if (tracks.isEmpty) return
    latestTracks = tracks
    val params = player.trackSelectionParameters
    val builder = params.buildUpon()
    var changedParams = false
    var targetAudioId: String? = null
    var targetSubtitleId: String? = null
    var targetVideoQualityId: String? = null

    audioChoice?.let { wanted ->
      val target = resolveCandidate(tracks, C.TRACK_TYPE_AUDIO, wanted, ffmpegSupportsAudio)
      if (target != null) {
        audioChoice = choiceOf(target.info)
        targetAudioId = target.info.id
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
        val shouldDisableAllText = secondarySubtitleChoice == null
        if (shouldDisableAllText && !params.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT)) {
          builder.clearOverridesOfType(C.TRACK_TYPE_TEXT)
            .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true)
            .setPreferredTextLanguage(null)
          changedParams = true
        }
      }
      is SubChoice.Selected -> {
        val target = resolveCandidate(tracks, C.TRACK_TYPE_TEXT, wantedSub.choice, ffmpegSupportsAudio)
        if (target != null) {
          externalPrimarySubtitleId = null
          subtitleChoice = SubChoice.Selected(choiceOf(target.info))
          targetSubtitleId = target.info.id
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

    secondarySubtitleChoice?.let { wantedSec ->
      val resolved = resolveCandidate(tracks, C.TRACK_TYPE_TEXT, wantedSec, ffmpegSupportsAudio)
      val activePrimary = targetSubtitleId
        ?: externalPrimarySubtitleId
        ?: currentSelectedTextIdFromTracks(tracks, excludeId = resolved?.info?.id ?: wantedSec.id)
      if (resolved != null) {
        if (resolved.info.id == activePrimary) {
          secondarySubtitleChoice = null
          onClearSecondaryCues()
          onSecondaryTargetChanged(null, isTextDisabled)
        } else {
          val updated = choiceOf(resolved.info)
          if (updated != secondarySubtitleChoice) {
            secondarySubtitleChoice = updated
            onSecondaryTargetChanged(updated, isTextDisabled)
          }
        }
      }
    }

    videoQualityChoice?.let { wantedQuality ->
      val candidates = videoQualityCandidatesOf(tracks)
      val target = resolveVideoQualityCandidate(candidates, wantedQuality)
      if (target != null) {
        videoQualityChoice = VideoQualityChoice(
          id = target.option.id,
          width = target.option.width,
          height = target.option.height,
          bitrateBps = target.option.bitrateBps,
        )
        targetVideoQualityId = target.option.id
        val currentOverride = params.overrides[target.group.mediaTrackGroup]?.trackIndices
        val expectedMaxWidth = target.option.width ?: Int.MAX_VALUE
        val expectedMaxHeight = target.option.height ?: Int.MAX_VALUE
        val expectedMaxBitrate = target.option.bitrateBps ?: Int.MAX_VALUE
        if (
          currentOverride != listOf(target.trackIndex) ||
          params.maxVideoWidth != expectedMaxWidth ||
          params.maxVideoHeight != expectedMaxHeight ||
          params.maxVideoBitrate != expectedMaxBitrate
        ) {
          builder.clearOverridesOfType(C.TRACK_TYPE_VIDEO)
            .clearVideoSizeConstraints()
            .setMaxVideoBitrate(Int.MAX_VALUE)
            .addOverride(TrackSelectionOverride(target.group.mediaTrackGroup, listOf(target.trackIndex)))
          if (target.option.width != null && target.option.height != null) {
            builder.setMaxVideoSize(target.option.width, target.option.height)
          }
          target.option.bitrateBps?.let { builder.setMaxVideoBitrate(it) }
          changedParams = true
        }
      }
    }

    if (changedParams) {
      player.trackSelectionParameters = builder.build()
      if (player.mediaItemCount > 0 && player.playbackState != Player.STATE_IDLE) {
        val epoch = prepareEpoch
        player.createMessage { _, _ -> emitConfirmedFromPlayer(player, epoch) }
          .setLooper(player.applicationLooper)
          .send()
        return
      }
    }

    val textDisabled = isTextEffectivelyDisabled(player)
    val inspected = buildSnapshot(
      tracks,
      textDisabled = textDisabled,
      selectedVideoQualityId = targetVideoQualityId ?: videoQualityChoice?.id,
    )
    val snapshot = if (changedParams) {
      val resolvedPrimary = if (textDisabled) externalPrimarySubtitleId else (targetSubtitleId ?: inspected.selectedSubtitleId)
      val resolvedSecondary = inspected.selectedSecondarySubtitleId?.takeIf { it != resolvedPrimary }
      inspected.copy(
        selectedAudioId = targetAudioId ?: inspected.selectedAudioId,
        selectedSubtitleId = resolvedPrimary,
        selectedSecondarySubtitleId = resolvedSecondary,
      )
    } else {
      inspected
    }
    emitIfChanged(snapshot)
  }

  internal fun emitConfirmedFromPlayer(player: ExoPlayer, epoch: Long) {
    if (epoch != prepareEpoch || !isActivePlayer(player)) return
    val current = player.currentTracks
    if (current.isEmpty) return
    latestTracks = current
    emitIfChanged(buildSnapshot(current, textDisabled = isTextEffectivelyDisabled(player)))
  }

  private fun buildSnapshot(
    tracks: Tracks,
    textDisabled: Boolean,
    selectedVideoQualityId: String? = videoQualityChoice?.id,
  ): MediaTracksSnapshot =
    inspectMediaTracks(
      tracks,
      textDisabled = textDisabled,
      selectedVideoQualityId = selectedVideoQualityId,
      ffmpegSupportsAudio = ffmpegSupportsAudio,
      selectedSecondarySubtitleId = secondarySubtitleChoice?.id,
      extraExternalSubtitles = extraExternalSubtitles(),
      selectedExternalPrimaryId = externalPrimarySubtitleId,
      preferredPrimarySubtitleId = (subtitleChoice as? SubChoice.Selected)?.choice?.id,
    )

  private fun emitSnapshotIfTracksAvailable(
    player: ExoPlayer?,
    textDisabled: Boolean? = null,
    forcedPrimaryId: String? = null,
  ) {
    val tracks = activeTracks(player)
    if (tracks.isEmpty && extraExternalSubtitles().isEmpty()) return
    val disabled = textDisabled ?: if (player != null) isTextEffectivelyDisabled(player) else isTextDisabled
    val built = buildSnapshot(tracks, textDisabled = disabled)
    val adjusted = if (forcedPrimaryId != null && !disabled) {
      built.copy(
        selectedSubtitleId = forcedPrimaryId,
        selectedSecondarySubtitleId = built.selectedSecondarySubtitleId?.takeIf { it != forcedPrimaryId },
      )
    } else {
      built
    }
    emitIfChanged(adjusted)
  }

  private fun currentPrimarySubtitleId(player: ExoPlayer?): String? {
    if (externalPrimarySubtitleId != null) return externalPrimarySubtitleId
    if (subtitleChoice is SubChoice.Off) return null
    (subtitleChoice as? SubChoice.Selected)?.choice?.id?.let { return it }
    val tracks = activeTracks(player)
    return currentSelectedTextIdFromTracks(tracks, excludeId = secondarySubtitleChoice?.id)
  }

  private fun currentSelectedTextIdFromTracks(tracks: Tracks, excludeId: String? = null): String? {
    if (tracks.isEmpty) return null
    val candidates = candidatesOf(tracks, C.TRACK_TYPE_TEXT, ffmpegSupportsAudio)
    return candidates.firstOrNull { candidate ->
      candidate.group.isTrackSelected(candidate.trackIndex) && candidate.info.id != excludeId
    }?.info?.id
  }

  private fun choiceOf(info: TrackInfoSnapshot): TrackChoice =
    TrackChoice(
      id = info.id,
      language = info.language,
      label = info.label,
      formatId = info.formatId,
      codec = info.codec,
      channels = info.channels,
    )

  private fun isTextEffectivelyDisabled(player: ExoPlayer): Boolean =
    subtitleChoice is SubChoice.Off ||
      externalPrimarySubtitleId != null ||
      (secondarySubtitleChoice == null && player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))

  private fun emitIfChanged(snapshot: MediaTracksSnapshot) {
    if (snapshot == lastEmitted) return
    lastEmitted = snapshot
    onTracks(snapshot.toMap())
  }

  private fun activeTracks(player: ExoPlayer?): Tracks =
    if (!latestTracks.isEmpty) latestTracks else (player?.currentTracks ?: Tracks.EMPTY)
}

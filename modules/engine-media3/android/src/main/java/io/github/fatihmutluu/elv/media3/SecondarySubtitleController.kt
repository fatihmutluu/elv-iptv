package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Timeline
import androidx.media3.common.TrackGroup
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.Renderer
import androidx.media3.exoplayer.RendererCapabilities
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.exoplayer.text.TextRenderer
import androidx.media3.exoplayer.trackselection.AdaptiveTrackSelection
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.trackselection.MappingTrackSelector
import androidx.media3.exoplayer.upstream.BandwidthMeter
import java.util.LinkedHashMap

internal const val SECONDARY_TEXT_RENDERER_NAME = "SecondaryTextRenderer"

/**
 * Secondary `C.TRACK_TYPE_TEXT` renderer delegating decoding to a dedicated Media3 [TextRenderer] while advertising
 * [C.FORMAT_EXCEEDS_CAPABILITIES] in [RendererCapabilities.supportsFormat] so `MappingTrackSelector` always keeps all
 * text `TrackGroup`s mapped to the primary [TextRenderer], never stealing primary subtitle cues (`#402`).
 */
@OptIn(UnstableApi::class)
internal class SecondaryTextRenderer(
  output: TextOutput,
  outputLooper: Looper,
  private val delegate: TextRenderer = TextRenderer(output, outputLooper),
) : Renderer by delegate {
  private val secondaryCapabilities = object : RendererCapabilities by delegate.capabilities {
    override fun getName(): String = SECONDARY_TEXT_RENDERER_NAME

    override fun supportsFormat(format: Format): Int {
      val raw = delegate.capabilities.supportsFormat(format)
      return if (RendererCapabilities.getFormatSupport(raw) == C.FORMAT_HANDLED) {
        RendererCapabilities.create(C.FORMAT_EXCEEDS_CAPABILITIES)
      } else {
        raw
      }
    }
  }

  override fun getName(): String = SECONDARY_TEXT_RENDERER_NAME

  override fun getCapabilities(): RendererCapabilities = secondaryCapabilities
}

@OptIn(UnstableApi::class)
private class DualTrackSelectionFactory(
  private val delegate: ExoTrackSelection.Factory = AdaptiveTrackSelection.Factory(),
) : ExoTrackSelection.Factory {
  var pendingSecondaryIndex: Int = -1
  var pendingSecondaryDefinition: ExoTrackSelection.Definition? = null
  var pendingSuppressedPrimaryIndices: IntArray = IntArray(0)

  fun clearPending() {
    pendingSecondaryIndex = -1
    pendingSecondaryDefinition = null
    pendingSuppressedPrimaryIndices = IntArray(0)
  }

  override fun createTrackSelections(
    definitions: Array<ExoTrackSelection.Definition?>,
    bandwidthMeter: BandwidthMeter,
    mediaPeriodId: MediaSource.MediaPeriodId,
    timeline: Timeline,
  ): Array<ExoTrackSelection?> {
    for (idx in pendingSuppressedPrimaryIndices) {
      if (idx in definitions.indices) definitions[idx] = null
    }
    val secIdx = pendingSecondaryIndex
    val secDef = pendingSecondaryDefinition
    if (secIdx in definitions.indices && secDef != null) {
      definitions[secIdx] = secDef
    }
    clearPending()
    return delegate.createTrackSelections(definitions, bandwidthMeter, mediaPeriodId, timeline)
  }
}

/**
 * `DefaultTrackSelector` subclass enabling simultaneous dual subtitle rendering (`#402`):
 * - Standard primary subtitle selection continues uninterrupted on primary `C.TRACK_TYPE_TEXT` renderers.
 * - Explicitly identifies [SecondaryTextRenderer] by renderer name or registered renderer index (never assuming
 *   `textRenderers[1]`) and binds it to the matching `(TrackGroup, trackIndex)` in `selectAllTracks` and through
 *   [DualTrackSelectionFactory] so primary `TrackSelectionOverride` passes never wipe secondary selection.
 * - When [primaryTextDisabled] is true while a secondary track is active, suppresses all non-secondary text renderers
 *   so only the secondary track renders.
 */
@OptIn(UnstableApi::class)
internal class DualSubtitleTrackSelector private constructor(
  context: Context,
  private val selectionFactory: DualTrackSelectionFactory,
) : DefaultTrackSelector(context, selectionFactory) {
  constructor(context: Context) : this(context, DualTrackSelectionFactory())

  @Volatile
  private var secondaryTarget: TrackChoice? = null

  @Volatile
  private var primaryTextDisabled: Boolean = false

  @Volatile
  private var configuredSecondaryRendererIndex: Int = -1

  /** Records the exact renderer index of [SecondaryTextRenderer] from [PlayerFactory] as a fallback identifier. */
  fun setSecondaryRendererIndex(index: Int?) {
    configuredSecondaryRendererIndex = index ?: -1
  }

  /** Updates the desired secondary embedded/merged subtitle target and invalidates selection. */
  fun setSecondarySelection(target: TrackChoice?, primaryDisabled: Boolean) {
    if (secondaryTarget == target && primaryTextDisabled == primaryDisabled) return
    secondaryTarget = target
    primaryTextDisabled = primaryDisabled
    invalidate(parameters)
  }

  override fun selectAllTracks(
    definitions: Array<ExoTrackSelection.Definition?>,
    mappedTrackInfo: MappingTrackSelector.MappedTrackInfo,
    rendererFormatSupports: Array<Array<IntArray>>,
    rendererMixedMimeTypeAdaptationSupport: IntArray,
    params: Parameters,
  ) {
    selectionFactory.clearPending()
    super.selectAllTracks(
      definitions,
      mappedTrackInfo,
      rendererFormatSupports,
      rendererMixedMimeTypeAdaptationSupport,
      params,
    )
    val textRenderers = ArrayList<Int>(3)
    var namedSecondaryIdx = -1
    for (i in 0 until mappedTrackInfo.rendererCount) {
      if (mappedTrackInfo.getRendererType(i) == C.TRACK_TYPE_TEXT) {
        textRenderers.add(i)
        if (namedSecondaryIdx < 0 && mappedTrackInfo.getRendererName(i) == SECONDARY_TEXT_RENDERER_NAME) {
          namedSecondaryIdx = i
        }
      }
    }
    val secondaryIdx = when {
      namedSecondaryIdx >= 0 -> namedSecondaryIdx
      configuredSecondaryRendererIndex in 0 until mappedTrackInfo.rendererCount &&
        mappedTrackInfo.getRendererType(configuredSecondaryRendererIndex) == C.TRACK_TYPE_TEXT ->
        configuredSecondaryRendererIndex
      else -> -1
    }
    if (secondaryIdx < 0) return

    val primaryCandidates = textRenderers.filter { it != secondaryIdx }
    if (primaryCandidates.isEmpty()) return

    if (primaryTextDisabled) {
      selectionFactory.pendingSuppressedPrimaryIndices = primaryCandidates.toIntArray()
      for (idx in primaryCandidates) {
        definitions[idx] = null
      }
    }

    val wanted = secondaryTarget ?: return
    var groupOffset = 0
    var matched: ExoTrackSelection.Definition? = null
    for (r in 0 until mappedTrackInfo.rendererCount) {
      val groups = mappedTrackInfo.getTrackGroups(r)
      if (matched == null && r in primaryCandidates && groups.length > 0) {
        matched = findSecondaryDefinition(
          groups = groups,
          wanted = wanted,
          primaryDef = definitions[r],
          groupIndexOffset = groupOffset,
        )
      }
      groupOffset += groups.length
    }
    if (matched != null) {
      definitions[secondaryIdx] = matched
      selectionFactory.pendingSecondaryIndex = secondaryIdx
      selectionFactory.pendingSecondaryDefinition = matched
    }
  }

  internal fun findSecondaryDefinition(
    groups: androidx.media3.exoplayer.source.TrackGroupArray,
    wanted: TrackChoice,
    primaryDef: ExoTrackSelection.Definition?,
    groupIndexOffset: Int = 0,
  ): ExoTrackSelection.Definition? {
    var exactCompatibleIndexMatch: ExoTrackSelection.Definition? = null
    var globalIndexMatch: ExoTrackSelection.Definition? = null
    var localIndexMatch: ExoTrackSelection.Definition? = null
    var langLabelMatch: ExoTrackSelection.Definition? = null
    var langMatch: ExoTrackSelection.Definition? = null
    var labelMatch: ExoTrackSelection.Definition? = null

    for (gIdx in 0 until groups.length) {
      val group = groups[gIdx]
      for (tIdx in 0 until group.length) {
        if (isSameAsPrimary(group, tIdx, primaryDef)) continue
        val format = group.getFormat(tIdx)
        val fmtId = format.id?.trim()?.takeIf { it.isNotEmpty() }
        if (wanted.id.startsWith(EXTERNAL_SUBTITLE_ID_PREFIX) && fmtId == wanted.id) {
          return ExoTrackSelection.Definition(group, tIdx)
        }
        if (wanted.formatId != null && fmtId == wanted.formatId) {
          return ExoTrackSelection.Definition(group, tIdx)
        }
        val label = format.label?.trim()?.takeIf { it.isNotEmpty() }
        val lang = normalizeLang(format.language) ?: extractLanguageFromLabel(label)
        val langMatches = wanted.language != null && sameLanguage(lang, wanted.language)
        val labelMatches = wanted.label != null && label == wanted.label
        val globalId = "${groupIndexOffset + gIdx}:$tIdx"
        val localId = "$gIdx:$tIdx"
        if (globalId == wanted.id) {
          val candidate = ExoTrackSelection.Definition(group, tIdx)
          if (globalIndexMatch == null) globalIndexMatch = candidate
          val langOk = wanted.language == null || langMatches
          val labelOk = wanted.label == null || labelMatches
          if (langOk && labelOk && exactCompatibleIndexMatch == null) {
            exactCompatibleIndexMatch = candidate
          }
        } else if (localId == wanted.id && localIndexMatch == null) {
          localIndexMatch = ExoTrackSelection.Definition(group, tIdx)
        }
        if (langMatches && labelMatches && langLabelMatch == null) {
          langLabelMatch = ExoTrackSelection.Definition(group, tIdx)
        } else if (langMatches && langMatch == null) {
          langMatch = ExoTrackSelection.Definition(group, tIdx)
        } else if (labelMatches && labelMatch == null) {
          labelMatch = ExoTrackSelection.Definition(group, tIdx)
        }
      }
    }
    return exactCompatibleIndexMatch ?: langLabelMatch ?: langMatch ?: labelMatch ?: globalIndexMatch ?: localIndexMatch
  }

  private fun isSameAsPrimary(
    group: TrackGroup,
    trackIndex: Int,
    primaryDef: ExoTrackSelection.Definition?,
  ): Boolean {
    if (primaryDef == null) return false
    return primaryDef.group == group && trackIndex in primaryDef.tracks
  }
}

/**
 * Manages simultaneous dual subtitle cue delivery and mid-playback dynamic external sidecar tracks (`#32`, `#402`):
 * - Buffers secondary [SecondaryTextRenderer] cues in a dedicated [TimedSubtitleCueBuffer] honoring `subtitleDelayMs`
 *   and `filterSdhSubtitles`.
 * - Caches dynamically added external sidecar tracks (`ext:<id>`) so they can render as primary OR secondary without
 *   restarting playback.
 * - Repositions all secondary cues to the top band via [SubtitleStyleMapper.repositionSecondaryCues] so primary bottom
 *   cues and secondary top cues never overlap.
 */
@OptIn(UnstableApi::class)
internal class SecondarySubtitleController(
  private val onSecondaryCues: (List<Cue>) -> Unit,
) {
  private val secondaryCueBuffer = TimedSubtitleCueBuffer()
  private val sidecarConfigs = LinkedHashMap<String, ExternalSubtitleConfig>()
  private val sidecarCues = LinkedHashMap<String, List<TimedSidecarCue>>()
  private var lastDeliveredSecondary: List<Cue>? = null

  /** Current clamped subtitle timing offset in milliseconds shared with primary subtitles. */
  val delayMs: Long
    get() = secondaryCueBuffer.delayMs

  /** True when either secondary buffered cues or sidecar tracks are active and require periodic position ticks. */
  val hasActiveSidecars: Boolean
    get() = sidecarCues.isNotEmpty()

  val isSecondaryBufferNotEmpty: Boolean
    get() = secondaryCueBuffer.isNotEmpty

  /** Registers an external sidecar track metadata descriptor (idempotent by `trackId`). */
  fun registerExternalTrack(config: ExternalSubtitleConfig): Boolean {
    if (sidecarConfigs.containsKey(config.trackId)) return false
    sidecarConfigs[config.trackId] = config
    return true
  }

  /** Stores parsed sidecar cues for [trackId]. */
  fun storeSidecarCues(trackId: String, cues: List<TimedSidecarCue>) {
    sidecarCues[trackId] = cues
  }

  /** Returns all dynamically registered external subtitle tracks as [TrackInfoSnapshot] entries. */
  fun dynamicExternalTrackSnapshots(): List<TrackInfoSnapshot> =
    sidecarConfigs.values.map { cfg ->
      TrackInfoSnapshot(
        id = cfg.trackId,
        language = normalizeLang(cfg.language) ?: extractLanguageFromLabel(cfg.label),
        label = cfg.label,
        codec = cfg.mimeType,
        external = true,
        formatId = cfg.trackId,
      )
    }

  /** True when [trackId] is backed by loaded sidecar cues rather than Media3's container text renderer. */
  fun hasSidecarTrack(trackId: String?): Boolean =
    trackId != null && sidecarConfigs.containsKey(trackId)

  fun getExternalConfig(trackId: String): ExternalSubtitleConfig? = sidecarConfigs[trackId]

  /** Applies live subtitle timing offset (`[-30_000, 30_000]` ms) without flushing buffered secondary cues. */
  fun setDelayMs(delayMs: Long) {
    secondaryCueBuffer.setDelayMs(delayMs)
  }

  /** Records sanitized cues from [SecondaryTextRenderer] and delivers top-aligned secondary cues. */
  fun onRendererCues(positionUs: Long, rawCues: List<Cue>, filterSdh: Boolean) {
    val sanitized = sanitizeCues(rawCues, filterSdh = filterSdh)
    secondaryCueBuffer.record(positionUs, sanitized)
  }

  /** Resolves and delivers active top-aligned secondary cues for [positionMs] and [activeSecondaryId]. */
  fun resolveAndDeliverSecondary(
    positionMs: Long,
    activeSecondaryId: String?,
    filterSdh: Boolean,
  ) {
    val resolved: List<Cue> = if (activeSecondaryId == null) {
      emptyList()
    } else {
      val sidecar = sidecarCues[activeSecondaryId]
      val raw = if (sidecar != null) {
        resolveActiveSidecarCues(sidecar, positionMs, delayMs = delayMs, filterSdh = filterSdh)
      } else {
        secondaryCueBuffer.resolveCues(positionMs.coerceAtLeast(0L) * 1_000L)
      }
      SubtitleStyleMapper.repositionSecondaryCues(raw)
    }
    if (resolved != lastDeliveredSecondary) {
      lastDeliveredSecondary = resolved
      onSecondaryCues(resolved)
    }
  }

  /** Resolves active cues for a dynamically added external sidecar track selected as PRIMARY. */
  fun resolvePrimarySidecar(
    positionMs: Long,
    activePrimaryId: String?,
    filterSdh: Boolean,
  ): List<Cue>? {
    if (activePrimaryId == null) return null
    val sidecar = sidecarCues[activePrimaryId] ?: return null
    return resolveActiveSidecarCues(sidecar, positionMs, delayMs = delayMs, filterSdh = filterSdh)
  }

  /** Clears rendered secondary cues while preserving registered sidecars and optional delay (seek/track switch). */
  fun clearSecondaryCues(resetDelay: Boolean = false) {
    if (resetDelay) secondaryCueBuffer.reset() else secondaryCueBuffer.clearCues()
    lastDeliveredSecondary = null
    onSecondaryCues(emptyList())
  }

  /** Resets all secondary cues, timing offset, and registered dynamic external tracks on new load / stop. */
  fun resetAll() {
    sidecarConfigs.clear()
    sidecarCues.clear()
    secondaryCueBuffer.reset()
    lastDeliveredSecondary = null
    onSecondaryCues(emptyList())
  }
}

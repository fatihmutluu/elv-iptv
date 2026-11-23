package io.github.fatihmutluu.elv.media3

import java.util.Locale
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

/**
 * Returns `true` only when [url] is a well-formed `http` or `https` URL with a non-empty host and no ASCII
 * control characters, matching Apple `AetherEngine` (`MediaPlan.swift`) and desktop `player-ipc.ts`.
 */
internal fun isAllowedPlaybackUrl(url: String): Boolean {
  if (url.any { it.code <= 0x1f || it.code == 0x7f }) return false
  val trimmed = url.trim()
  if (trimmed.isEmpty()) return false
  val schemeEnd = trimmed.indexOf("://")
  if (schemeEnd <= 0) return false
  val scheme = trimmed.substring(0, schemeEnd).lowercase()
  if (scheme != "http" && scheme != "https") return false
  val afterScheme = trimmed.substring(schemeEnd + 3)
  if (afterScheme.isEmpty() || afterScheme[0] == '/' || afterScheme[0] == '\\') return false
  val parsed = trimmed.toHttpUrlOrNull() ?: return false
  return (parsed.scheme == "http" || parsed.scheme == "https") && parsed.host.isNotEmpty()
}

/** Initial subtitle track preference carried on a `LoadCommand`. */
internal sealed interface SubtitlePreference {
  /** Leave Media3's default subtitle track selection untouched. */
  data object Default : SubtitlePreference

  /** Explicitly disable `C.TRACK_TYPE_TEXT` (`subtitleTrackId === null`). */
  data object Off : SubtitlePreference

  /** Select a specific subtitle track ID (falling back by language/label if reloaded groups shift). */
  data class Selected(val id: String) : SubtitlePreference
}

/** User-selected video decoder preference for Android Media3 (#411). */
internal enum class VideoDecoderMode(val wireName: String) {
  AUTO("auto"),
  HARDWARE("hardware"),
  SOFTWARE("software"),
}

/** Parses a wire video decoder mode name (case-insensitive, trimmed), falling back to [VideoDecoderMode.AUTO]. */
internal fun parseVideoDecoderMode(raw: String?): VideoDecoderMode =
  when (raw?.trim()?.lowercase(Locale.ROOT)) {
    VideoDecoderMode.HARDWARE.wireName -> VideoDecoderMode.HARDWARE
    VideoDecoderMode.SOFTWARE.wireName -> VideoDecoderMode.SOFTWARE
    else -> VideoDecoderMode.AUTO
  }

/** One `load`: what to play and how. Built from the JavaScript `LoadCommand`; never persisted. */
internal data class LoadRequest(
  val url: String,
  val headers: Map<String, String>,
  val live: Boolean,
  val startMs: Long?,
  val softwareAudio: Boolean,
  val preferHevcOverDolbyVision: Boolean = false,
  val audioTrackId: String? = null,
  val subtitlePreference: SubtitlePreference = SubtitlePreference.Default,
  /** The response to [url] was an HLS playlist (after redirects); the media is prepared as HLS from [url]. */
  val playlistDetected: Boolean = false,
  /** User-selected buffer size preset (#147). */
  val bufferPreset: BufferPreset = BufferPreset.AUTO,
  /** User-selected video decoder preference (#411). */
  val decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
  /** Strip SDH / Hearing-Impaired annotations from text subtitle cues (#310). */
  val filterSdhSubtitles: Boolean = false,
  /** Opt-in legacy TLS (TLS 1.0/1.1) compatibility for older servers (#182). */
  val allowLegacyTls: Boolean = false,
) {
  /** Names no URL and no header value: both may carry credentials. */
  override fun toString(): String {
    val dvSuffix = if (preferHevcOverDolbyVision) ", preferHevcOverDolbyVision=true" else ""
    val presetSuffix = if (bufferPreset != BufferPreset.AUTO) ", bufferPreset=${bufferPreset.wireName}" else ""
    val decoderSuffix = if (decoderMode != VideoDecoderMode.AUTO) ", decoderMode=${decoderMode.wireName}" else ""
    val sdhSuffix = if (filterSdhSubtitles) ", filterSdhSubtitles=true" else ""
    val tlsSuffix = if (allowLegacyTls) ", allowLegacyTls=true" else ""
    return "LoadRequest(live=$live, startMs=$startMs, softwareAudio=$softwareAudio, " +
      "playlistDetected=$playlistDetected, headers=${headers.size}$dvSuffix$presetSuffix$decoderSuffix$sdhSuffix$tlsSuffix)"
  }
}

/**
 * Parses the flattened JavaScript `load` map while preserving the three-way distinction between an omitted
 * `subtitleTrackId` ([SubtitlePreference.Default]), `null` ([SubtitlePreference.Off]), and a track id string
 * ([SubtitlePreference.Selected]).
 */
internal fun parseLoadArgs(args: Map<String, Any?>): Pair<Int, LoadRequest> {
  val attempt = (args["attempt"] as? Number)?.toInt() ?: 0
  val url = args["url"] as? String ?: ""
  val rawHeaders = args["headers"] as? Map<*, *>
  val headers =
    rawHeaders
      ?.entries
      ?.mapNotNull { (k, v) -> if (k is String && v is String) k to v else null }
      ?.toMap()
      ?: emptyMap()
  val kind = args["kind"] as? String ?: "live"
  val startMs = finiteLongOrNull(args["startMs"])
  val softwareAudio = args["softwareAudio"] as? Boolean ?: false
  val preferHevcOverDolbyVision = args["preferHevcOverDolbyVision"] as? Boolean ?: false
  val filterSdhSubtitles = args["filterSdhSubtitles"] as? Boolean ?: false
  val allowLegacyTls = args["allowLegacyTls"] as? Boolean ?: false
  val audioTrackId = (args["audioTrackId"] as? String)?.takeIf { it.isNotEmpty() }
  val bufferPreset = parseBufferPreset(args["bufferPreset"] as? String)
  val decoderMode = parseVideoDecoderMode(args["decoderMode"] as? String)
  val subtitlePreference =
    if (!args.containsKey("subtitleTrackId")) {
      SubtitlePreference.Default
    } else {
      when (val sub = args["subtitleTrackId"]) {
        null -> SubtitlePreference.Off
        is String -> if (sub.isNotEmpty()) SubtitlePreference.Selected(sub) else SubtitlePreference.Default
        else -> SubtitlePreference.Default
      }
    }
  return attempt to LoadRequest(
    url = url,
    headers = headers,
    live = kind != "vod",
    startMs = startMs,
    softwareAudio = softwareAudio,
    preferHevcOverDolbyVision = preferHevcOverDolbyVision,
    audioTrackId = audioTrackId,
    subtitlePreference = subtitlePreference,
    bufferPreset = bufferPreset,
    decoderMode = decoderMode,
    filterSdhSubtitles = filterSdhSubtitles,
    allowLegacyTls = allowLegacyTls,
  )
}

/**
 * The same request played as HLS. It keeps the original [LoadRequest.url]: Media3 follows the redirect again on every
 * playlist load and resolves segments against the redirected playlist, so a short-lived redirect token never expires
 * under a later `retry`.
 */
internal fun LoadRequest.asDetectedPlaylist(): LoadRequest = copy(playlistDetected = true)

/** How this request is played: see [sourceTypeFor]. */
internal fun LoadRequest.sourceType(): SourceType = sourceTypeFor(url, live, playlistDetected)

/** Stream buffer profile classification for [loadControlForStream] (#147). */
internal fun LoadRequest.streamKind(): StreamKind =
  if (!live) {
    StreamKind.VOD
  } else if (sourceType() == SourceType.TS) {
    StreamKind.RAW_TS_LIVE
  } else {
    StreamKind.HLS_LIVE
  }

private fun finiteLongOrNull(raw: Any?): Long? =
  when (raw) {
    is Double -> if (raw.isFinite()) raw.toLong() else null
    is Float -> if (raw.isFinite()) raw.toLong() else null
    is Number -> raw.toLong()
    else -> null
  }

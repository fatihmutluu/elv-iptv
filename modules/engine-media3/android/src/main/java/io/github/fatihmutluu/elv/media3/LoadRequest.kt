package io.github.fatihmutluu.elv.media3

import androidx.media3.common.MimeTypes
import java.util.Locale
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal const val MAX_EXTERNAL_SUBTITLE_URI_LENGTH = 4_096
internal const val EXTERNAL_SUBTITLE_ID_PREFIX = "ext:"

private const val MAX_EXTERNAL_SUBTITLE_ID_LENGTH = 256
private const val MAX_EXTERNAL_SUBTITLE_LABEL_LENGTH = 128
private const val MAX_EXTERNAL_SUBTITLE_LANGUAGE_LENGTH = 32
private const val MAX_EXTERNAL_SUBTITLE_MIME_LENGTH = 128

private val MIME_TOKEN_RE = Regex("^[a-z0-9!#$&^_.+-]+/[a-z0-9!#$&^_.+-]+$")

private val CANONICAL_SUBTITLE_MIME_ALIASES = mapOf(
  "text/vtt" to MimeTypes.TEXT_VTT,
  "text/webvtt" to MimeTypes.TEXT_VTT,
  "application/x-subrip" to MimeTypes.APPLICATION_SUBRIP,
  "text/srt" to MimeTypes.APPLICATION_SUBRIP,
  "text/x-srt" to MimeTypes.APPLICATION_SUBRIP,
  "application/srt" to MimeTypes.APPLICATION_SUBRIP,
  "text/x-ssa" to MimeTypes.TEXT_SSA,
  "text/x-ass" to MimeTypes.TEXT_SSA,
  "application/x-ssa" to MimeTypes.TEXT_SSA,
  "application/x-ass" to MimeTypes.TEXT_SSA,
  "application/ttml+xml" to MimeTypes.APPLICATION_TTML,
  "application/ttaf+xml" to MimeTypes.APPLICATION_TTML,
  "text/ttml" to MimeTypes.APPLICATION_TTML,
)

private val EXTENSION_SUBTITLE_MIME_MAP = mapOf(
  "vtt" to MimeTypes.TEXT_VTT,
  "webvtt" to MimeTypes.TEXT_VTT,
  "srt" to MimeTypes.APPLICATION_SUBRIP,
  "ass" to MimeTypes.TEXT_SSA,
  "ssa" to MimeTypes.TEXT_SSA,
  "ttml" to MimeTypes.APPLICATION_TTML,
  "dfxp" to MimeTypes.APPLICATION_TTML,
  "xml" to MimeTypes.APPLICATION_TTML,
)

private fun stripControlChars(raw: String): String =
  buildString(raw.length) {
    for (c in raw) {
      if (c.code <= 0x1f || c.code == 0x7f) continue
      append(c)
    }
  }.trim()

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
  val scheme = trimmed.substring(0, schemeEnd).lowercase(Locale.ROOT)
  if (scheme != "http" && scheme != "https") return false
  val afterScheme = trimmed.substring(schemeEnd + 3)
  if (afterScheme.isEmpty() || afterScheme[0] == '/' || afterScheme[0] == '\\') return false
  val parsed = trimmed.toHttpUrlOrNull() ?: return false
  return (parsed.scheme == "http" || parsed.scheme == "https") && parsed.host.isNotEmpty()
}

/**
 * Returns `true` only when [uri] is a bounded (`<= 4096` chars), control-char-free external subtitle URI using
 * an allowlisted scheme (`http://`, `https://`, `file://`, or `content://`) (`#308`).
 */
internal fun isAllowedExternalSubtitleUri(uri: String): Boolean {
  if (uri.isEmpty() || uri.length > MAX_EXTERNAL_SUBTITLE_URI_LENGTH) return false
  if (uri.any { it.code <= 0x1f || it.code == 0x7f }) return false
  val trimmed = uri.trim()
  if (trimmed.isEmpty() || trimmed.length > MAX_EXTERNAL_SUBTITLE_URI_LENGTH) return false
  val schemeEnd = trimmed.indexOf("://")
  if (schemeEnd <= 0) return false
  val scheme = trimmed.substring(0, schemeEnd).lowercase(Locale.ROOT)
  return when (scheme) {
    "http", "https" -> isAllowedPlaybackUrl(trimmed)
    "file", "content" -> trimmed.substring(schemeEnd + 3).trim().isNotEmpty()
    else -> false
  }
}

/** Resolves a canonical Media3 subtitle MIME type from an explicit hint or URI extension (`#32`, `#308`). */
internal fun inferSubtitleMimeType(uri: String, explicitMime: String? = null): String {
  if (!explicitMime.isNullOrBlank()) {
    val cleaned = stripControlChars(explicitMime).substringBefore(';').trim().lowercase(Locale.ROOT)
    if (cleaned.isNotEmpty() && cleaned.length <= MAX_EXTERNAL_SUBTITLE_MIME_LENGTH) {
      CANONICAL_SUBTITLE_MIME_ALIASES[cleaned]?.let { return it }
      if (cleaned != "application/octet-stream" && MIME_TOKEN_RE.matches(cleaned)) {
        return cleaned
      }
    }
  }
  val pathPart = uri.substringBefore('#').substringBefore('?')
  val lastSep = maxOf(pathPart.lastIndexOf('/'), pathPart.lastIndexOf('\\'))
  val fileName = if (lastSep < 0) pathPart else pathPart.substring(lastSep + 1)
  val dot = fileName.lastIndexOf('.')
  if (dot >= 0 && dot + 1 < fileName.length) {
    val ext = fileName.substring(dot + 1).lowercase(Locale.ROOT)
    EXTENSION_SUBTITLE_MIME_MAP[ext]?.let { return it }
  }
  return MimeTypes.APPLICATION_SUBRIP
}

/**
 * Validated external sidecar subtitle track descriptor (`#32`, `#308`).
 * Its [headers] are strictly isolated from the primary stream and NEVER carry stream credentials.
 */
internal data class ExternalSubtitleConfig(
  val id: String,
  val uri: String,
  val label: String? = null,
  val language: String? = null,
  val mimeType: String = MimeTypes.APPLICATION_SUBRIP,
  val headers: Map<String, String> = emptyMap(),
) {
  /** Stable Media3 track ID prefixed with `ext:` so external tracks never collide with embedded indices. */
  val trackId: String
    get() = if (id.startsWith(EXTERNAL_SUBTITLE_ID_PREFIX)) id else "$EXTERNAL_SUBTITLE_ID_PREFIX$id"

  /** Names no URI and no header value: either may carry secrets or paths. */
  override fun toString(): String =
    "ExternalSubtitleConfig(id=$trackId, mimeType=$mimeType, headers=${headers.size})"
}

/** Parses and validates one JS external subtitle map (`#308`), returning `null` if invalid. */
internal fun parseExternalSubtitleConfig(raw: Any?): ExternalSubtitleConfig? {
  val map = raw as? Map<*, *> ?: return null
  val rawId = map["id"] as? String ?: return null
  val rawUri = map["uri"] as? String ?: return null
  val id = stripControlChars(rawId).take(MAX_EXTERNAL_SUBTITLE_ID_LENGTH)
  if (id.isEmpty()) return null
  val cleanUri = stripControlChars(rawUri)
  if (!isAllowedExternalSubtitleUri(cleanUri)) return null
  val label = (map["label"] as? String)?.let(::stripControlChars)?.take(MAX_EXTERNAL_SUBTITLE_LABEL_LENGTH)
    ?.takeIf { it.isNotEmpty() }
  val language = (map["language"] as? String)?.let(::stripControlChars)?.take(MAX_EXTERNAL_SUBTITLE_LANGUAGE_LENGTH)
    ?.takeIf { it.isNotEmpty() }
  val mimeType = inferSubtitleMimeType(cleanUri, map["mimeType"] as? String)
  val rawHeaders = map["headers"] as? Map<*, *>
  val headers =
    rawHeaders
      ?.entries
      ?.mapNotNull { (k, v) -> if (k is String && v is String) k to v else null }
      ?.toMap()
      ?: emptyMap()
  return ExternalSubtitleConfig(
    id = id,
    uri = cleanUri,
    label = label,
    language = language,
    mimeType = mimeType,
    headers = headers,
  )
}

/** Parses and deduplicates a JS external subtitle list by track ID and URI (`#308`). */
internal fun parseExternalSubtitleConfigs(raw: Any?): List<ExternalSubtitleConfig> {
  val list = raw as? List<*> ?: return emptyList()
  if (list.isEmpty()) return emptyList()
  val out = ArrayList<ExternalSubtitleConfig>(list.size)
  val seenIds = HashSet<String>()
  val seenUris = HashSet<String>()
  for (item in list) {
    val parsed = parseExternalSubtitleConfig(item) ?: continue
    if (!seenIds.add(parsed.trackId) || !seenUris.add(parsed.uri)) continue
    out.add(parsed)
  }
  return out
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
  /** External sidecar subtitle tracks attached with strictly isolated headers (#32, #308). */
  val externalSubtitles: List<ExternalSubtitleConfig> = emptyList(),
  /** Optional secondary subtitle track ID for simultaneous dual subtitles (#402). */
  val secondarySubtitleTrackId: String? = null,
  /** Optional live subtitle appearance style applied on load and reloads (#32). */
  val subtitleStyle: SubtitleStyleConfig? = null,
) {
  /** Names no URL and no header value: both may carry credentials. */
  override fun toString(): String {
    val dvSuffix = if (preferHevcOverDolbyVision) ", preferHevcOverDolbyVision=true" else ""
    val presetSuffix = if (bufferPreset != BufferPreset.AUTO) ", bufferPreset=${bufferPreset.wireName}" else ""
    val decoderSuffix = if (decoderMode != VideoDecoderMode.AUTO) ", decoderMode=${decoderMode.wireName}" else ""
    val sdhSuffix = if (filterSdhSubtitles) ", filterSdhSubtitles=true" else ""
    val tlsSuffix = if (allowLegacyTls) ", allowLegacyTls=true" else ""
    val extSuffix = if (externalSubtitles.isNotEmpty()) ", externalSubtitles=${externalSubtitles.size}" else ""
    return "LoadRequest(live=$live, startMs=$startMs, softwareAudio=$softwareAudio, " +
      "playlistDetected=$playlistDetected, headers=${headers.size}$dvSuffix$presetSuffix$decoderSuffix$sdhSuffix$tlsSuffix$extSuffix)"
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
  val externalSubtitles = parseExternalSubtitleConfigs(args["externalSubtitles"])
  val secondarySubtitleTrackId = (args["secondarySubtitleTrackId"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
  val subtitleStyle = SubtitleStyleMapper.parse(args["subtitleStyle"])
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
    externalSubtitles = externalSubtitles,
    secondarySubtitleTrackId = secondarySubtitleTrackId,
    subtitleStyle = subtitleStyle,
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

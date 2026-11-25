package io.github.fatihmutluu.elv.media3

import androidx.media3.common.MimeTypes
import java.io.ByteArrayOutputStream
import java.nio.charset.StandardCharsets
import java.util.Locale
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal const val MAX_EXTERNAL_SUBTITLE_URI_LENGTH = 4_096
internal const val EXTERNAL_SUBTITLE_ID_PREFIX = "ext:"

internal val ALLOWED_LOCAL_SUBTITLE_EXTENSIONS = setOf(
  "srt",
  "vtt",
  "webvtt",
  "ass",
  "ssa",
  "ttml",
  "dfxp",
  "sub",
  "xml",
)

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

/** True only when [path] ends with an allowlisted subtitle file extension (case-insensitive). */
internal fun hasAllowedLocalSubtitleExtension(path: String): Boolean {
  if (path.isEmpty() || path.endsWith('/') || path.endsWith('\\')) return false
  val lastSep = maxOf(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  val fileName = if (lastSep < 0) path else path.substring(lastSep + 1)
  val dot = fileName.lastIndexOf('.')
  if (dot <= 0 || dot + 1 >= fileName.length) return false
  val ext = fileName.substring(dot + 1).lowercase(Locale.ROOT)
  return ext in ALLOWED_LOCAL_SUBTITLE_EXTENSIONS
}

private fun hexDigit(c: Char): Int = when (c) {
  in '0'..'9' -> c - '0'
  in 'a'..'f' -> c - 'a' + 10
  in 'A'..'F' -> c - 'A' + 10
  else -> -1
}

private fun percentDecodeUtf8(raw: String): String? {
  if ('%' !in raw) return raw
  val bytes = ByteArrayOutputStream(raw.length)
  var i = 0
  while (i < raw.length) {
    val c = raw[i]
    if (c == '%') {
      if (i + 2 >= raw.length) return null
      val hi = hexDigit(raw[i + 1])
      val lo = hexDigit(raw[i + 2])
      if (hi < 0 || lo < 0) return null
      bytes.write((hi shl 4) or lo)
      i += 3
    } else {
      val chunk = c.toString().toByteArray(StandardCharsets.UTF_8)
      bytes.write(chunk)
      i += 1
    }
  }
  return String(bytes.toByteArray(), StandardCharsets.UTF_8)
}

private fun isWindowsLocalDrivePath(s: String): Boolean {
  if (s.length < 3 || !((s[0] in 'A'..'Z') || (s[0] in 'a'..'z'))) return false
  if (s[1] == ':' && (s[2] == '/' || s[2] == '\\')) return true
  return s.length >= 5 &&
    s[1] == '%' &&
    s[2] == '3' &&
    (s[3] == 'a' || s[3] == 'A') &&
    (s[4] == '/' || s[4] == '\\' || s.startsWith("%5C", startIndex = 4, ignoreCase = true) || s.startsWith("%2F", startIndex = 4, ignoreCase = true))
}

private fun isAllowedLocalSubtitleFileUri(trimmed: String): Boolean {
  val afterScheme = trimmed.substring(7)
  val rawPath = when {
    afterScheme.startsWith('/') -> afterScheme
    afterScheme.startsWith("localhost/", ignoreCase = true) -> afterScheme.substring("localhost".length)
    isWindowsLocalDrivePath(afterScheme) -> afterScheme
    else -> return false
  }
  if (rawPath.isEmpty() || '?' in rawPath || '#' in rawPath) return false
  val decoded = percentDecodeUtf8(rawPath) ?: return false
  if (decoded.isEmpty() || decoded.any { it.code <= 0x1f || it.code == 0x7f }) return false
  if (decoded.split('/', '\\').any { it == ".." }) return false
  return hasAllowedLocalSubtitleExtension(decoded)
}

/**
 * Returns `true` only when [uri] is a bounded (`<= 4096` chars), control-char-free external subtitle URI using
 * an allowlisted scheme (`http://`, `https://`, `file://`, or `content://`) (`#308`).
 * Local `file://` URIs additionally reject `..` path traversal, query/fragment spoofing, remote authorities, and
 * non-allowlisted file extensions.
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
    "file" -> isAllowedLocalSubtitleFileUri(trimmed)
    "content" -> trimmed.substring(schemeEnd + 3).trim().isNotEmpty()
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

/** Parses a wire DNS IP family preference (case-insensitive, trimmed), falling back to [DnsFamilyPreference.SYSTEM] (#172). */
internal fun parseDnsFamilyPreference(raw: String?): DnsFamilyPreference =
  when (raw?.trim()?.lowercase(Locale.ROOT)) {
    DnsFamilyPreference.IPV4.wireName -> DnsFamilyPreference.IPV4
    DnsFamilyPreference.IPV6.wireName -> DnsFamilyPreference.IPV6
    else -> DnsFamilyPreference.SYSTEM
  }

/** Strict syntactic IPv4 literal check (`0.0.0.0`–`255.255.255.255`, no leading zeros or ports) (#172). */
internal fun isValidIpv4Literal(raw: String): Boolean {
  if (raw.length !in 7..15) return false
  val parts = raw.split('.')
  if (parts.size != 4) return false
  for (part in parts) {
    if (part.isEmpty() || part.length > 3) return false
    if (part.length > 1 && part[0] == '0') return false
    var value = 0
    for (c in part) {
      if (c !in '0'..'9') return false
      value = value * 10 + (c - '0')
    }
    if (value > 255) return false
  }
  return true
}

/**
 * Strict syntactic IPv6 literal check supporting compressed `::` and IPv4-mapped tails;
 * rejects zone IDs (`%eth0`), ports, schemes, spaces, and control characters (#172).
 */
internal fun isValidIpv6Literal(raw: String): Boolean {
  if (raw.length !in 2..45) return false
  if (':' !in raw) return false
  if ('%' in raw || '/' in raw || ' ' in raw) return false
  val dblIdx = raw.indexOf("::")
  if (dblIdx >= 0 && raw.indexOf("::", dblIdx + 2) >= 0) return false

  fun parseSide(segment: String, allowIpv4Tail: Boolean): Int? {
    if (segment.isEmpty()) return 0
    val parts = segment.split(':')
    var groups = 0
    for (i in parts.indices) {
      val part = parts[i]
      if (part.isEmpty()) return null
      if (allowIpv4Tail && i == parts.lastIndex && '.' in part) {
        if (!isValidIpv4Literal(part)) return null
        groups += 2
      } else if (part.length in 1..4 && part.all { it in '0'..'9' || it in 'a'..'f' || it in 'A'..'F' }) {
        groups += 1
      } else {
        return null
      }
    }
    return groups
  }

  if (dblIdx >= 0) {
    val left = parseSide(raw.substring(0, dblIdx), allowIpv4Tail = false) ?: return false
    val right = parseSide(raw.substring(dblIdx + 2), allowIpv4Tail = true) ?: return false
    return left + right <= 7
  }
  return parseSide(raw, allowIpv4Tail = true) == 8
}

/**
 * Validates and normalizes an optional per-source literal IP host override (#172).
 * Accepts strict IPv4 or IPv6 literals (unbracketing optional IPv6 `[...]` and lowercasing hex digits),
 * and rejects hostnames, ports, schemes, paths, zone IDs, and control characters.
 */
internal fun parseHostOverride(raw: Any?): String? {
  val text = raw as? String ?: return null
  if (text.any { it.code < 0x20 || it.code == 0x7f }) return null
  val trimmed = text.trim()
  if (trimmed.isEmpty()) return null
  if (isValidIpv4Literal(trimmed)) return trimmed
  val unbracketed =
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) trimmed.substring(1, trimmed.length - 1) else trimmed
  return if (isValidIpv6Literal(unbracketed)) unbracketed.lowercase(Locale.ROOT) else null
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
  /** Per-source DNS address-family preference (#172). */
  val dnsFamily: DnsFamilyPreference = DnsFamilyPreference.SYSTEM,
  /** Optional validated literal IP host override scoped strictly to the initial request origin (#172). */
  val hostOverride: String? = null,
  /** External sidecar subtitle tracks attached with strictly isolated headers (#32, #308). */
  val externalSubtitles: List<ExternalSubtitleConfig> = emptyList(),
  /** Optional secondary subtitle track ID for simultaneous dual subtitles (#402). */
  val secondarySubtitleTrackId: String? = null,
  /** Optional live subtitle appearance style applied on load and reloads (#32). */
  val subtitleStyle: SubtitleStyleConfig? = null,
  /** Optional play-time DRM configuration (`clearkey` / `widevine` / `playready`, #272). Never logged. */
  val drm: ParsedDrmConfig? = null,
  /** Optional auto frame-rate policy forwarded on load (`#116`). */
  val autoFrameRate: AutoFrameRateMode? = null,
  /** Optional Night-Mode DRC preset forwarded on load (`#115`). */
  val nightModeDrc: NightModeDrcPreset? = null,
  /** Optional per-refresh-rate A/V delay offsets forwarded on load (`#115`). */
  val audioDelayByRefreshRateMs: Map<String, Long>? = null,
) {
  /** Names no URL, no host override IP, no DRM secrets, and no header value: each may carry credentials or provider info. */
  override fun toString(): String {
    val dvSuffix = if (preferHevcOverDolbyVision) ", preferHevcOverDolbyVision=true" else ""
    val presetSuffix = if (bufferPreset != BufferPreset.AUTO) ", bufferPreset=${bufferPreset.wireName}" else ""
    val decoderSuffix = if (decoderMode != VideoDecoderMode.AUTO) ", decoderMode=${decoderMode.wireName}" else ""
    val sdhSuffix = if (filterSdhSubtitles) ", filterSdhSubtitles=true" else ""
    val tlsSuffix = if (allowLegacyTls) ", allowLegacyTls=true" else ""
    val dnsSuffix = if (dnsFamily != DnsFamilyPreference.SYSTEM) ", dnsFamily=${dnsFamily.wireName}" else ""
    val overrideSuffix = if (hostOverride != null) ", hostOverride=set" else ""
    val extSuffix = if (externalSubtitles.isNotEmpty()) ", externalSubtitles=${externalSubtitles.size}" else ""
    val drmSuffix = if (drm != null) ", drm=${drm.scheme.wireName}" else ""
    return "LoadRequest(live=$live, startMs=$startMs, softwareAudio=$softwareAudio, " +
      "playlistDetected=$playlistDetected, headers=${headers.size}$dvSuffix$presetSuffix$decoderSuffix" +
      "$sdhSuffix$tlsSuffix$dnsSuffix$overrideSuffix$extSuffix$drmSuffix)"
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
  val dnsFamily = parseDnsFamilyPreference(args["dnsFamily"] as? String)
  val hostOverride = parseHostOverride(args["hostOverride"])
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
  val drm = parseDrmConfig(args["drm"])
  val displaySyncMap = args["displaySync"] as? Map<*, *>
  val rawAutoFrameRate = (args["autoFrameRate"] as? String) ?: (displaySyncMap?.get("autoFrameRate") as? String)
  val autoFrameRate = rawAutoFrameRate?.let { parseAutoFrameRateMode(it) }
  val nightModeDrc = (args["nightModeDrc"] as? String)?.let(::parseNightModeDrcPreset)
  val audioDelayByRefreshRateMs =
    if (args.containsKey("audioDelayByRefreshRateMs")) parseAudioDelayByRefreshRate(args["audioDelayByRefreshRateMs"]) else null
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
    dnsFamily = dnsFamily,
    hostOverride = hostOverride,
    externalSubtitles = externalSubtitles,
    secondarySubtitleTrackId = secondarySubtitleTrackId,
    subtitleStyle = subtitleStyle,
    drm = drm,
    autoFrameRate = autoFrameRate,
    nightModeDrc = nightModeDrc,
    audioDelayByRefreshRateMs = audioDelayByRefreshRateMs,
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

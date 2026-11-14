package io.github.fatihmutluu.elv.media3

import androidx.media3.common.PlaybackException

private val NAMED_STATUSES = setOf(401, 403, 404, 429, 509)

/**
 * Maps a failure to one of the engine error codes of player core spec 5.3. [responseCode] is the HTTP status of an
 * invalid response, [contentType] the rejected content type of a notice body, [playbackErrorCode] the Media3
 * `PlaybackException.errorCode`. An HTTP error status wins over the body; a text or HTML body on a successful stream
 * response is the provider's connection notice. Malformed media (a garbage segment, a truncated playlist refresh) is
 * `network` for [live] media and for VOD that [played] since its last prepare, so the ladder retries it; malformed
 * VOD that never played and unsupported containers or manifests stay `unsupported-format`.
 */
fun mapError(
  responseCode: Int?,
  contentType: String?,
  playbackErrorCode: Int,
  live: Boolean = false,
  played: Boolean = false,
): String {
  if (responseCode != null && responseCode !in 200..299) {
    return if (responseCode in NAMED_STATUSES) "http-$responseCode" else "http-other"
  }
  if (contentType != null && isNoticeContentType(contentType, hls = false)) return "connection-limit"
  return when (playbackErrorCode) {
    PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE -> "connection-limit"
    PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS -> "http-other"
    PlaybackException.ERROR_CODE_TIMEOUT -> "engine-wedged"
    PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW -> "network"
    PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED,
    PlaybackException.ERROR_CODE_PARSING_MANIFEST_MALFORMED,
    -> if (live || played) "network" else "unsupported-format"
    in 2000..2999 -> "network"
    in 3000..3999 -> "unsupported-format"
    in 4000..5999, in 7000..7999 -> "decoder"
    in 6000..6999 -> "drm"
    else -> "unknown"
  }
}

/**
 * True when a stream response's content type is a provider notice rather than media. HTML, XHTML and JSON are never
 * media; any other `text/` type is a notice on progressive streams, while HLS accepts plain-text playlists.
 */
fun isNoticeContentType(contentType: String?, hls: Boolean): Boolean {
  val type = contentType?.substringBefore(';')?.trim()?.lowercase() ?: return false
  if (type == "text/html" || type == "application/xhtml+xml" || type == "application/json") return true
  return !hls && type.startsWith("text/")
}

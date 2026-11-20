package io.github.fatihmutluu.elv.media3

private const val MASK = "***"

private val SAFE_EXTENSIONS = setOf(
  "ts",
  "m2ts",
  "mts",
  "m3u8",
  "m3u",
  "mp4",
  "m4s",
  "m4v",
  "m4a",
  "mkv",
  "webm",
  "avi",
  "mov",
  "flv",
  "mpd",
  "aac",
  "mp3",
  "ac3",
  "eac3",
  "ogg",
  "opus",
  "wav",
  "flac",
  "srt",
  "vtt",
  "ass",
  "ssa",
  "sub",
  "xml",
  "gz",
  "php",
)

/**
 * Returns [url] safe for diagnostics via strict allowlist redaction: keeps only scheme, host(:port) and a known
 * media/playlist extension on the final non-empty path segment, masking all path segments, matrix params, user-info,
 * queries and fragments.
 */
fun redactUrl(url: String): String {
  if (url.isEmpty()) return ""
  val withoutTail = url.substringBefore('#').substringBefore('?')
  val schemeEnd = withoutTail.indexOf("://")
  val (origin, path) = if (schemeEnd < 0) {
    "" to withoutTail
  } else {
    val authorityStart = schemeEnd + 3
    val pathStart = withoutTail.indexOf('/', authorityStart).let { if (it < 0) withoutTail.length else it }
    val authority = withoutTail.substring(authorityStart, pathStart).substringAfterLast('@')
    withoutTail.substring(0, authorityStart) + authority to withoutTail.substring(pathStart)
  }
  return origin + redactPath(path)
}

private fun redactPath(path: String): String {
  if (path.isEmpty() || path == "/") return path
  val leadingSlash = path.startsWith("/")
  val rawSegments = (if (leadingSlash) path.substring(1) else path).split('/')
  val lastNonEmpty = rawSegments.indexOfLast { it.isNotEmpty() }
  val masked = rawSegments.mapIndexed { index, segment ->
    if (segment.isEmpty()) {
      ""
    } else if (index != lastNonEmpty) {
      MASK
    } else {
      val clean = segment.substringBefore(';')
      val dot = clean.lastIndexOf('.')
      val ext = if (dot > 0) clean.substring(dot + 1).lowercase() else ""
      if (ext in SAFE_EXTENSIONS) "$MASK.$ext" else MASK
    }
  }
  return (if (leadingSlash) "/" else "") + masked.joinToString("/")
}

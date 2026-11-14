package io.github.fatihmutluu.elv.media3

private val CREDENTIAL_MARKERS = setOf("live", "movie", "series", "timeshift")
private const val TOKEN_MARKER = "play"
private val BARE_ID = Regex("""\d+(\.[A-Za-z0-9]+)?""")
private const val MASK = "***"

/**
 * Returns [url] safe for diagnostics: no query, fragment or user-info; the user and password segments after `/live/`,
 * `/movie/`, `/series/` and `/timeshift/` and the token after `/play/` replaced by `***`. Without such a marker, the
 * Xtream form `/<user>/<pass>/<id>` (the two segments before a numeric last segment, also behind a path prefix) is
 * masked the same way.
 */
fun redactUrl(url: String): String {
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
  val segments = path.split('/').toMutableList()
  var marked = false
  var index = 0
  while (index < segments.size) {
    val masked = when (segments[index].lowercase()) {
      in CREDENTIAL_MARKERS -> 2
      TOKEN_MARKER -> 1
      else -> 0
    }
    if (masked > 0) marked = true
    for (offset in 1..masked) {
      if (index + offset < segments.size && segments[index + offset].isNotEmpty()) segments[index + offset] = MASK
    }
    index += 1 + masked
  }
  if (!marked) maskBareXtream(segments)
  return segments.joinToString("/")
}

private fun maskBareXtream(segments: MutableList<String>) {
  val named = segments.indices.filter { segments[it].isNotEmpty() }
  if (named.size < 3 || !BARE_ID.matches(segments[named.last()])) return
  segments[named[named.size - 2]] = MASK
  segments[named[named.size - 3]] = MASK
}

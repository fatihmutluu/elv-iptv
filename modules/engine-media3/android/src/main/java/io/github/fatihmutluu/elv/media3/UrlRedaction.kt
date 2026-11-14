package io.github.fatihmutluu.elv.media3

private val CREDENTIAL_MARKERS = setOf("live", "movie", "series", "timeshift")
private val BARE_ID = Regex("""\d+(\.[A-Za-z0-9]+)?""")
private const val MASK = "***"

/**
 * Returns [url] safe for diagnostics: no query, fragment or user-info, and the user and password segments after
 * `/live/`, `/movie/`, `/series/` and `/timeshift/` replaced by `***`. The bare Xtream form `/<user>/<pass>/<id>`
 * (three segments ending in a numeric id) is masked the same way.
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
  val named = segments.filter { it.isNotEmpty() }
  if (named.size == 3 && segments.first().isEmpty() && named.none { it.lowercase() in CREDENTIAL_MARKERS } &&
    BARE_ID.matches(named[2])
  ) {
    segments[1] = MASK
    segments[2] = MASK
    return segments.joinToString("/")
  }
  var index = 0
  while (index < segments.size) {
    if (segments[index].lowercase() in CREDENTIAL_MARKERS) {
      for (offset in 1..2) {
        if (index + offset < segments.size && segments[index + offset].isNotEmpty()) segments[index + offset] = MASK
      }
      index += 3
    } else {
      index += 1
    }
  }
  return segments.joinToString("/")
}

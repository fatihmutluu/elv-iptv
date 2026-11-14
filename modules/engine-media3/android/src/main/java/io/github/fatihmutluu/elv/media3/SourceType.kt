package io.github.fatihmutluu.elv.media3

/** How the engine builds the media source: the HLS module, the TS extractor alone, or container sniffing. */
enum class SourceType { HLS, TS, PROGRESSIVE }

private val HLS_EXTENSIONS = setOf("m3u8", "m3u")
private val TS_EXTENSIONS = setOf("ts", "mts", "m2ts")

/**
 * Picks the source type from the last path segment's extension: `m3u8`/`m3u` is HLS, `ts` is MPEG-TS, any other
 * extension sniffs the container. Without an extension live URLs are MPEG-TS (the Xtream default) and VOD sniffs.
 */
fun sourceTypeFor(url: String, live: Boolean): SourceType {
  val withoutTail = url.substringBefore('#').substringBefore('?')
  val schemeEnd = withoutTail.indexOf("://")
  val path = if (schemeEnd < 0) {
    withoutTail
  } else {
    withoutTail.indexOf('/', schemeEnd + 3).let { if (it < 0) "" else withoutTail.substring(it) }
  }
  val last = path.trimEnd('/').substringAfterLast('/')
  val extension = if ('.' in last) last.substringAfterLast('.').lowercase() else ""
  return when {
    extension in HLS_EXTENSIONS -> SourceType.HLS
    extension in TS_EXTENSIONS -> SourceType.TS
    extension.isEmpty() && live -> SourceType.TS
    else -> SourceType.PROGRESSIVE
  }
}

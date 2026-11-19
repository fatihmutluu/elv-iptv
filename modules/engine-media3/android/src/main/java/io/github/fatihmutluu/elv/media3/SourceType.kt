package io.github.fatihmutluu.elv.media3

/** How the engine builds the media source: the HLS module, the TS extractor alone, or container sniffing. */
enum class SourceType { HLS, TS, PROGRESSIVE }

private const val MAX_REMEMBERED_HLS_URLS = 256
private val HLS_EXTENSIONS = setOf("m3u8", "m3u")
private val TS_EXTENSIONS = setOf("ts", "mts", "m2ts")
private val LIVE_PROGRESSIVE_EXTENSIONS = setOf(
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "webm",
  "avi",
  "mp3",
  "aac",
  "ac3",
  "eac3",
  "flac",
  "ogg",
  "opus",
  "wav",
)

private val rememberedHlsUrls = object : LinkedHashMap<String, Boolean>(32, 0.75f, true) {
  override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Boolean>?): Boolean =
    size > MAX_REMEMBERED_HLS_URLS
}

private fun cacheKeyOf(url: String): String = url.substringBefore('#')

/** Records in memory that [url] answered an earlier progressive guess with an `#EXTM3U` playlist (#122). */
internal fun rememberHlsUrl(url: String) {
  val key = cacheKeyOf(url)
  if (key.isEmpty()) return
  synchronized(rememberedHlsUrls) {
    rememberedHlsUrls[key] = true
  }
}

private fun isRememberedHlsUrl(url: String): Boolean =
  synchronized(rememberedHlsUrls) { rememberedHlsUrls[cacheKeyOf(url)] == true }

internal fun resetHlsUrlCacheForTest() {
  synchronized(rememberedHlsUrls) { rememberedHlsUrls.clear() }
}

/**
 * Picks the source type from the last path segment's extension: `m3u8`/`m3u` is HLS, `ts`/`mts`/`m2ts` is MPEG-TS.
 * On [live] streams, only known progressive containers (`mp4`, `mkv`, `aac`, etc.) sniff the container while unknown
 * extensions (`.one`, `.hd`, `.php`) and extensionless paths default to MPEG-TS so dotted channel slugs or scripts
 * never false-sniff audio PES frames as MP3/ADTS. [playlistDetected] or a cached HLS discovery makes any URL HLS.
 */
fun sourceTypeFor(url: String, live: Boolean, playlistDetected: Boolean = false): SourceType {
  if (playlistDetected || isRememberedHlsUrl(url)) return SourceType.HLS
  val withoutTail = url.substringBefore('#').substringBefore('?')
  val schemeEnd = withoutTail.indexOf("://")
  val path = if (schemeEnd < 0) {
    withoutTail
  } else {
    withoutTail.indexOf('/', schemeEnd + 3).let { if (it < 0) "" else withoutTail.substring(it) }
  }
  val last = path.trimEnd('/').substringAfterLast('/').substringBefore(';')
  val extension = if ('.' in last) last.substringAfterLast('.').lowercase() else ""
  return when {
    extension in HLS_EXTENSIONS -> SourceType.HLS
    extension in TS_EXTENSIONS -> SourceType.TS
    live -> if (extension in LIVE_PROGRESSIVE_EXTENSIONS) SourceType.PROGRESSIVE else SourceType.TS
    else -> SourceType.PROGRESSIVE
  }
}

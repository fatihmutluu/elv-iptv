package io.github.fatihmutluu.elv.media3

import androidx.media3.common.C

/** What a response is: [MEDIA] goes to the player as it is, [HLS] is a playlist, [NOTICE] the provider's notice. */
enum class ResponseKind { MEDIA, HLS, NOTICE }

/**
 * Which request a response answers: a progressive stream (TS or a container file), an HLS playlist, an HLS media
 * segment (also init segments and WebVTT subtitles), or anything else (keys, steering), which is never judged.
 */
enum class RequestKind { PROGRESSIVE, MANIFEST, SEGMENT, OTHER }

/** Bytes read ahead of the player before a response is judged; the extractor needs the first chunk anyway. */
const val SNIFF_BYTES = 1024

private const val TS_PACKET = 188
private const val TS_SYNC: Byte = 0x47

private val HLS_TYPES =
  setOf("application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl")
private val EXTM3U = "#EXTM3U".toByteArray(Charsets.US_ASCII)
private val WEBVTT = "WEBVTT".toByteArray(Charsets.US_ASCII)
private val XML_DECL = "<?xml".toByteArray(Charsets.US_ASCII)
private val TTML_ROOT = "<tt".toByteArray(Charsets.US_ASCII)
private val UTF8_BOM = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
private val SRT_CUE =
  Regex("""^(?:\d+\r?\n)?\d{1,3}:\d{2}:\d{2}[,.]\d{3}[ \t]*-->[ \t]*\d{1,3}:\d{2}:\d{2}[,.]\d{3}""")

/** The `Content-Type` value of response [headers] (any key case; the status line's null key is skipped). */
fun contentTypeOf(headers: Map<out String?, List<String>>): String? =
  headers.entries.firstOrNull { it.key?.equals("Content-Type", ignoreCase = true) == true }?.value?.firstOrNull()

/** True when response [headers] carry a `Content-Range` header (an HTTP 206 byte-range slice). */
internal fun hasContentRange(headers: Map<out String?, List<String>>): Boolean =
  headers.entries.any { it.key?.equals("Content-Range", ignoreCase = true) == true && it.value.isNotEmpty() }

/** True for the HLS playlist media types. */
fun isHlsContentType(contentType: String?): Boolean {
  val type = contentType?.substringBefore(';')?.trim()?.lowercase() ?: return false
  return type in HLS_TYPES
}

/** The kind of an HLS request from its Media3 data type; keys (DRM) and the rest are [RequestKind.OTHER]. */
fun requestKindFor(dataType: Int): RequestKind =
  when (dataType) {
    C.DATA_TYPE_MANIFEST -> RequestKind.MANIFEST
    C.DATA_TYPE_MEDIA, C.DATA_TYPE_MEDIA_INITIALIZATION -> RequestKind.SEGMENT
    else -> RequestKind.OTHER
  }

/**
 * Judges a response of [kind] by its first [length] bytes of [prefix]; labels are not trusted, except that an mpegurl
 * label on a progressive guess is a playlist. Progressive: an `#EXTM3U` body is a playlist; readable text that is no
 * MPEG-TS is the notice; anything else (binary, empty) is media. Manifest: a body without `#EXTM3U` that reads as
 * text is the notice; empty or binary bodies are left to the playlist parser. Segment: readable text that is neither
 * WebVTT nor MPEG-TS is the notice. Other requests are never judged.
 */
fun classifyResponse(kind: RequestKind, contentType: String?, prefix: ByteArray, length: Int): ResponseKind {
  val text = length > 0 && isText(prefix, length) && !hasTsSync(prefix, length)
  return when (kind) {
    RequestKind.OTHER -> ResponseKind.MEDIA
    RequestKind.PROGRESSIVE -> when {
      isHlsContentType(contentType) || startsWith(prefix, length, EXTM3U) -> ResponseKind.HLS
      text -> ResponseKind.NOTICE
      else -> ResponseKind.MEDIA
    }
    RequestKind.MANIFEST -> when {
      startsWith(prefix, length, EXTM3U) -> ResponseKind.HLS
      text -> ResponseKind.NOTICE
      else -> ResponseKind.MEDIA
    }
    RequestKind.SEGMENT ->
      if (text && !isSubtitleSegment(contentType, prefix, length)) ResponseKind.NOTICE else ResponseKind.MEDIA
  }
}

/** True when a readable text segment is WebVTT, TTML/XML subtitles (excluding HTML/XHTML) or SubRip cues. */
private fun isSubtitleSegment(contentType: String?, prefix: ByteArray, length: Int): Boolean {
  if (startsWith(prefix, length, WEBVTT)) return true
  val start = textStart(prefix, length)
  if (length - start >= TTML_ROOT.size && TTML_ROOT.indices.all { prefix[start + it] == TTML_ROOT[it] }) {
    val after = if (start + TTML_ROOT.size < length) prefix[start + TTML_ROOT.size].toInt().toChar() else '>'
    if (after in " \t\r\n>:/") return true
  }
  val ascii = String(prefix, start, length - start, Charsets.ISO_8859_1)
  if (startsWith(prefix, length, XML_DECL)) {
    val type = contentType?.substringBefore(';')?.trim()?.lowercase()
    val htmlType = type == "text/html" || type == "application/xhtml+xml"
    val lower = ascii.lowercase()
    if (!htmlType && !lower.contains("<!doctype html") && !lower.contains("<html")) return true
  }
  return SRT_CUE.containsMatchIn(ascii)
}

private fun textStart(prefix: ByteArray, length: Int): Int {
  var start = if (length >= UTF8_BOM.size && UTF8_BOM.indices.all { prefix[it] == UTF8_BOM[it] }) UTF8_BOM.size else 0
  while (start < length && prefix[start].toInt().toChar() in " \t\r\n") start += 1
  return start
}

/** True when the text after an optional UTF-8 byte order mark and blank space starts with [marker]. */
private fun startsWith(prefix: ByteArray, length: Int, marker: ByteArray): Boolean {
  val start = textStart(prefix, length)
  if (length - start < marker.size) return false
  return marker.indices.all { prefix[start + it] == marker[it] }
}

/**
 * MPEG-TS from any start offset: a sync byte repeating every 188 bytes, three times when the prefix holds three
 * packets (two otherwise), starting within the first packet.
 */
private fun hasTsSync(prefix: ByteArray, length: Int): Boolean =
  (0 until minOf(TS_PACKET, length - TS_PACKET).coerceAtLeast(0)).any { start ->
    val positions = generateSequence(start) { it + TS_PACKET }.takeWhile { it < length }.take(3).toList()
    positions.size >= 2 && positions.all { prefix[it] == TS_SYNC }
  }

/**
 * Valid UTF-8 printable text (RFC 3629): printable ASCII, tab, CR, LF, or well-formed multi-byte UTF-8 sequences. A
 * multi-byte sequence truncated right at [SNIFF_BYTES] is accepted when its present bytes are valid.
 */
private fun isText(prefix: ByteArray, length: Int): Boolean {
  var i = 0
  while (i < length) {
    val b0 = prefix[i].toInt() and 0xFF
    when {
      b0 == 0x09 || b0 == 0x0A || b0 == 0x0D || b0 in 0x20..0x7E -> i += 1
      b0 in 0xC2..0xDF -> {
        if (!checkContinuations(prefix, length, i + 1, 1, 0x80..0xBF)) return false
        i += 2
      }
      b0 == 0xE0 -> {
        if (!checkContinuations(prefix, length, i + 1, 2, 0xA0..0xBF)) return false
        i += 3
      }
      b0 in 0xE1..0xEC || b0 in 0xEE..0xEF -> {
        if (!checkContinuations(prefix, length, i + 1, 2, 0x80..0xBF)) return false
        i += 3
      }
      b0 == 0xED -> {
        if (!checkContinuations(prefix, length, i + 1, 2, 0x80..0x9F)) return false
        i += 3
      }
      b0 == 0xF0 -> {
        if (!checkContinuations(prefix, length, i + 1, 3, 0x90..0xBF)) return false
        i += 4
      }
      b0 in 0xF1..0xF3 -> {
        if (!checkContinuations(prefix, length, i + 1, 3, 0x80..0xBF)) return false
        i += 4
      }
      b0 == 0xF4 -> {
        if (!checkContinuations(prefix, length, i + 1, 3, 0x80..0x8F)) return false
        i += 4
      }
      else -> return false
    }
  }
  return true
}

private fun checkContinuations(
  prefix: ByteArray,
  length: Int,
  start: Int,
  count: Int,
  firstRange: IntRange,
): Boolean {
  if (start + count > length && length < SNIFF_BYTES) return false
  val end = minOf(start + count, length)
  for (idx in start until end) {
    val b = prefix[idx].toInt() and 0xFF
    val allowed = if (idx == start) firstRange else 0x80..0xBF
    if (b !in allowed) return false
  }
  return true
}

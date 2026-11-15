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
private val UTF8_BOM = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())

/** The `Content-Type` value of response [headers] (any key case; the status line's null key is skipped). */
fun contentTypeOf(headers: Map<out String?, List<String>>): String? =
  headers.entries.firstOrNull { it.key?.equals("Content-Type", ignoreCase = true) == true }?.value?.firstOrNull()

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
    RequestKind.SEGMENT -> if (text && !startsWith(prefix, length, WEBVTT)) ResponseKind.NOTICE else ResponseKind.MEDIA
  }
}

/** True when the text after an optional UTF-8 byte order mark and blank space starts with [marker]. */
private fun startsWith(prefix: ByteArray, length: Int, marker: ByteArray): Boolean {
  var start = if (length >= UTF8_BOM.size && UTF8_BOM.indices.all { prefix[it] == UTF8_BOM[it] }) UTF8_BOM.size else 0
  while (start < length && prefix[start].toInt().toChar() in " \t\r\n") start += 1
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

/** Printable ASCII, tab, CR, LF or UTF-8 bytes only; any other control byte means binary. */
private fun isText(prefix: ByteArray, length: Int): Boolean =
  (0 until length).all {
    val byte = prefix[it].toInt() and 0xFF
    byte >= 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D
  }

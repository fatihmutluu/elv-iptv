package io.github.fatihmutluu.elv.media3

/** What a stream response really is, judged by its content type and, under a text label, its first bytes. */
enum class ResponseKind { MEDIA, HLS, NOTICE }

/** Bytes read from a text-labelled response before it is judged; notices are short, media is binary at once. */
const val SNIFF_BYTES = 1024

private val HLS_TYPES =
  setOf("application/vnd.apple.mpegurl", "application/x-mpegurl", "audio/mpegurl", "audio/x-mpegurl")
private val EXTM3U = "#EXTM3U".toByteArray(Charsets.US_ASCII)
private val UTF8_BOM = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())

/** The `Content-Type` value of response [headers] (any key case; the status line's null key is skipped). */
fun contentTypeOf(headers: Map<out String?, List<String>>): String? =
  headers.entries.firstOrNull { it.key?.equals("Content-Type", ignoreCase = true) == true }?.value?.firstOrNull()

/** True for the HLS playlist media types. */
fun isHlsContentType(contentType: String?): Boolean {
  val type = contentType?.substringBefore(';')?.trim()?.lowercase() ?: return false
  return type in HLS_TYPES
}

/**
 * Judges a response. An mpegurl content type is HLS; a non-text content type (or none) is media, unread. Under a text,
 * HTML or JSON label the first [length] bytes of [prefix] decide: an `#EXTM3U` header is HLS, a binary body (MPEG-TS
 * sync bytes, MP4 boxes, ...) is media mislabelled by the server, readable text is the provider's notice, and an
 * empty body is left to the player.
 */
fun classifyResponse(contentType: String?, prefix: ByteArray, length: Int): ResponseKind {
  if (isHlsContentType(contentType)) return ResponseKind.HLS
  if (!isNoticeContentType(contentType, hls = false)) return ResponseKind.MEDIA
  return when {
    startsWithExtM3u(prefix, length) -> ResponseKind.HLS
    length == 0 || !isText(prefix, length) -> ResponseKind.MEDIA
    else -> ResponseKind.NOTICE
  }
}

/** True when a playlist response is readable text without the `#EXTM3U` header: a notice, not a broken playlist. */
fun isPlaylistNotice(prefix: ByteArray, length: Int): Boolean =
  length > 0 && !startsWithExtM3u(prefix, length) && isText(prefix, length)

private fun startsWithExtM3u(prefix: ByteArray, length: Int): Boolean {
  var start = if (length >= UTF8_BOM.size && UTF8_BOM.indices.all { prefix[it] == UTF8_BOM[it] }) UTF8_BOM.size else 0
  while (start < length && prefix[start].toInt().toChar() in " \t\r\n") start += 1
  if (length - start < EXTM3U.size) return false
  return EXTM3U.indices.all { prefix[start + it] == EXTM3U[it] }
}

/** Printable ASCII, tab, CR, LF or UTF-8 bytes only; any other control byte means binary media. */
private fun isText(prefix: ByteArray, length: Int): Boolean =
  (0 until length).all {
    val byte = prefix[it].toInt() and 0xFF
    byte >= 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D
  }

package io.github.fatihmutluu.elv.xmltvnative

import java.nio.charset.StandardCharsets

/** Low-level UTF-8 byte-array XML tokenization helpers for [XmltvByteScanner]. */
internal object XmltvByteTokens {
  val BYTES_VALUE: ByteArray = "value".toByteArray(StandardCharsets.US_ASCII)

  fun indexOfByte(bytes: ByteArray, from: Int, to: Int, target: Byte): Int {
    for (i in from until to) {
      if (bytes[i] == target) return i
    }
    return -1
  }

  fun matchesAt(bytes: ByteArray, at: Int, limit: Int, needle: ByteArray): Boolean {
    if (at < 0 || at + needle.size > limit) return false
    for (i in needle.indices) {
      if (bytes[at + i] != needle[i]) return false
    }
    return true
  }

  fun isMarkupStart(b: Int): Boolean {
    return b == '/'.code || b == '!'.code || b == '?'.code ||
      (b in 'A'.code..'Z'.code) || (b in 'a'.code..'z'.code) || b == '_'.code || b == ':'.code || b >= 0x80
  }

  fun isNameStop(b: Int): Boolean {
    return b == ' '.code || b == '\t'.code || b == '\r'.code || b == '\n'.code ||
      b == '>'.code || b == '/'.code || b == '='.code
  }

  fun isWs(b: Byte): Boolean {
    return b == ' '.code.toByte() || b == '\t'.code.toByte() || b == '\r'.code.toByte() || b == '\n'.code.toByte()
  }

  fun nameEnd(bytes: ByteArray, from: Int, limit: Int): Int {
    var i = from
    while (i < limit && !isNameStop(bytes[i].toInt() and 0xFF)) i += 1
    return i
  }

  fun isTag(bytes: ByteArray, at: Int, len: Int, expected: ByteArray): Boolean {
    if (len != expected.size) return false
    for (i in expected.indices) {
      if (bytes[at + i] != expected[i]) return false
    }
    return true
  }

  /** Returns `1` if tag name equals `expected`, `0` if not, `-1` if more bytes are needed. */
  fun matchTagName(bytes: ByteArray, at: Int, limit: Int, expected: ByteArray): Int {
    val available = limit - at
    if (available <= 0) return -1
    val checkLen = minOf(expected.size, available)
    for (i in 0 until checkLen) {
      if (bytes[at + i] != expected[i]) return 0
    }
    if (available <= expected.size) return -1
    val after = bytes[at + expected.size].toInt() and 0xFF
    return if (after == ' '.code || after == '\t'.code || after == '\r'.code || after == '\n'.code ||
      after == '>'.code || after == '/'.code
    ) 1 else 0
  }

  /** Returns index past `>`, `-1` if incomplete, `-2` if broken (`<` inside unquoted tag). */
  fun findTagEnd(bytes: ByteArray, lt: Int, limit: Int): Int {
    var i = lt + 1
    var quote: Byte = 0
    while (i < limit) {
      val b = bytes[i]
      if (quote.toInt() != 0) {
        if (b == quote) quote = 0
      } else {
        if (b == '"'.code.toByte() || b == '\''.code.toByte()) quote = b
        else if (b == '>'.code.toByte()) return i + 1
        else if (b == '<'.code.toByte()) return -2
      }
      i += 1
    }
    return -1
  }

  /** Skips `<!--...-->`, `<![CDATA[...]]>`, `<!...>`, `<?...?>`; returns index past end or `-1`. */
  fun skipMarkup(bytes: ByteArray, lt: Int, limit: Int): Int {
    if (lt + 1 >= limit) return -1
    val b1 = bytes[lt + 1]
    if (b1 == '?'.code.toByte()) {
      var i = lt + 2
      while (i + 1 < limit) {
        if (bytes[i] == '?'.code.toByte() && bytes[i + 1] == '>'.code.toByte()) return i + 2
        i += 1
      }
      return -1
    }
    if (b1 == '!'.code.toByte()) {
      if (lt + 3 < limit && bytes[lt + 2] == '-'.code.toByte() && bytes[lt + 3] == '-'.code.toByte()) {
        var i = lt + 4
        while (i + 2 < limit) {
          if (bytes[i] == '-'.code.toByte() && bytes[i + 1] == '-'.code.toByte() && bytes[i + 2] == '>'.code.toByte()) {
            return i + 3
          }
          i += 1
        }
        return -1
      }
      if (lt + 8 < limit && isCdataStart(bytes, lt)) {
        var i = lt + 9
        while (i + 2 < limit) {
          if (bytes[i] == ']'.code.toByte() && bytes[i + 1] == ']'.code.toByte() && bytes[i + 2] == '>'.code.toByte()) {
            return i + 3
          }
          i += 1
        }
        return -1
      }
      if (lt + 8 >= limit) return -1
      var i = lt + 2
      var depth = 0
      var quote: Byte = 0
      while (i < limit) {
        val b = bytes[i]
        if (quote.toInt() != 0) {
          if (b == quote) quote = 0
        } else {
          if (b == '"'.code.toByte() || b == '\''.code.toByte()) quote = b
          else if (b == '['.code.toByte()) depth += 1
          else if (b == ']'.code.toByte() && depth > 0) depth -= 1
          else if (b == '>'.code.toByte() && depth == 0) return i + 1
        }
        i += 1
      }
      return -1
    }
    return lt + 1
  }

  private fun isCdataStart(bytes: ByteArray, lt: Int): Boolean {
    return bytes[lt + 2] == '['.code.toByte() &&
      bytes[lt + 3] == 'C'.code.toByte() &&
      bytes[lt + 4] == 'D'.code.toByte() &&
      bytes[lt + 5] == 'A'.code.toByte() &&
      bytes[lt + 6] == 'T'.code.toByte() &&
      bytes[lt + 7] == 'A'.code.toByte() &&
      bytes[lt + 8] == '['.code.toByte()
  }

  /** Finds `</name` starting at `from`. Returns `<` offset, `-1` if incomplete, `-2` if broken. */
  fun findCloseTag(
    bytes: ByteArray,
    from: Int,
    limit: Int,
    name: ByteArray,
    allowIncomplete: Boolean,
  ): Int {
    var pos = from
    while (pos < limit) {
      val lt = indexOfByte(bytes, pos, limit, '<'.code.toByte())
      if (lt < 0 || lt + 1 >= limit) return -1
      val b1 = bytes[lt + 1]
      if (b1 == '!'.code.toByte() || b1 == '?'.code.toByte()) {
        val skip = skipMarkup(bytes, lt, limit)
        if (skip < 0) return -1
        pos = skip
        continue
      }
      if (b1 == '/'.code.toByte()) {
        val needed = lt + 2 + name.size
        if (needed >= limit) return if (allowIncomplete) -1 else -2
        var same = true
        for (j in name.indices) {
          if (bytes[lt + 2 + j] != name[j]) {
            same = false
            break
          }
        }
        if (same) {
          val after = bytes[needed].toInt() and 0xFF
          if (after == '>'.code || after == ' '.code || after == '\t'.code || after == '\r'.code || after == '\n'.code) {
            return lt
          }
        }
      }
      pos = lt + 1
    }
    return -1
  }

  fun readAttr(bytes: ByteArray, from: Int, to: Int, target: String): String? {
    var result: String? = null
    readAttrs(bytes, from, to) { name, value ->
      if (name == target && result == null) result = value
    }
    return result
  }

  inline fun readAttrs(
    bytes: ByteArray,
    from: Int,
    to: Int,
    onAttr: (String, String) -> Unit,
  ) {
    var i = from
    while (i < to) {
      while (i < to && isWs(bytes[i])) i += 1
      if (i >= to || bytes[i] == '/'.code.toByte() || bytes[i] == '>'.code.toByte()) break
      val ns = i
      while (i < to && !isNameStop(bytes[i].toInt() and 0xFF)) i += 1
      val ne = i
      if (ne == ns) {
        i += 1
        continue
      }
      while (i < to && isWs(bytes[i])) i += 1
      if (i >= to || bytes[i] != '='.code.toByte()) continue
      i += 1
      while (i < to && isWs(bytes[i])) i += 1
      if (i >= to) break
      val q = bytes[i]
      if (q != '"'.code.toByte() && q != '\''.code.toByte()) continue
      i += 1
      val vs = i
      while (i < to && bytes[i] != q) i += 1
      val ve = i
      if (i < to) i += 1
      val name = String(bytes, ns, ne - ns, StandardCharsets.UTF_8)
      val rawVal = String(bytes, vs, ve - vs, StandardCharsets.UTF_8)
      onAttr(name, XmltvTextHelpers.decodeXmlEntities(rawVal))
    }
  }

  fun readElementText(bytes: ByteArray, from: Int, to: Int): String {
    if (from >= to) return ""
    if (indexOfByte(bytes, from, to, '<'.code.toByte()) < 0) {
      return XmltvTextHelpers.decodeXmlEntities(String(bytes, from, to - from, StandardCharsets.UTF_8)).trim()
    }
    val sb = StringBuilder(to - from)
    var pos = from
    while (pos < to) {
      val lt = indexOfByte(bytes, pos, to, '<'.code.toByte())
      if (lt < 0) {
        sb.append(XmltvTextHelpers.decodeXmlEntities(String(bytes, pos, to - pos, StandardCharsets.UTF_8)))
        break
      }
      if (lt > pos) {
        sb.append(XmltvTextHelpers.decodeXmlEntities(String(bytes, pos, lt - pos, StandardCharsets.UTF_8)))
      }
      if (lt + 8 < to && bytes[lt + 1] == '!'.code.toByte() && isCdataStart(bytes, lt)) {
        var end = lt + 9
        while (end + 2 < to) {
          if (bytes[end] == ']'.code.toByte() && bytes[end + 1] == ']'.code.toByte() && bytes[end + 2] == '>'.code.toByte()) {
            break
          }
          end += 1
        }
        if (end + 2 < to) {
          sb.append(String(bytes, lt + 9, end - (lt + 9), StandardCharsets.UTF_8))
          pos = end + 3
          continue
        }
      }
      val skip = skipMarkup(bytes, lt, to)
      if (skip > lt) {
        pos = skip
      } else {
        sb.append('<')
        pos = lt + 1
      }
    }
    return sb.toString().trim()
  }

  fun extractRatingValue(bytes: ByteArray, from: Int, to: Int): String? {
    var pos = from
    while (pos < to) {
      val lt = indexOfByte(bytes, pos, to, '<'.code.toByte())
      if (lt < 0 || lt + 1 >= to) return null
      val b1 = bytes[lt + 1].toInt() and 0xFF
      if (!isMarkupStart(b1)) { pos = lt + 1; continue }
      if (b1 == '/'.code) {
        val gt = indexOfByte(bytes, lt + 2, to, '>'.code.toByte())
        if (gt < 0) return null
        pos = gt + 1
        continue
      }
      if (b1 == '!'.code || b1 == '?'.code) {
        val skip = skipMarkup(bytes, lt, to)
        if (skip < 0) return null
        pos = skip
        continue
      }
      val tagEnd = findTagEnd(bytes, lt, to)
      if (tagEnd < 0) return null
      val ns = lt + 1
      val nLen = nameEnd(bytes, ns, tagEnd) - ns
      val selfClosing = bytes[tagEnd - 2] == '/'.code.toByte()
      if (!selfClosing && isTag(bytes, ns, nLen, BYTES_VALUE)) {
        val close = findCloseTag(bytes, tagEnd, to, BYTES_VALUE, false)
        if (close < 0) return null
        val t = readElementText(bytes, tagEnd, close)
        if (t.isNotEmpty()) return t
        val gt = indexOfByte(bytes, close, to, '>'.code.toByte())
        if (gt < 0) return null
        pos = gt + 1
        continue
      }
      pos = tagEnd
    }
    return null
  }
}

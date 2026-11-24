package io.github.fatihmutluu.elv.lanpairing

import java.io.ByteArrayOutputStream
import java.net.URI
import java.nio.charset.StandardCharsets
import java.security.SecureRandom
import java.util.Locale

/**
 * Pure JVM-testable CSPRNG token generation and POST payload schema validation for the Android
 * LAN pairing HTTP server (`#50`). Never logs raw request bodies, URLs, or credentials.
 */
object LanPairingPayloadValidator {
  private const val TOKEN_BYTE_LENGTH = 24
  private const val MAX_NAME_LENGTH = 120
  private const val MAX_URL_LENGTH = 2_048
  private const val MAX_CREDENTIAL_LENGTH = 256
  private const val MAX_JSON_DEPTH = 4
  private val HEX_CHARS = "0123456789abcdef".toCharArray()
  private val secureRandom = SecureRandom()
  private val NON_STRING_VALUE = Any()

  /** Generates a 192-bit (24-byte) CSPRNG pairing token encoded as 48 lowercase hex characters. */
  fun generateToken(): String {
    val bytes = ByteArray(TOKEN_BYTE_LENGTH)
    secureRandom.nextBytes(bytes)
    val chars = CharArray(TOKEN_BYTE_LENGTH * 2)
    for (i in bytes.indices) {
      val v = bytes[i].toInt() and 0xFF
      chars[i * 2] = HEX_CHARS[v ushr 4]
      chars[i * 2 + 1] = HEX_CHARS[v and 0x0F]
    }
    return String(chars)
  }

  /**
   * Validates `contentType` (`application/json` or `application/x-www-form-urlencoded`) and checks
   * that `body` contains a valid M3U or Xtream source payload without control characters or invalid
   * URL schemes.
   */
  fun isValidSubmissionPayload(body: String, contentType: String?): Boolean {
    if (body.isBlank() || contentType.isNullOrBlank()) return false
    val mime = contentType.substringBefore(';').trim().lowercase(Locale.US)
    val fields: Map<String, Any?> = when (mime) {
      "application/json" -> parseJsonObject(body) ?: return false
      "application/x-www-form-urlencoded" -> parseFormEncoded(body) ?: return false
      else -> return false
    }

    val kind = readStringField(fields, "kind", required = true)?.trim()?.lowercase(Locale.US)
      ?: return false
    if (kind != "m3u" && kind != "xtream") return false

    val name = readStringField(fields, "name", required = false)
    if (name == INVALID_FIELD) return false
    if (name != null) {
      val trimmedName = name.trim()
      if (trimmedName.length > MAX_NAME_LENGTH) return false
    }

    val guideUrl = readStringField(fields, "guideUrl", required = false)
    if (guideUrl == INVALID_FIELD) return false
    if (guideUrl != null) {
      val trimmedGuide = guideUrl.trim()
      if (trimmedGuide.isNotEmpty() && !isValidHttpUrl(trimmedGuide)) return false
    }

    return when (kind) {
      "m3u" -> {
        val url = readStringField(fields, "url", required = true)?.trim() ?: return false
        isValidHttpUrl(url)
      }
      "xtream" -> {
        val server = readStringField(fields, "server", required = true)?.trim() ?: return false
        if (!isValidHttpUrl(server)) return false
        val username = readStringField(fields, "username", required = true)?.trim() ?: return false
        if (username.isEmpty() || username.length > MAX_CREDENTIAL_LENGTH) return false
        val password = readStringField(fields, "password", required = true)?.trim() ?: return false
        if (password.isEmpty() || password.length > MAX_CREDENTIAL_LENGTH) return false
        true
      }
      else -> false
    }
  }

  private const val INVALID_FIELD = "\u0000__INVALID__"

  private fun readStringField(fields: Map<String, Any?>, key: String, required: Boolean): String? {
    if (!fields.containsKey(key)) {
      return if (required) null else null
    }
    val raw = fields[key] ?: return if (required) null else null
    if (raw !is String) return if (required) null else INVALID_FIELD
    if (containsControlChars(raw)) return if (required) null else INVALID_FIELD
    return raw
  }

  private fun containsControlChars(value: String): Boolean {
    for (ch in value) {
      val code = ch.code
      if (code <= 0x1F || code == 0x7F) return true
    }
    return false
  }

  private fun isValidHttpUrl(raw: String): Boolean {
    if (raw.isEmpty() || raw.length > MAX_URL_LENGTH) return false
    for (ch in raw) {
      val code = ch.code
      if (code <= 0x20 || code == 0x7F || ch.isWhitespace()) return false
    }
    val uri = runCatching { URI(raw) }.getOrNull() ?: return false
    val scheme = uri.scheme?.lowercase(Locale.US) ?: return false
    if (scheme != "http" && scheme != "https") return false
    val host = uri.host
    return !host.isNullOrEmpty()
  }

  private fun parseFormEncoded(body: String): Map<String, Any?>? {
    val result = LinkedHashMap<String, Any?>()
    val pairs = body.split('&')
    for (pair in pairs) {
      if (pair.isEmpty()) continue
      val eq = pair.indexOf('=')
      val rawKey = if (eq >= 0) pair.substring(0, eq) else pair
      val rawVal = if (eq >= 0) pair.substring(eq + 1) else ""
      val key = decodeFormComponent(rawKey) ?: return null
      val value = decodeFormComponent(rawVal) ?: return null
      result[key] = value
    }
    return result
  }

  private fun decodeFormComponent(input: String): String? {
    val out = ByteArrayOutputStream(input.length)
    var i = 0
    while (i < input.length) {
      val ch = input[i]
      when (ch) {
        '+' -> {
          out.write(' '.code)
          i += 1
        }
        '%' -> {
          if (i + 2 >= input.length) return null
          val hi = hexDigit(input[i + 1])
          val lo = hexDigit(input[i + 2])
          if (hi < 0 || lo < 0) return null
          out.write((hi shl 4) or lo)
          i += 3
        }
        else -> {
          val bytes = ch.toString().toByteArray(StandardCharsets.UTF_8)
          out.write(bytes)
          i += 1
        }
      }
    }
    return String(out.toByteArray(), StandardCharsets.UTF_8)
  }

  private fun hexDigit(ch: Char): Int {
    return when (ch) {
      in '0'..'9' -> ch.code - '0'.code
      in 'a'..'f' -> ch.code - 'a'.code + 10
      in 'A'..'F' -> ch.code - 'A'.code + 10
      else -> -1
    }
  }

  private fun parseJsonObject(input: String): Map<String, Any?>? {
    val parser = JsonObjectParser(input)
    return parser.parseRootObject()
  }

  private class JsonObjectParser(private val src: String) {
    private var pos = 0

    fun parseRootObject(): Map<String, Any?>? {
      skipWhitespace()
      if (pos >= src.length || src[pos] != '{') return null
      pos += 1
      val map = LinkedHashMap<String, Any?>()
      skipWhitespace()
      if (pos < src.length && src[pos] == '}') {
        pos += 1
        skipWhitespace()
        return if (pos == src.length) map else null
      }
      while (true) {
        skipWhitespace()
        val key = parseString() ?: return null
        skipWhitespace()
        if (pos >= src.length || src[pos] != ':') return null
        pos += 1
        skipWhitespace()
        val value = parseValue(depth = 1)
        if (value === PARSE_ERROR) return null
        map[key] = value
        skipWhitespace()
        if (pos >= src.length) return null
        when (src[pos]) {
          ',' -> pos += 1
          '}' -> {
            pos += 1
            skipWhitespace()
            return if (pos == src.length) map else null
          }
          else -> return null
        }
      }
    }

    private fun parseValue(depth: Int): Any? {
      if (depth > MAX_JSON_DEPTH || pos >= src.length) return PARSE_ERROR
      return when (src[pos]) {
        '"' -> parseString() ?: PARSE_ERROR
        '{' -> if (skipObject(depth)) NON_STRING_VALUE else PARSE_ERROR
        '[' -> if (skipArray(depth)) NON_STRING_VALUE else PARSE_ERROR
        't' -> if (consumeLiteral("true")) NON_STRING_VALUE else PARSE_ERROR
        'f' -> if (consumeLiteral("false")) NON_STRING_VALUE else PARSE_ERROR
        'n' -> if (consumeLiteral("null")) null else PARSE_ERROR
        '-', in '0'..'9' -> if (skipNumber()) NON_STRING_VALUE else PARSE_ERROR
        else -> PARSE_ERROR
      }
    }

    private fun parseString(): String? {
      if (pos >= src.length || src[pos] != '"') return null
      pos += 1
      val sb = StringBuilder()
      while (pos < src.length) {
        val ch = src[pos++]
        if (ch == '"') return sb.toString()
        if (ch.code < 0x20) return null
        if (ch == '\\') {
          if (pos >= src.length) return null
          when (val esc = src[pos++]) {
            '"' -> sb.append('"')
            '\\' -> sb.append('\\')
            '/' -> sb.append('/')
            'b' -> sb.append('\b')
            'f' -> sb.append('\u000C')
            'n' -> sb.append('\n')
            'r' -> sb.append('\r')
            't' -> sb.append('\t')
            'u' -> {
              if (pos + 4 > src.length) return null
              var code = 0
              for (k in 0 until 4) {
                val digit = hexDigit(src[pos++])
                if (digit < 0) return null
                code = (code shl 4) or digit
              }
              sb.append(code.toChar())
            }
            else -> return null
          }
        } else {
          sb.append(ch)
        }
      }
      return null
    }

    private fun skipObject(depth: Int): Boolean {
      if (depth >= MAX_JSON_DEPTH) return false
      pos += 1
      skipWhitespace()
      if (pos < src.length && src[pos] == '}') {
        pos += 1
        return true
      }
      while (true) {
        skipWhitespace()
        if (parseString() == null) return false
        skipWhitespace()
        if (pos >= src.length || src[pos] != ':') return false
        pos += 1
        skipWhitespace()
        if (parseValue(depth + 1) === PARSE_ERROR) return false
        skipWhitespace()
        if (pos >= src.length) return false
        when (src[pos]) {
          ',' -> pos += 1
          '}' -> {
            pos += 1
            return true
          }
          else -> return false
        }
      }
    }

    private fun skipArray(depth: Int): Boolean {
      if (depth >= MAX_JSON_DEPTH) return false
      pos += 1
      skipWhitespace()
      if (pos < src.length && src[pos] == ']') {
        pos += 1
        return true
      }
      while (true) {
        skipWhitespace()
        if (parseValue(depth + 1) === PARSE_ERROR) return false
        skipWhitespace()
        if (pos >= src.length) return false
        when (src[pos]) {
          ',' -> pos += 1
          ']' -> {
            pos += 1
            return true
          }
          else -> return false
        }
      }
    }

    private fun consumeLiteral(lit: String): Boolean {
      if (!src.startsWith(lit, pos)) return false
      pos += lit.length
      return true
    }

    private fun skipNumber(): Boolean {
      if (pos < src.length && src[pos] == '-') pos += 1
      if (pos >= src.length) return false
      if (src[pos] == '0') {
        pos += 1
      } else if (src[pos] in '1'..'9') {
        while (pos < src.length && src[pos] in '0'..'9') pos += 1
      } else {
        return false
      }
      if (pos < src.length && src[pos] == '.') {
        pos += 1
        if (pos >= src.length || src[pos] !in '0'..'9') return false
        while (pos < src.length && src[pos] in '0'..'9') pos += 1
      }
      if (pos < src.length && (src[pos] == 'e' || src[pos] == 'E')) {
        pos += 1
        if (pos < src.length && (src[pos] == '+' || src[pos] == '-')) pos += 1
        if (pos >= src.length || src[pos] !in '0'..'9') return false
        while (pos < src.length && src[pos] in '0'..'9') pos += 1
      }
      return true
    }

    private fun skipWhitespace() {
      while (pos < src.length) {
        when (src[pos]) {
          ' ', '\t', '\r', '\n' -> pos += 1
          else -> return
        }
      }
    }

    companion object {
      private val PARSE_ERROR = Any()
    }
  }
}

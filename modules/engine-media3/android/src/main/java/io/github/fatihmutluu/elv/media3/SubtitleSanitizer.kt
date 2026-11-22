package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

private const val REPLACEMENT_CHAR = '\uFFFD'

/**
 * Windows-1252 reverse map for code points above `U+00FF` that correspond to bytes `0x80..0x9F`.
 * Bytes `0x00..0xFF` (including ISO-8859-1 C1 controls left undefined by CP1252) map directly to their byte value.
 */
private val CP1252_HIGH_TO_BYTE: Map<Char, Int> = mapOf(
  '\u20AC' to 0x80,
  '\u201A' to 0x82,
  '\u0192' to 0x83,
  '\u201E' to 0x84,
  '\u2026' to 0x85,
  '\u2020' to 0x86,
  '\u2021' to 0x87,
  '\u02C6' to 0x88,
  '\u2030' to 0x89,
  '\u0160' to 0x8A,
  '\u2039' to 0x8B,
  '\u0152' to 0x8C,
  '\u017D' to 0x8E,
  '\u2018' to 0x91,
  '\u2019' to 0x92,
  '\u201C' to 0x93,
  '\u201D' to 0x94,
  '\u2022' to 0x95,
  '\u2013' to 0x96,
  '\u2014' to 0x97,
  '\u02DC' to 0x98,
  '\u2122' to 0x99,
  '\u0161' to 0x9A,
  '\u203A' to 0x9B,
  '\u0153' to 0x9C,
  '\u017E' to 0x9E,
  '\u0178' to 0x9F,
)

/** Typical UTF-8 lead bytes (0xC2..0xC5, 0xD0..0xD1, 0xE2, 0xF0) as seen after Latin-1/Windows-1252 misdecoding. */
private fun isLikelyMojibakeLeadByte(b: Int): Boolean =
  b == 0xC2 || b == 0xC3 || b == 0xC4 || b == 0xC5 || b == 0xD0 || b == 0xD1 || b == 0xE2 || b == 0xF0

private fun charToSingleByteOrNull(c: Char): Int? {
  val code = c.code
  if (code <= 0xFF) return code
  return CP1252_HIGH_TO_BYTE[c]
}

private fun tryRepairUtf8Run(segment: String): String? {
  val bytes = ByteArray(segment.length)
  var hasMojibakePair = false
  var i = 0
  while (i < segment.length) {
    // Windows-1252 leaves 0x9D unmapped, turning UTF-8 right double quote (E2 80 9D) into "â€\uFFFD".
    if (i + 2 < segment.length &&
      segment[i] == '\u00E2' &&
      segment[i + 1] == '\u20AC' &&
      segment[i + 2] == REPLACEMENT_CHAR
    ) {
      bytes[i] = 0xE2.toByte()
      bytes[i + 1] = 0x80.toByte()
      bytes[i + 2] = 0x9D.toByte()
      hasMojibakePair = true
      i += 3
      continue
    }
    val b = charToSingleByteOrNull(segment[i]) ?: return null
    bytes[i] = b.toByte()
    if (!hasMojibakePair && i > 0) {
      val prev = bytes[i - 1].toInt() and 0xFF
      if (isLikelyMojibakeLeadByte(prev) && (b in 0x80..0xBF)) {
        hasMojibakePair = true
      }
    }
    i += 1
  }
  if (!hasMojibakePair) return null
  val decoded = runCatching {
    val decoder = StandardCharsets.UTF_8.newDecoder()
      .onMalformedInput(CodingErrorAction.REPORT)
      .onUnmappableCharacter(CodingErrorAction.REPORT)
    decoder.decode(ByteBuffer.wrap(bytes)).toString()
  }.getOrNull() ?: return null
  if (decoded.indexOf(REPLACEMENT_CHAR) >= 0 || decoded.length >= segment.length) return null
  return decoded
}

private fun tryRepairUtf8Mojibake(input: String): String? {
  tryRepairUtf8Run(input)?.let { return it }
  // Fallback: repair contiguous CP1252-compatible runs even when stray U+FFFD or higher-plane chars exist.
  val out = StringBuilder(input.length)
  var changed = false
  var i = 0
  while (i < input.length) {
    val runStart = i
    while (i < input.length) {
      if (i + 2 < input.length &&
        input[i] == '\u00E2' &&
        input[i + 1] == '\u20AC' &&
        input[i + 2] == REPLACEMENT_CHAR
      ) {
        i += 3
        continue
      }
      if (charToSingleByteOrNull(input[i]) == null) break
      i += 1
    }
    if (i > runStart) {
      val run = input.substring(runStart, i)
      val repaired = tryRepairUtf8Run(run)
      if (repaired != null) {
        out.append(repaired)
        changed = true
      } else {
        out.append(run)
      }
    }
    if (i < input.length) {
      out.append(input[i])
      i += 1
    }
  }
  return if (changed) out.toString() else null
}

private val NUMERIC_PAREN_CONTENT_REGEX =
  Regex("^\\s*\\d+(?:\\s*[-\\u2013\\u2014.,:/]\\s*\\d+)*\\s*%?\\s*$")

private val HORIZONTAL_SPACES_REGEX = Regex("[ \\t]{2,}")

private fun isBidiControl(c: Char): Boolean =
  c == '\u200E' ||
    c == '\u200F' ||
    c == '\u061C' ||
    c in '\u202A'..'\u202E' ||
    c in '\u2066'..'\u2069'

private fun isDialogueDash(c: Char): Boolean = c == '-' || c == '\u2013' || c == '\u2014'

private fun isMusicSymbolCodePoint(cp: Int): Boolean =
  cp == 0x2669 || cp == 0x266A || cp == 0x266B || cp == 0x266C || cp == 0x1F3B5 || cp == 0x1F3B6

private fun isPunctuationAfterBracket(c: Char): Boolean =
  c == '.' || c == ',' || c == '!' || c == '?' || c == ';' || c == ':'

private fun findMatchingClose(text: String, openIdx: Int, openChar: Char, closeChar: Char): Int {
  var depth = 0
  var i = openIdx
  while (i < text.length) {
    val c = text[i]
    if (c == openChar) {
      depth += 1
    } else if (c == closeChar) {
      depth -= 1
      if (depth == 0) return i
    }
    i += 1
  }
  return -1
}

private fun stripBalancedBrackets(input: String): String {
  val out = StringBuilder(input.length)
  var i = 0
  while (i < input.length) {
    val c = input[i]
    if (c == '[' || c == '(') {
      val closeChar = if (c == '[') ']' else ')'
      val closeIdx = findMatchingClose(input, i, c, closeChar)
      if (closeIdx > i) {
        val inner = input.substring(i + 1, closeIdx)
        if (c == '(' && NUMERIC_PAREN_CONTENT_REGEX.matches(inner)) {
          out.append(input, i, closeIdx + 1)
        } else {
          val prevChar = if (out.isNotEmpty()) out[out.length - 1] else null
          val nextChar = if (closeIdx + 1 < input.length) input[closeIdx + 1] else null
          if (
            prevChar != null &&
            nextChar != null &&
            !prevChar.isWhitespace() &&
            !nextChar.isWhitespace() &&
            !isPunctuationAfterBracket(nextChar)
          ) {
            out.append(' ')
          }
        }
        i = closeIdx + 1
        continue
      }
    }
    out.append(c)
    i += 1
  }
  return out.toString()
}

private fun isAllowedSpeakerLabel(label: String): Boolean {
  val trimmed = label.trim()
  if (trimmed.isEmpty() || trimmed.length > 40) return false
  var hasUpper = false
  var i = 0
  while (i < trimmed.length) {
    val cp = trimmed.codePointAt(i)
    val type = Character.getType(cp)
    when {
      type == Character.UPPERCASE_LETTER.toInt() -> hasUpper = true
      type == Character.LOWERCASE_LETTER.toInt() ||
        type == Character.TITLECASE_LETTER.toInt() ||
        type == Character.OTHER_LETTER.toInt() -> return false
      type == Character.NON_SPACING_MARK.toInt() ||
        type == Character.COMBINING_SPACING_MARK.toInt() ||
        type == Character.DECIMAL_DIGIT_NUMBER.toInt() -> Unit
      cp == ' '.code ||
        cp == '.'.code ||
        cp == '\''.code ||
        cp == '\u2019'.code ||
        cp == '-'.code ||
        cp == '/'.code ||
        cp == '&'.code ||
        cp == ','.code -> Unit
      cp <= 0xFFFF && isBidiControl(cp.toChar()) -> Unit
      else -> return false
    }
    i += Character.charCount(cp)
  }
  return hasUpper
}

private fun stripSpeakerLabelFromLine(line: String): String {
  var idx = 0
  while (idx < line.length && (line[idx] == ' ' || line[idx] == '\t' || isBidiControl(line[idx]))) {
    idx += 1
  }
  var dashChar: Char? = null
  var prefixEnd = idx
  if (idx < line.length && isDialogueDash(line[idx])) {
    dashChar = line[idx]
    idx += 1
    while (idx < line.length && (line[idx] == ' ' || line[idx] == '\t' || isBidiControl(line[idx]))) {
      idx += 1
    }
    prefixEnd = idx
  }
  val colonIdx = line.indexOf(':', startIndex = prefixEnd)
  if (colonIdx <= prefixEnd) return line
  val afterColonIdx = colonIdx + 1
  if (afterColonIdx < line.length) {
    val after = line[afterColonIdx]
    if (after != ' ' && after != '\t' && !isBidiControl(after)) return line
  }
  val candidate = line.substring(prefixEnd, colonIdx)
  if (!isAllowedSpeakerLabel(candidate)) return line
  val rest = line.substring(afterColonIdx).trimStart { it == ' ' || it == '\t' }
  if (dashChar == null) return rest
  val leadingBidi = line.substring(0, line.indexOf(dashChar))
  return if (rest.isEmpty()) "" else "$leadingBidi$dashChar $rest"
}

private fun isBlankDashOrMusicOnly(line: String): Boolean {
  var i = 0
  while (i < line.length) {
    val cp = line.codePointAt(i)
    val ignorable =
      Character.isWhitespace(cp) ||
        isMusicSymbolCodePoint(cp) ||
        (cp <= 0xFFFF && (isBidiControl(cp.toChar()) || isDialogueDash(cp.toChar())))
    if (!ignorable) return false
    i += Character.charCount(cp)
  }
  return true
}

/**
 * Strips SDH / Hearing-Impaired cues (`[music]`, `(sighs)`, `SPEAKER:`, lone dashes and `♪`/`♫` lines)
 * while preserving numeric/year parentheticals like `(2024)` / `(1-2)`, Turkish uppercase, RTL uncased text,
 * timestamps, prose colons, and `- ` dialogue dashes (#310). Returns `""` when the cue becomes empty.
 */
internal fun stripSdhAnnotations(text: String): String {
  if (text.isEmpty()) return ""
  val normalized = text.replace("\r\n", "\n").replace('\r', '\n')
  val withoutBrackets = stripBalancedBrackets(normalized)
  val surviving = ArrayList<String>()
  for (rawLine in withoutBrackets.split('\n')) {
    val trimmed = rawLine.trim { it == ' ' || it == '\t' }
    if (trimmed.isEmpty()) continue
    val withoutSpeaker = stripSpeakerLabelFromLine(trimmed)
    val collapsed = HORIZONTAL_SPACES_REGEX.replace(withoutSpeaker, " ").trim { it == ' ' || it == '\t' }
    if (collapsed.isEmpty() || isBlankDashOrMusicOnly(collapsed)) continue
    surviving.add(collapsed)
  }
  return surviving.joinToString("\n")
}

/**
 * Repairs UTF-8-as-Latin-1/Windows-1252 subtitle mojibake (including Turkish diacritics and typographic punctuation)
 * and strips isolated stray `U+FFFD` replacement characters (#184). Idempotent on valid UTF-8 and preserves the
 * original [CharSequence] instance (including Android styling spans) when no change is needed.
 */
internal fun sanitizeSubtitleText(text: CharSequence): CharSequence {
  if (text.isEmpty()) return text
  val raw = text.toString()
  val repaired = tryRepairUtf8Mojibake(raw) ?: raw
  val cleaned = if (repaired.indexOf(REPLACEMENT_CHAR) >= 0) {
    repaired.replace(REPLACEMENT_CHAR.toString(), "")
  } else {
    repaired
  }
  return if (cleaned == raw) text else cleaned
}

/**
 * Sanitizes text cues in [cues] while leaving DVB/PGS bitmap cues (`text == null`) and every `Cue` layout/styling
 * attribute untouched (#184). When [filterSdh] is enabled (#310), strips SDH annotations after mojibake cleanup
 * and omits cues that become empty so blank subtitle boxes are suppressed.
 */
@OptIn(UnstableApi::class)
internal fun sanitizeCues(cues: List<Cue>, filterSdh: Boolean = false): List<Cue> {
  if (cues.isEmpty()) return cues
  var changed = false
  val out = ArrayList<Cue>(cues.size)
  for (cue in cues) {
    val originalText = cue.text
    if (originalText == null) {
      out.add(cue)
      continue
    }
    val sanitized = sanitizeSubtitleText(originalText)
    if (filterSdh) {
      val sanitizedStr = sanitized.toString()
      val filtered = stripSdhAnnotations(sanitizedStr)
      if (filtered.isEmpty()) {
        changed = true
        continue
      }
      if (filtered != sanitizedStr) {
        changed = true
        out.add(cue.buildUpon().setText(filtered).build())
      } else if (sanitized === originalText) {
        out.add(cue)
      } else {
        changed = true
        out.add(cue.buildUpon().setText(sanitized).build())
      }
    } else if (sanitized === originalText) {
      out.add(cue)
    } else {
      changed = true
      out.add(cue.buildUpon().setText(sanitized).build())
    }
  }
  return if (changed) out else cues
}

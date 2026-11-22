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
 * attribute untouched (#184).
 */
@OptIn(UnstableApi::class)
internal fun sanitizeCues(cues: List<Cue>): List<Cue> {
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
    if (sanitized === originalText) {
      out.add(cue)
    } else {
      changed = true
      out.add(cue.buildUpon().setText(sanitized).build())
    }
  }
  return if (changed) out else cues
}

package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal const val MAX_EXTERNAL_SUBTITLE_BYTES = 4 * 1024 * 1024

/** One timed cue parsed from an external sidecar subtitle track (`#32`, `#308`, `#402`). */
internal data class TimedSidecarCue(
  val startMs: Long,
  val endMs: Long,
  val text: String,
)

private val SRT_VTT_TIMECODE_RE = Regex(
  "^\\s*(?:(\\d{1,3}):)?(\\d{1,2}):(\\d{1,2})(?:[.,:](\\d{1,3}))?\\s*(?:-->|->|\\u2014>)\\s*(?:(\\d{1,3}):)?(\\d{1,2}):(\\d{1,2})(?:[.,:](\\d{1,3}))?(?:\\s.*)?$"
)
private val ASS_TIME_RE = Regex("^\\s*(\\d{1,2}):(\\d{2}):(\\d{2})[.,](\\d{1,3})\\s*$")
private val ASS_DRAWING_RE = Regex("\\{[^}]*\\\\p[1-9][^}]*\\}.*?(?:\\{[^}]*\\\\p0[^}]*\\}|$)", RegexOption.DOT_MATCHES_ALL)
private val ASS_TAG_RE = Regex("\\{[^}]*\\}")
private val HTML_TAG_RE = Regex("</?[a-zA-Z][^>]*>")
private val TTML_P_RE = Regex("<p\\b([^>]*)>(.*?)</p>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val TTML_BR_RE = Regex("<br\\s*/?>", RegexOption.IGNORE_CASE)
private val TTML_ATTR_RE = Regex("([a-zA-Z_:][-a-zA-Z0-9_:.]*)\\s*=\\s*[\"']([^\"']*)[\"']")
private val TTML_OFFSET_RE = Regex("^(\\d+(?:\\.\\d+)?)(ms|s|m|h)$", RegexOption.IGNORE_CASE)
private val TTML_CLOCK_RE = Regex("^(\\d{1,3}):(\\d{2}):(\\d{2})(?:[.,](\\d{1,3})|:(\\d{2}))?$")

private fun decodeSubtitleBytes(bytes: ByteArray): String {
  if (bytes.size >= 2) {
    val b0 = bytes[0].toInt() and 0xFF
    val b1 = bytes[1].toInt() and 0xFF
    if (b0 == 0xFF && b1 == 0xFE) {
      return String(bytes, 2, bytes.size - 2, StandardCharsets.UTF_16LE)
    }
    if (b0 == 0xFE && b1 == 0xFF) {
      return String(bytes, 2, bytes.size - 2, StandardCharsets.UTF_16BE)
    }
  }
  val offset =
    if (bytes.size >= 3 &&
      (bytes[0].toInt() and 0xFF) == 0xEF &&
      (bytes[1].toInt() and 0xFF) == 0xBB &&
      (bytes[2].toInt() and 0xFF) == 0xBF
    ) {
      3
    } else {
      0
    }
  return String(bytes, offset, bytes.size - offset, StandardCharsets.UTF_8)
}

private fun padMillis(raw: String): Long =
  when (raw.length) {
    0 -> 0L
    1 -> (raw.toLongOrNull() ?: 0L) * 100L
    2 -> (raw.toLongOrNull() ?: 0L) * 10L
    else -> raw.take(3).toLongOrNull() ?: 0L
  }

private fun toMs(h: String, m: String, s: String, ms: String): Long {
  val hours = if (h.isEmpty()) 0L else (h.toLongOrNull() ?: 0L)
  val mins = m.toLongOrNull() ?: 0L
  val secs = s.toLongOrNull() ?: 0L
  return ((hours * 3_600L + mins * 60L + secs) * 1_000L) + padMillis(ms)
}

private fun decodeBasicEntities(raw: String): String =
  raw
    .replace("&nbsp;", " ")
    .replace("&amp;", "&")
    .replace("&lt;", "<")
    .replace("&gt;", ">")
    .replace("&quot;", "\"")
    .replace("&#39;", "'")
    .replace("&apos;", "'")

private fun cleanCueText(raw: String): String =
  decodeBasicEntities(HTML_TAG_RE.replace(ASS_TAG_RE.replace(raw, ""), ""))
    .lines()
    .map { it.trim() }
    .filter { it.isNotEmpty() }
    .joinToString("\n")

private fun parseSrtOrVtt(normalized: String): List<TimedSidecarCue> {
  val lines = normalized.split('\n')
  val out = ArrayList<TimedSidecarCue>()
  var i = 0
  while (i < lines.size) {
    val line = lines[i].trim()
    if (line.startsWith("NOTE", ignoreCase = true) ||
      line.startsWith("STYLE", ignoreCase = true) ||
      line.startsWith("REGION", ignoreCase = true)
    ) {
      i += 1
      while (i < lines.size && lines[i].isNotBlank()) i += 1
      continue
    }
    val match = SRT_VTT_TIMECODE_RE.matchEntire(lines[i])
    if (match == null) {
      i += 1
      continue
    }
    val startMs = toMs(
      match.groupValues[1],
      match.groupValues[2],
      match.groupValues[3],
      match.groupValues[4],
    )
    val endMs = toMs(
      match.groupValues[5],
      match.groupValues[6],
      match.groupValues[7],
      match.groupValues[8],
    )
    i += 1
    val body = StringBuilder()
    while (i < lines.size) {
      val current = lines[i]
      if (current.isBlank()) break
      if (SRT_VTT_TIMECODE_RE.matches(current)) break
      if (body.isNotEmpty()) body.append('\n')
      body.append(current)
      i += 1
    }
    val text = cleanCueText(body.toString())
    if (endMs > startMs && text.isNotEmpty()) {
      out.add(TimedSidecarCue(startMs, endMs, text))
    }
  }
  return out
}

private fun parseAssTimeMs(raw: String): Long? {
  val m = ASS_TIME_RE.matchEntire(raw) ?: return null
  val h = m.groupValues[1].toLongOrNull() ?: return null
  val min = m.groupValues[2].toLongOrNull() ?: return null
  val sec = m.groupValues[3].toLongOrNull() ?: return null
  val frac = padMillis(m.groupValues[4])
  return ((h * 3_600L + min * 60L + sec) * 1_000L) + frac
}

private fun parseAss(normalized: String): List<TimedSidecarCue> {
  val out = ArrayList<TimedSidecarCue>()
  var startIdx = 1
  var endIdx = 2
  var textIdx = 9
  var inEvents = false
  for (rawLine in normalized.split('\n')) {
    val trimmed = rawLine.trim()
    if (trimmed.startsWith('[')) {
      inEvents = trimmed.equals("[Events]", ignoreCase = true)
      continue
    }
    if (trimmed.startsWith("Format:", ignoreCase = true) && inEvents) {
      val cols = trimmed.substringAfter(':').split(',').map { it.trim().lowercase(Locale.ROOT) }
      cols.indexOf("start").takeIf { it >= 0 }?.let { startIdx = it }
      cols.indexOf("end").takeIf { it >= 0 }?.let { endIdx = it }
      cols.indexOf("text").takeIf { it >= 0 }?.let { textIdx = it }
      continue
    }
    if (!trimmed.startsWith("Dialogue:", ignoreCase = true)) continue
    val payload = trimmed.substringAfter(':')
    val fields = payload.split(',', limit = textIdx + 1)
    if (fields.size <= maxOf(startIdx, endIdx, textIdx)) continue
    val startMs = parseAssTimeMs(fields[startIdx]) ?: continue
    val endMs = parseAssTimeMs(fields[endIdx]) ?: continue
    if (endMs <= startMs) continue
    val withoutDrawing = ASS_DRAWING_RE.replace(fields[textIdx], "")
    val withoutTags = ASS_TAG_RE.replace(withoutDrawing, "")
      .replace("\\N", "\n")
      .replace("\\n", "\n")
      .replace("\\h", " ")
    val text = cleanCueText(withoutTags)
    if (text.isNotEmpty()) {
      out.add(TimedSidecarCue(startMs, endMs, text))
    }
  }
  return out
}

private fun parseTtmlTimeMs(raw: String?): Long? {
  val value = raw?.trim()?.takeIf { it.isNotEmpty() } ?: return null
  TTML_OFFSET_RE.matchEntire(value)?.let { m ->
    val amount = m.groupValues[1].toDoubleOrNull() ?: return null
    val mult = when (m.groupValues[2].lowercase(Locale.ROOT)) {
      "ms" -> 1.0
      "s" -> 1_000.0
      "m" -> 60_000.0
      "h" -> 3_600_000.0
      else -> return null
    }
    return (amount * mult).toLong()
  }
  TTML_CLOCK_RE.matchEntire(value)?.let { m ->
    val h = m.groupValues[1].toLongOrNull() ?: return null
    val min = m.groupValues[2].toLongOrNull() ?: return null
    val sec = m.groupValues[3].toLongOrNull() ?: return null
    val ms = if (m.groupValues[4].isNotEmpty()) {
      padMillis(m.groupValues[4])
    } else if (m.groupValues[5].isNotEmpty()) {
      ((m.groupValues[5].toLongOrNull() ?: 0L) * 1_000L) / 30L
    } else {
      0L
    }
    return ((h * 3_600L + min * 60L + sec) * 1_000L) + ms
  }
  return null
}

private fun parseTtml(normalized: String): List<TimedSidecarCue> {
  val out = ArrayList<TimedSidecarCue>()
  for (match in TTML_P_RE.findAll(normalized)) {
    val attrs = HashMap<String, String>()
    for (attr in TTML_ATTR_RE.findAll(match.groupValues[1])) {
      attrs[attr.groupValues[1].lowercase(Locale.ROOT)] = attr.groupValues[2]
    }
    val startMs = parseTtmlTimeMs(attrs["begin"]) ?: continue
    val endMs = parseTtmlTimeMs(attrs["end"])
      ?: parseTtmlTimeMs(attrs["dur"])?.let { startMs + it }
      ?: continue
    if (endMs <= startMs) continue
    val withBreaks = TTML_BR_RE.replace(match.groupValues[2], "\n")
    val text = cleanCueText(withBreaks)
    if (text.isNotEmpty()) {
      out.add(TimedSidecarCue(startMs, endMs, text))
    }
  }
  return out
}

/**
 * Tolerantly parses SRT, WebVTT, ASS/SSA, or TTML subtitle payloads into sorted [TimedSidecarCue] entries (`#32`,
 * `#308`, `#402`). Never throws on malformed cues.
 */
internal fun parseSidecarSubtitles(rawText: String, mimeTypeHint: String? = null): List<TimedSidecarCue> {
  if (rawText.isBlank()) return emptyList()
  val normalized = rawText.removePrefix("\uFEFF").replace("\r\n", "\n").replace('\r', '\n')
  val head = normalized.take(512).lowercase(Locale.ROOT)
  val mime = mimeTypeHint?.lowercase(Locale.ROOT).orEmpty()
  val cues = when {
    mime == MimeTypes.TEXT_SSA || head.contains("[script info]") || head.contains("dialogue:") -> parseAss(normalized)
    mime == MimeTypes.APPLICATION_TTML || head.contains("<tt") -> parseTtml(normalized)
    else -> parseSrtOrVtt(normalized)
  }
  return cues.sortedWith(compareBy<TimedSidecarCue> { it.startMs }.thenBy { it.endMs })
}

/**
 * Resolves all active sidecar cues for [positionMs] shifted by [delayMs], applying mojibake repair and optional
 * SDH stripping via [sanitizeCues].
 */
@OptIn(UnstableApi::class)
internal fun resolveActiveSidecarCues(
  cues: List<TimedSidecarCue>,
  positionMs: Long,
  delayMs: Long = 0L,
  filterSdh: Boolean = false,
): List<Cue> {
  if (cues.isEmpty()) return emptyList()
  val effectiveMs = positionMs - clampSyncDelayMs(delayMs)
  if (effectiveMs < 0L) return emptyList()
  val active = ArrayList<Cue>(2)
  for (cue in cues) {
    if (cue.startMs > effectiveMs) break
    if (effectiveMs in cue.startMs until cue.endMs) {
      active.add(Cue.Builder().setText(cue.text).build())
    }
  }
  if (active.isEmpty()) return emptyList()
  return sanitizeCues(active, filterSdh = filterSdh)
}

/**
 * Isolated sidecar subtitle fetcher and parser (`#32`, `#308`, `#402`).
 * Reads external subtitles strictly through [StreamHttp.subtitleDataSourceFactory] (never touching the primary stream
 * OkHttpClient or its credentials) with a hard `4 MiB` byte cap so mid-playback additions and dual external tracks
 * never tear down the active video socket.
 */
@OptIn(UnstableApi::class)
internal class ExternalSubtitleLoader(
  private val context: Context? = null,
  private val dataSourceFactoryProvider: (ExternalSubtitleConfig, Boolean) -> DataSource.Factory = { cfg, legacyTls ->
    StreamHttp.subtitleDataSourceFactory(
      subtitleHeaders = cfg.headers,
      allowLegacyTls = legacyTls,
      context = context,
    )
  },
  private val executor: ExecutorService = Executors.newFixedThreadPool(2) { runnable ->
    Thread(runnable, "ElvExtSubLoader").apply { isDaemon = true }
  },
  private val ownsExecutor: Boolean = true,
) {
  private val disposed = AtomicBoolean(false)

  /** Synchronously reads and parses [config] using the isolated subtitle transport, bounded to [maxBytes]. */
  fun loadSync(
    config: ExternalSubtitleConfig,
    allowLegacyTls: Boolean = false,
    maxBytes: Int = MAX_EXTERNAL_SUBTITLE_BYTES,
  ): List<TimedSidecarCue> {
    if (!isAllowedExternalSubtitleUri(config.uri)) {
      throw IOException("Disallowed external subtitle URI")
    }
    val dataSource = dataSourceFactoryProvider(config, allowLegacyTls).createDataSource()
    val out = ByteArrayOutputStream()
    try {
      dataSource.open(DataSpec(Uri.parse(config.uri)))
      val buf = ByteArray(8_192)
      var total = 0
      while (true) {
        val read = dataSource.read(buf, 0, buf.size)
        if (read == C.RESULT_END_OF_INPUT || read < 0) break
        if (read == 0) continue
        total += read
        if (total > maxBytes) {
          throw IOException("External subtitle exceeds $maxBytes byte cap")
        }
        out.write(buf, 0, read)
      }
    } finally {
      runCatching { dataSource.close() }
    }
    val decoded = decodeSubtitleBytes(out.toByteArray())
    return parseSidecarSubtitles(decoded, config.mimeType)
  }

  /** Asynchronously loads and parses [config] on a daemon worker thread, reporting [onResult] or `null` on failure. */
  fun loadAsync(
    config: ExternalSubtitleConfig,
    allowLegacyTls: Boolean = false,
    onResult: (List<TimedSidecarCue>?) -> Unit,
  ) {
    if (disposed.get()) return
    runCatching {
      executor.execute {
        if (disposed.get()) return@execute
        val parsed = runCatching { loadSync(config, allowLegacyTls) }.getOrNull()
        if (!disposed.get()) onResult(parsed)
      }
    }
  }

  fun dispose() {
    if (!disposed.compareAndSet(false, true)) return
    if (ownsExecutor) executor.shutdownNow()
  }
}

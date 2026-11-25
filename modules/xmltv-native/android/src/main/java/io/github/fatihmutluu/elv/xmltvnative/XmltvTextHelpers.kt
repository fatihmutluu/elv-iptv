package io.github.fatihmutluu.elv.xmltvnative

import java.text.Normalizer
import java.util.Locale
import java.util.TimeZone

internal data class CleanedTitle(
  val title: String,
  val isLive: Boolean,
  val isNew: Boolean,
)

/**
 * Pure JVM XMLTV text, timestamp, folding, genre, flag, and artwork helpers matching
 * `@elv/sources` (`xmltv-time.ts`, `xmltv-meta.ts`, `epg-metadata.ts`, `entities.ts`,
 * `artwork-url.ts`) and `@elv/data` (`fold.ts`).
 */
internal object XmltvTextHelpers {
  /** Minimum valid XMLTV programme timestamp (`1990-01-01T00:00:00Z`). */
  const val MIN_VALID_XMLTV_EPOCH_MS: Long = 631_152_000_000L
  const val MAX_INLINE_LOGO_BYTES: Int = 4096

  const val EPG_FLAG_LIVE: Int = 1
  const val EPG_FLAG_NEW: Int = 2
  const val EPG_FLAG_PREMIERE: Int = 4
  const val EPG_FLAG_REPEAT: Int = 8

  private val DAYS_IN_MONTH = intArrayOf(31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
  private val VALID_TZ_IDS: Set<String> = TimeZone.getAvailableIDs().toHashSet()

  private val INLINE_HTML_TAG_RE = Regex(
    "<(/?)(b|i|u|em|strong|br|p|span|font|small|sub|sup|mark|del|ins)(?:\\s+[^<>]*)?\\s*/?>",
    RegexOption.IGNORE_CASE,
  )
  private val COLLAPSE_WS_RE = Regex("[ \\t\\r\\n]+")
  private val SUPERSCRIPT_RUN_RE = Regex(
    "[\u02B0-\u02B8\u02E0-\u02E4\u1D2C-\u1D61\u1D9B-\u1DBF\u2070-\u207F\u2C7C-\u2C7D\u00B2\u00B3\u00B9]+",
  )
  private val BADGE_BOUNDARY_CHARS = " \t\r\n()[]{},;:/|\u00B7\u2022\u2013\u2014-"
  private val SUPERSCRIPT_TO_ASCII: Map<Char, Char> = mapOf(
    '\u1D38' to 'L',
    '\u02E1' to 'L',
    '\u1D35' to 'I',
    '\u2071' to 'I',
    '\u2C7D' to 'V',
    '\u1D5B' to 'V',
    '\u1D31' to 'E',
    '\u1D49' to 'E',
    '\u1D3A' to 'N',
    '\u207F' to 'N',
    '\u1D42' to 'W',
    '\u02B7' to 'W',
  )

  private val XMLTV_NS_RE = Regex(
    "^\\s*\\d*(?:/\\d+)?\\s*\\.\\s*\\d*(?:/\\d+)?(?:\\s*\\.\\s*\\d*(?:/\\d+)?)?\\s*$",
  )
  private val DESC_EPISODE_RE = Regex("^\\s*(S\\d{1,3}E\\d{1,4})\\b", RegexOption.IGNORE_CASE)
  private val DESC_SEASON_EPISODE_RE = Regex(
    "^\\s*Season\\s+(\\d{1,3})\\s*(?:[,:-]\\s*|\\s+)Episode\\s+(\\d{1,4})\\b",
    RegexOption.IGNORE_CASE,
  )
  private val DESC_X_EPISODE_RE = Regex("^\\s*(\\d{1,3})x(\\d{2,4})\\b", RegexOption.IGNORE_CASE)
  private val DATA_IMAGE_RE = Regex(
    "^data:image/([a-z0-9][a-z0-9.+-]*)(?:;[^,]*)?,",
    RegexOption.IGNORE_CASE,
  )

  private val SPORTS_TOKENS = setOf(
    "sports", "sport", "spor", "futbol", "football", "soccer", "basketball", "basketbol",
    "tennis", "tenis", "motorsport", "f1", "racing", "golf", "boxing", "boks", "hockey",
    "rugby", "athletics", "volleyball", "voleybol", "baseball", "cricket", "olympics",
    "deportes", "deporte",
  )
  private val MOVIE_TOKENS = setOf(
    "movie", "movies", "film", "films", "sinema", "cinema", "kino", "pelicula", "peliculas",
    "cine", "feature", "thriller", "horror", "action", "aksiyon", "adventure",
  )
  private val NEWS_TOKENS = setOf(
    "news", "haber", "haberler", "nachrichten", "actualites", "actualite", "noticias",
    "noticia", "journal", "bulletin", "politics", "ekonomi", "economy", "weather", "gundem",
  )
  private val NEWS_PHRASES = arrayOf("current affairs", "hava durumu")
  private val KIDS_TOKENS = setOf(
    "kids", "kid", "children", "child", "cocuk", "animation", "animasyon", "cartoon",
    "kinder", "jeunesse", "enfants", "enfant", "infantil", "ninos", "nino", "family", "aile",
  )
  private val KIDS_PHRASES = arrayOf("cizgi film")
  private val SERIES_TOKENS = setOf(
    "series", "serie", "drama", "dizi", "diziler", "comedy", "komedi", "comedie", "comedia",
    "documentary", "belgesel", "dokumentation", "documentaire", "documental", "sitcom",
    "soap", "reality", "entertainment", "eglence", "magazine", "lifestyle",
  )
  private val SERIES_PHRASES = arrayOf("talk show")

  private fun parseDigits(text: String, start: Int, count: Int): Int {
    var value = 0
    for (i in start until start + count) {
      val d = text[i].code - 48
      if (d < 0 || d > 9) return -1
      value = value * 10 + d
    }
    return value
  }

  private fun daysInMonth(year: Int, month: Int): Int {
    val leap = (year % 4 == 0) && (year % 100 != 0 || year % 400 == 0)
    return if (month == 2 && leap) 29 else DAYS_IN_MONTH[month - 1]
  }

  /** Fast proleptic Gregorian UTC epoch ms (Howard Hinnant algorithm, zero Calendar allocation). */
  private fun utcMillis(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int): Long {
    val y = if (month <= 2) year - 1 else year
    val era = if (y >= 0) y / 400 else (y - 399) / 400
    val yoe = y - era * 400
    val m = if (month > 2) month - 3 else month + 9
    val doy = (153 * m + 2) / 5 + day - 1
    val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    val daysSinceEpoch = era.toLong() * 146_097L + doe.toLong() - 719_468L
    val secondsOfDay = hour.toLong() * 3600L + minute.toLong() * 60L + second.toLong()
    return (daysSinceEpoch * 86_400L + secondsOfDay) * 1000L
  }

  private fun resolveTimeZone(name: String?): TimeZone? {
    val trimmed = name?.trim() ?: return null
    if (trimmed.isEmpty()) return null
    if (!VALID_TZ_IDS.contains(trimmed)) return null
    return TimeZone.getTimeZone(trimmed)
  }

  private fun resolveWallClockInTimeZone(wallUtcMs: Long, tz: TimeZone): Long {
    val off1 = tz.getOffset(wallUtcMs).toLong()
    val guess1 = wallUtcMs - off1
    val off2 = tz.getOffset(guess1).toLong()
    if (off2 == off1) return guess1
    val guess2 = wallUtcMs - off2
    if (tz.getOffset(guess2).toLong() == off2) return guess2
    return wallUtcMs - minOf(off1, off2)
  }

  private fun parseOffsetMinutes(suffix: String): Int? {
    if (suffix.isEmpty()) return 0
    val upper = suffix.uppercase(Locale.US)
    if (upper == "Z" || upper == "UTC" || upper == "GMT") return 0
    var rest = upper
    if (rest.startsWith("UTC") || rest.startsWith("GMT")) {
      rest = rest.substring(3).trimStart()
    }
    if (rest.isEmpty()) return null
    val sign = when (rest[0]) {
      '+' -> 1
      '-' -> -1
      else -> return null
    }
    val body = if (rest.length == 6 && rest[3] == ':') {
      rest.substring(1, 3) + rest.substring(4, 6)
    } else {
      rest.substring(1)
    }
    if (body.length != 2 && body.length != 4) return null
    val hours = parseDigits(body, 0, 2)
    val minutes = if (body.length == 4) parseDigits(body, 2, 2) else 0
    if (hours < 0 || minutes < 0 || hours > 23 || minutes > 59) return null
    return sign * (hours * 60 + minutes)
  }

  fun parseXmltvTime(raw: String, defaultTimeZone: String? = null): Long? {
    val t = raw.trim()
    var n = 0
    val len = t.length
    while (n < len && n < 14) {
      val c = t[n].code
      if (c < 48 || c > 57) break
      n += 1
    }
    if (n < 4 || n % 2 != 0) return null
    val year = parseDigits(t, 0, 4)
    val month = if (n >= 6) parseDigits(t, 4, 2) else 1
    val day = if (n >= 8) parseDigits(t, 6, 2) else 1
    val hour = if (n >= 10) parseDigits(t, 8, 2) else 0
    val minute = if (n >= 12) parseDigits(t, 10, 2) else 0
    val second = if (n >= 14) parseDigits(t, 12, 2) else 0
    if (year < 1000 || month < 1 || month > 12) return null
    if (day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
      return null
    }
    val wallUtcMs = utcMillis(year, month, day, hour, minute, second)
    val suffix = t.substring(n).trim()
    if (suffix.isEmpty()) {
      val tz = resolveTimeZone(defaultTimeZone) ?: return wallUtcMs
      return resolveWallClockInTimeZone(wallUtcMs, tz)
    }
    val offsetMinutes = parseOffsetMinutes(suffix) ?: return null
    return wallUtcMs - offsetMinutes.toLong() * 60_000L
  }

  fun decodeXmlEntities(text: String): String {
    val firstAmp = text.indexOf('&')
    if (firstAmp < 0) return text
    val sb = StringBuilder(text.length)
    var i = 0
    val len = text.length
    while (i < len) {
      val amp = text.indexOf('&', i)
      if (amp < 0) {
        sb.append(text, i, len)
        break
      }
      sb.append(text, i, amp)
      val semi = text.indexOf(';', amp + 1)
      if (semi < 0 || semi - amp > 10) {
        sb.append('&')
        i = amp + 1
        continue
      }
      val entity = text.substring(amp + 1, semi)
      val decoded: String? = when {
        entity == "amp" -> "&"
        entity == "lt" -> "<"
        entity == "gt" -> ">"
        entity == "quot" -> "\""
        entity == "apos" -> "'"
        entity.startsWith("#x") || entity.startsWith("#X") -> {
          val hex = entity.substring(2)
          if (hex.isNotEmpty() && hex.length <= 6 && hex.all { it.isDigit() || it in 'a'..'f' || it in 'A'..'F' }) {
            codePointToString(hex.toIntOrNull(16))
          } else null
        }
        entity.startsWith("#") -> {
          val dec = entity.substring(1)
          if (dec.isNotEmpty() && dec.length <= 7 && dec.all { it.isDigit() }) {
            codePointToString(dec.toIntOrNull(10))
          } else null
        }
        else -> null
      }
      if (decoded != null) {
        sb.append(decoded)
        i = semi + 1
      } else {
        sb.append('&')
        i = amp + 1
      }
    }
    return sb.toString()
  }

  private fun codePointToString(cp: Int?): String? {
    if (cp == null || cp <= 0 || cp > 0x10FFFF || (cp in 0xD800..0xDFFF)) return null
    return String(Character.toChars(cp))
  }

  fun stripInlineHtml(text: String): String {
    if (!text.contains('<')) return text
    var stripped = false
    val cleaned = INLINE_HTML_TAG_RE.replace(text) { match ->
      stripped = true
      val slash = match.groupValues[1]
      val tag = match.groupValues[2].lowercase(Locale.US)
      if (tag == "br" || (tag == "p" && slash == "/")) " " else ""
    }
    return if (stripped) COLLAPSE_WS_RE.replace(cleaned, " ").trim() else text
  }

  private fun isAscii(text: String): Boolean {
    for (i in 0 until text.length) {
      if (text[i].code > 0x7F) return false
    }
    return true
  }

  private fun isBadgeBoundary(ch: Char?): Boolean {
    return ch == null || BADGE_BOUNDARY_CHARS.indexOf(ch) >= 0
  }

  fun cleanTitleAndFlags(raw: String): CleanedTitle {
    val withoutHtml = stripInlineHtml(raw)
    if (isAscii(withoutHtml)) {
      return CleanedTitle(withoutHtml, isLive = false, isNew = false)
    }
    var isLive = false
    var isNew = false
    var strippedSuper = false
    val withoutSuper = SUPERSCRIPT_RUN_RE.replace(withoutHtml) { match ->
      val run = match.value
      val start = match.range.first
      val endExclusive = match.range.last + 1
      val prev = if (start > 0) withoutHtml[start - 1] else null
      val next = if (endExclusive < withoutHtml.length) withoutHtml[endExclusive] else null
      val foldedBuilder = StringBuilder(run.length)
      var allMapped = true
      for (ch in run) {
        val mapped = SUPERSCRIPT_TO_ASCII[ch]
        if (mapped == null) {
          allMapped = false
          break
        }
        foldedBuilder.append(mapped)
      }
      val folded = if (allMapped) foldedBuilder.toString() else ""
      val recognizedBadge = folded == "LIVE" || folded == "NEW"
      val standalone = isBadgeBoundary(prev) && isBadgeBoundary(next)
      if (!standalone && !(recognizedBadge && isBadgeBoundary(next))) {
        run
      } else {
        strippedSuper = true
        if (folded == "LIVE") isLive = true
        else if (folded == "NEW") isNew = true
        ""
      }
    }
    val title = if (strippedSuper) COLLAPSE_WS_RE.replace(withoutSuper, " ").trim() else withoutHtml
    return CleanedTitle(title, isLive = isLive, isNew = isNew)
  }

  fun episodeNumRank(system: String?): Int {
    val normalized = system?.trim()?.lowercase(Locale.US) ?: return 0
    return when (normalized) {
      "xmltv_ns" -> 3
      "onscreen" -> 2
      "dd_progid" -> 1
      else -> 0
    }
  }

  fun isValidXmltvNs(value: String): Boolean {
    if (!XMLTV_NS_RE.matches(value)) return false
    for (i in 0 until value.length) {
      if (value[i] in '0'..'9') return true
    }
    return false
  }

  fun extractDescEpisodeNum(desc: String): String? {
    var i = 0
    val len = desc.length
    while (i < len) {
      val c = desc[i]
      if (c != ' ' && c != '\t' && c != '\n' && c != '\r') break
      i += 1
    }
    if (i >= len) return null
    val first = desc[i]
    if (first != 'S' && first != 's' && first !in '0'..'9') return null
    DESC_EPISODE_RE.find(desc)?.let { return it.groupValues[1].uppercase(Locale.US) }
    DESC_SEASON_EPISODE_RE.find(desc)?.let {
      return formatSeasonEpisode(it.groupValues[1], it.groupValues[2])
    }
    DESC_X_EPISODE_RE.find(desc)?.let {
      return formatSeasonEpisode(it.groupValues[1], it.groupValues[2])
    }
    return null
  }

  private fun formatSeasonEpisode(season: String, episode: String): String {
    return "S${season.padStart(2, '0')}E${episode.padStart(2, '0')}"
  }

  fun sanitizeArtworkUrl(raw: String): String? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null
    for (i in 0 until trimmed.length) {
      val code = trimmed[i].code
      if (code <= 0x1F || code == 0x7F) return null
    }
    val lower = trimmed.lowercase(Locale.US)
    if (lower.startsWith("http://") || lower.startsWith("https://")) {
      val prefixLen = if (lower.startsWith("https://")) 8 else 7
      val afterScheme = trimmed.substring(prefixLen)
      var authEnd = afterScheme.length
      for (i in 0 until afterScheme.length) {
        val ch = afterScheme[i]
        if (ch == '/' || ch == '?' || ch == '#') {
          authEnd = i
          break
        }
      }
      val authority = afterScheme.substring(0, authEnd)
      val atIdx = authority.lastIndexOf('@')
      val hostPort = if (atIdx >= 0) authority.substring(atIdx + 1) else authority
      if (hostPort.isEmpty()) return null
      if (hostPort.startsWith("[")) {
        val close = hostPort.indexOf(']')
        if (close <= 1) return null
        val host = hostPort.substring(1, close)
        return if (host.any { it.isWhitespace() }) null else trimmed
      }
      val colon = hostPort.indexOf(':')
      val host = if (colon >= 0) hostPort.substring(0, colon) else hostPort
      return if (host.isNotEmpty() && host.none { it.isWhitespace() }) trimmed else null
    }
    if (lower.startsWith("data:")) {
      if (trimmed.length > MAX_INLINE_LOGO_BYTES) return null
      val match = DATA_IMAGE_RE.find(trimmed) ?: return null
      val subtype = match.groupValues[1].lowercase(Locale.US)
      if (subtype == "svg" || subtype.contains("svg")) return null
      return trimmed
    }
    return null
  }

  /**
   * Matches `packages/data/src/fold.ts#foldText` (ASCII fast path + Turkish-aware NFD folding).
   */
  fun foldText(text: String): String {
    if (text.isEmpty()) return ""
    if (isAscii(text)) {
      val sb = StringBuilder(text.length)
      var pendingSpace = false
      for (i in 0 until text.length) {
        val raw = text[i].code
        val ch = if (raw in 65..90) raw + 32 else raw
        val isAlnum = (ch in 97..122) || (ch in 48..57)
        if (isAlnum) {
          if (pendingSpace && sb.isNotEmpty()) sb.append(' ')
          sb.append(ch.toChar())
          pendingSpace = false
        } else {
          pendingSpace = true
        }
      }
      return sb.toString()
    }
    val pre = StringBuilder(text.length)
    for (i in 0 until text.length) {
      when (val ch = text[i]) {
        '\u0130' -> pre.append('i')
        'I' -> pre.append('\u0131')
        else -> pre.append(ch)
      }
    }
    val lowered = pre.toString().lowercase(Locale.ROOT)
    val nfd = Normalizer.normalize(lowered, Normalizer.Form.NFD)
    val sb = StringBuilder(nfd.length)
    var pendingSpace = false
    var i = 0
    while (i < nfd.length) {
      val cp = nfd.codePointAt(i)
      i += Character.charCount(cp)
      val type = Character.getType(cp)
      if (
        type == Character.NON_SPACING_MARK.toInt() ||
        type == Character.COMBINING_SPACING_MARK.toInt() ||
        type == Character.ENCLOSING_MARK.toInt()
      ) {
        continue
      }
      if (cp == 0x00DF) { // ß
        if (pendingSpace && sb.isNotEmpty()) sb.append(' ')
        sb.append("ss")
        pendingSpace = false
      } else if (cp == 0x0131) { // ı
        if (pendingSpace && sb.isNotEmpty()) sb.append(' ')
        sb.append('i')
        pendingSpace = false
      } else if (Character.isLetterOrDigit(cp)) {
        if (pendingSpace && sb.isNotEmpty()) sb.append(' ')
        sb.appendCodePoint(cp)
        pendingSpace = false
      } else {
        pendingSpace = true
      }
    }
    return sb.toString()
  }

  private fun foldCategoryText(raw: String): String {
    val pre = raw.replace('\u0130', 'i').replace('\u0131', 'i').lowercase(Locale.ROOT)
    val nfkd = Normalizer.normalize(pre, Normalizer.Form.NFKD)
    val sb = StringBuilder(nfkd.length)
    var pendingSpace = false
    for (i in 0 until nfkd.length) {
      val c = nfkd[i]
      if (c in '\u0300'..'\u036F') continue
      if (c in 'a'..'z' || c in '0'..'9') {
        if (pendingSpace && sb.isNotEmpty()) sb.append(' ')
        sb.append(c)
        pendingSpace = false
      } else {
        pendingSpace = true
      }
    }
    return sb.toString()
  }

  fun normalizeEpgGenre(categories: List<String>): String? {
    var hasNonEmpty = false
    for (raw in categories) {
      val trimmed = raw.trim()
      if (trimmed.isEmpty()) continue
      hasNonEmpty = true
      val folded = foldCategoryText(trimmed)
      if (folded.isEmpty()) continue
      val tokens = folded.split(' ')
      for (tok in tokens) if (SPORTS_TOKENS.contains(tok)) return "sports"
      for (p in KIDS_PHRASES) if (folded.contains(p)) return "kids"
      for (tok in tokens) if (KIDS_TOKENS.contains(tok)) return "kids"
      for (p in NEWS_PHRASES) if (folded.contains(p)) return "news"
      for (tok in tokens) if (NEWS_TOKENS.contains(tok)) return "news"
      for (tok in tokens) if (MOVIE_TOKENS.contains(tok)) return "movie"
      for (p in SERIES_PHRASES) if (folded.contains(p)) return "series"
      for (tok in tokens) if (SERIES_TOKENS.contains(tok)) return "series"
    }
    return if (hasNonEmpty) "other" else null
  }

  fun encodeProgrammeFlags(
    isLive: Boolean,
    isNew: Boolean,
    isPremiere: Boolean,
    previouslyShown: Boolean,
  ): Int {
    var mask = 0
    if (isLive) mask = mask or EPG_FLAG_LIVE
    if (isNew) mask = mask or EPG_FLAG_NEW
    if (isPremiere) mask = mask or EPG_FLAG_PREMIERE
    if (previouslyShown) mask = mask or EPG_FLAG_REPEAT
    return mask
  }

  fun encodeJsonStringArray(items: List<String>): String {
    val sb = StringBuilder(items.size * 16 + 2)
    sb.append('[')
    for (idx in items.indices) {
      if (idx > 0) sb.append(',')
      sb.append('"')
      val s = items[idx]
      for (i in 0 until s.length) {
        when (val ch = s[i]) {
          '"' -> sb.append("\\\"")
          '\\' -> sb.append("\\\\")
          '\b' -> sb.append("\\b")
          '\u000C' -> sb.append("\\f")
          '\n' -> sb.append("\\n")
          '\r' -> sb.append("\\r")
          '\t' -> sb.append("\\t")
          else -> {
            if (ch.code < 0x20) {
              sb.append("\\u")
              sb.append(ch.code.toString(16).padStart(4, '0'))
            } else {
              sb.append(ch)
            }
          }
        }
      }
      sb.append('"')
    }
    sb.append(']')
    return sb.toString()
  }
}

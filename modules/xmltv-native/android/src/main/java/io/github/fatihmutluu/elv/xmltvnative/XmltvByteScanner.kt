package io.github.fatihmutluu.elv.xmltvnative

import java.io.InputStream
import java.io.PushbackInputStream
import java.nio.charset.StandardCharsets
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.GZIPInputStream

internal data class ScannedChannel(
  val id: String,
  val names: MutableList<String>,
  var icon: String? = null,
  var lcn: String? = null,
)

internal data class StagedProgrammeRow(
  val sourceId: String,
  val guideId: String,
  val start: Long,
  val stop: Long,
  val title: String,
  val subTitle: String?,
  val description: String?,
  val categoriesJson: String?,
  val episodeNum: String?,
  val icon: String?,
  val runId: Long,
  val genre: String?,
  val flags: Int,
  val ratingSystem: String?,
  val ratingValue: String?,
  val titleFold: String,
  val descriptionFold: String,
)

internal data class ScanSummary(
  val channels: List<ScannedChannel>,
  val stagedCounts: Map<String, Int>,
  val seenProgrammes: Int,
  val stagedProgrammes: Int,
  val warnings: Int,
  val warningCodes: List<String>,
)

internal fun interface ProgrammeRowSink {
  fun onRow(row: StagedProgrammeRow)
}

internal class StageCancelledException : RuntimeException("cancelled")

/**
 * Low-allocation streaming UTF-8 byte-array XMLTV scanner (64 KiB read chunks).
 * Parses `<channel>` and `<programme>` elements directly from byte slices, filters to `[fromMs, toMs)`,
 * clamps open and overlapping programmes (`OPEN_END_MS = 30 min`), and emits staged rows to a sink.
 */
internal class XmltvByteScanner(
  private val sourceId: String,
  private val runId: Long,
  private val fromMs: Long,
  private val toMs: Long,
  private val defaultTimeZone: String? = null,
  private val cancelled: AtomicBoolean = AtomicBoolean(false),
) {
  companion object {
    const val READ_BUFFER_BYTES = 65_536
    const val MAX_ELEMENT_BYTES = 1 shl 20
    const val OPEN_END_MS = 30L * 60_000L
    const val MAX_WARNINGS = 100
    private const val TAR_HEADER_BYTES = 512
    private const val TAR_USTAR_OFFSET = 257
    private const val MAX_OPEN_STACK = 64
    private const val LOOKBACK = 8

    private val BYTES_PROGRAMME = "programme".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_CHANNEL = "channel".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_DISPLAY_NAME = "display-name".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_LCN = "lcn".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_ICON = "icon".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_TITLE = "title".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_SUB_TITLE = "sub-title".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_DESC = "desc".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_CATEGORY = "category".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_EPISODE_NUM = "episode-num".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_RATING = "rating".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_LIVE = "live".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_NEW = "new".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_PREMIERE = "premiere".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_PREVIOUSLY_SHOWN = "previously-shown".toByteArray(StandardCharsets.US_ASCII)
    private val BYTES_USTAR = "ustar".toByteArray(StandardCharsets.US_ASCII)

    /** Peeks first 2 bytes for gzip magic `1f 8b` (or honors `forceGzip`) and wraps in `GZIPInputStream`. */
    fun wrapMaybeGzipStream(input: InputStream, forceGzip: Boolean = false): InputStream {
      val pb = PushbackInputStream(input, 2)
      val b0 = pb.read()
      if (b0 < 0) return pb
      val b1 = pb.read()
      if (b1 < 0) {
        pb.unread(b0)
        return pb
      }
      pb.unread(b1)
      pb.unread(b0)
      val isGzipMagic = (b0 == 0x1F && b1 == 0x8B)
      return if (forceGzip || isGzipMagic) GZIPInputStream(pb, READ_BUFFER_BYTES) else pb
    }
  }

  private data class OpenProgramme(
    val channel: String,
    val start: Long,
    val title: String,
    val subTitle: String?,
    val desc: String?,
    val categories: List<String>,
    val episodeNum: String?,
    val icon: String?,
    val isLive: Boolean,
    val isNew: Boolean,
    val isPremiere: Boolean,
    val previouslyShown: Boolean,
    val ratingSystem: String?,
    val ratingValue: String?,
  )

  private val channelsById = LinkedHashMap<String, ScannedChannel>()
  private val openByChannel = HashMap<String, OpenProgramme>()
  private val lastByChannel = HashMap<String, StagedProgrammeRow>()
  private val stagedCounts = HashMap<String, Int>()
  private val warningCodes = ArrayList<String>()
  private var warnings = 0
  private var seenProgrammes = 0
  private var stagedProgrammes = 0

  private var buf = ByteArray(READ_BUFFER_BYTES * 2)
  private var bufLen = 0
  private var headerChecked = false

  private val openStarts = IntArray(MAX_OPEN_STACK)
  private val openLens = IntArray(MAX_OPEN_STACK)
  private var openDepth = 0

  fun scanStream(rawInput: InputStream, forceGzip: Boolean = false, sink: ProgrammeRowSink): ScanSummary {
    val stream = wrapMaybeGzipStream(rawInput, forceGzip)
    val chunk = ByteArray(READ_BUFFER_BYTES)
    while (true) {
      if (cancelled.get()) throw StageCancelledException()
      val read = stream.read(chunk)
      if (read < 0) break
      if (read == 0) continue
      appendBytes(chunk, 0, read)
      if (!headerChecked && bufLen >= TAR_HEADER_BYTES) stripBomAndTarHeader()
      if (headerChecked) processBuffer(finalPass = false, sink = sink)
    }
    if (cancelled.get()) throw StageCancelledException()
    if (!headerChecked) stripBomAndTarHeader()
    processBuffer(finalPass = true, sink = sink)
    flushOpenProgrammes(sink)
    return ScanSummary(
      channels = channelsById.values.toList(),
      stagedCounts = stagedCounts,
      seenProgrammes = seenProgrammes,
      stagedProgrammes = stagedProgrammes,
      warnings = warnings,
      warningCodes = warningCodes,
    )
  }

  private fun appendBytes(src: ByteArray, offset: Int, count: Int) {
    if (bufLen + count > buf.size) {
      var nextSize = buf.size
      while (nextSize < bufLen + count) nextSize *= 2
      buf = buf.copyOf(nextSize)
    }
    System.arraycopy(src, offset, buf, bufLen, count)
    bufLen += count
  }

  private fun consume(count: Int) {
    if (count <= 0) return
    if (count >= bufLen) {
      bufLen = 0
      return
    }
    val remaining = bufLen - count
    System.arraycopy(buf, count, buf, 0, remaining)
    bufLen = remaining
  }

  private fun stripBomAndTarHeader() {
    headerChecked = true
    if (bufLen >= TAR_HEADER_BYTES && XmltvByteTokens.matchesAt(buf, TAR_USTAR_OFFSET, bufLen, BYTES_USTAR)) {
      consume(TAR_HEADER_BYTES)
    }
    if (bufLen >= 3 && (buf[0].toInt() and 0xFF) == 0xEF && (buf[1].toInt() and 0xFF) == 0xBB && (buf[2].toInt() and 0xFF) == 0xBF) {
      consume(3)
    }
  }

  private fun processBuffer(finalPass: Boolean, sink: ProgrammeRowSink) {
    var pos = 0
    while (pos < bufLen) {
      if (cancelled.get()) throw StageCancelledException()
      val lt = XmltvByteTokens.indexOfByte(buf, pos, bufLen, '<'.code.toByte())
      if (lt < 0) { pos = bufLen; break }
      pos = lt
      if (lt + 1 >= bufLen) { if (finalPass) pos = bufLen; break }
      val b1 = buf[lt + 1].toInt() and 0xFF
      if (!XmltvByteTokens.isMarkupStart(b1)) { pos = lt + 1; continue }
      if (b1 == '/'.code) {
        val gt = XmltvByteTokens.indexOfByte(buf, lt + 2, bufLen, '>'.code.toByte())
        if (gt < 0) { if (finalPass) pos = bufLen; break }
        pos = gt + 1
        continue
      }
      if (b1 == '!'.code || b1 == '?'.code) {
        val skip = XmltvByteTokens.skipMarkup(buf, lt, bufLen)
        if (skip < 0) {
          if (bufLen - lt > MAX_ELEMENT_BYTES) { recordWarning("element-too-long"); pos = lt + 1; continue }
          if (finalPass) pos = bufLen
          break
        }
        pos = skip
        continue
      }
      val progMatch = XmltvByteTokens.matchTagName(buf, lt + 1, bufLen, BYTES_PROGRAMME)
      if (progMatch < 0) { if (finalPass) pos = bufLen; break }
      if (progMatch == 1) {
        val next = scanElement(lt, isProgramme = true, finalPass = finalPass, sink = sink)
        if (next < 0) break
        pos = next
        continue
      }
      val chanMatch = XmltvByteTokens.matchTagName(buf, lt + 1, bufLen, BYTES_CHANNEL)
      if (chanMatch < 0) { if (finalPass) pos = bufLen; break }
      if (chanMatch == 1) {
        val next = scanElement(lt, isProgramme = false, finalPass = finalPass, sink = sink)
        if (next < 0) break
        pos = next
        continue
      }
      val tagEnd = XmltvByteTokens.findTagEnd(buf, lt, bufLen)
      if (tagEnd == -1) {
        if (bufLen - lt > MAX_ELEMENT_BYTES) { recordWarning("element-too-long"); pos = lt + 1; continue }
        if (finalPass) pos = bufLen
        break
      }
      pos = if (tagEnd == -2) lt + 1 else tagEnd
    }
    consume(pos)
  }

  private fun scanElement(
    lt: Int,
    isProgramme: Boolean,
    finalPass: Boolean,
    sink: ProgrammeRowSink,
  ): Int {
    val kind = if (isProgramme) "programme" else "channel"
    val nameBytes = if (isProgramme) BYTES_PROGRAMME else BYTES_CHANNEL
    val tagEnd = XmltvByteTokens.findTagEnd(buf, lt, bufLen)
    if (tagEnd == -1) {
      if (bufLen - lt > MAX_ELEMENT_BYTES) { recordWarning("element-too-long"); return lt + 1 }
      if (finalPass) { recordWarning("$kind-truncated"); return bufLen }
      return -1
    }
    if (tagEnd == -2) { recordWarning("$kind-malformed"); return lt + 1 }
    val selfClosing = tagEnd >= 2 && buf[tagEnd - 2] == '/'.code.toByte()
    var bodyEnd = tagEnd
    var end = tagEnd
    if (!selfClosing) {
      val close = XmltvByteTokens.findCloseTag(buf, tagEnd, bufLen, nameBytes, allowIncomplete = true)
      if (close == -1) {
        if (bufLen - lt > MAX_ELEMENT_BYTES) { recordWarning("element-too-long"); return lt + 1 }
        if (finalPass) { recordWarning("$kind-truncated"); return bufLen }
        return -1
      }
      if (close == -2) { recordWarning("$kind-unclosed"); return lt + 1 }
      val gt = XmltvByteTokens.indexOfByte(buf, close, bufLen, '>'.code.toByte())
      if (gt < 0) {
        if (finalPass) { recordWarning("$kind-truncated"); return bufLen }
        return -1
      }
      bodyEnd = close
      end = gt + 1
    }
    if (end - lt > MAX_ELEMENT_BYTES) { recordWarning("element-too-long"); return end }
    val attrStart = XmltvByteTokens.nameEnd(buf, lt + 1, tagEnd)
    val attrEnd = if (selfClosing) tagEnd - 2 else tagEnd - 1
    if (isProgramme) parseProgramme(attrStart, attrEnd, tagEnd, bodyEnd, sink)
    else parseChannel(attrStart, attrEnd, tagEnd, bodyEnd)
    return end
  }

  private fun parseChannel(attrStart: Int, attrEnd: Int, bodyStart: Int, bodyEnd: Int) {
    val id = XmltvByteTokens.readAttr(buf, attrStart, attrEnd, "id")?.trim()
    if (id.isNullOrEmpty()) { recordWarning("channel-missing-id"); return }
    val names = ArrayList<String>(2)
    var icon: String? = null
    var lcn: String? = null
    openDepth = 0
    var i = bodyStart
    while (i < bodyEnd) {
      val lt = XmltvByteTokens.indexOfByte(buf, i, bodyEnd, '<'.code.toByte())
      if (lt < 0 || lt + 1 >= bodyEnd) break
      val b1 = buf[lt + 1].toInt() and 0xFF
      if (!XmltvByteTokens.isMarkupStart(b1)) { i = lt + 1; continue }
      if (b1 == '/'.code) { closeUnknown(buf, lt + 2, bodyEnd); i = lt + 2; continue }
      if (b1 == '!'.code || b1 == '?'.code) {
        val skip = XmltvByteTokens.skipMarkup(buf, lt, bodyEnd)
        if (skip < 0) { recordWarning("channel-malformed"); return }
        i = skip; continue
      }
      val tagEnd = XmltvByteTokens.findTagEnd(buf, lt, bodyEnd)
      if (tagEnd < 0) { recordWarning("channel-malformed"); return }
      val ns = lt + 1
      val nLen = XmltvByteTokens.nameEnd(buf, ns, tagEnd) - ns
      val selfClosing = buf[tagEnd - 2] == '/'.code.toByte()
      if (XmltvByteTokens.isTag(buf, ns, nLen, BYTES_ICON)) {
        if (openDepth == 0 && icon == null) {
          val src = XmltvByteTokens.readAttr(buf, ns + nLen, tagEnd - 1, "src")
          if (src != null) icon = XmltvTextHelpers.sanitizeArtworkUrl(src)
        }
        if (!selfClosing) pushOpen(ns, nLen)
        i = tagEnd; continue
      }
      val isDisplayName = XmltvByteTokens.isTag(buf, ns, nLen, BYTES_DISPLAY_NAME)
      val isLcn = !isDisplayName && XmltvByteTokens.isTag(buf, ns, nLen, BYTES_LCN)
      if (!isDisplayName && !isLcn) {
        if (!selfClosing) pushOpen(ns, nLen)
        i = tagEnd; continue
      }
      if (selfClosing) { i = tagEnd; continue }
      val close = XmltvByteTokens.findCloseTag(buf, tagEnd, bodyEnd, if (isDisplayName) BYTES_DISPLAY_NAME else BYTES_LCN, false)
      if (close < 0) { recordWarning("channel-malformed"); return }
      val gt = XmltvByteTokens.indexOfByte(buf, close, bodyEnd, '>'.code.toByte())
      if (gt < 0) { recordWarning("channel-malformed"); return }
      i = gt + 1
      val text = XmltvByteTokens.readElementText(buf, tagEnd, close)
      if (text.isNotEmpty()) {
        if (isDisplayName) names.add(text)
        else if (openDepth == 0 && lcn == null) lcn = text
      }
    }
    val existing = channelsById[id]
    if (existing == null) {
      val deduped = ArrayList<String>(names.size)
      for (n in names) if (!deduped.contains(n)) deduped.add(n)
      channelsById[id] = ScannedChannel(id = id, names = deduped, icon = icon, lcn = lcn)
    } else {
      for (n in names) if (!existing.names.contains(n)) existing.names.add(n)
      if (existing.icon.isNullOrEmpty() && !icon.isNullOrEmpty()) existing.icon = icon
      if (existing.lcn.isNullOrEmpty() && !lcn.isNullOrEmpty()) existing.lcn = lcn
    }
  }

  private fun parseProgramme(
    attrStart: Int,
    attrEnd: Int,
    bodyStart: Int,
    bodyEnd: Int,
    sink: ProgrammeRowSink,
  ) {
    var rawChannel: String? = null
    var startText: String? = null
    var stopText: String? = null
    XmltvByteTokens.readAttrs(buf, attrStart, attrEnd) { name, value ->
      when (name) {
        "channel" -> rawChannel = value
        "start" -> startText = value
        "stop" -> stopText = value
      }
    }
    val channel = rawChannel?.trim()
    if (channel.isNullOrEmpty()) { recordWarning("programme-missing-channel"); return }
    if (startText == null) { recordWarning("programme-missing-start"); return }
    val start = XmltvTextHelpers.parseXmltvTime(startText!!, defaultTimeZone)
    val stop = if (stopText == null) null else XmltvTextHelpers.parseXmltvTime(stopText!!, defaultTimeZone)
    if (start == null || start < XmltvTextHelpers.MIN_VALID_XMLTV_EPOCH_MS ||
      (stopText != null && stop == null) ||
      (stop != null && (stop < XmltvTextHelpers.MIN_VALID_XMLTV_EPOCH_MS || stop <= start))
    ) {
      recordWarning("programme-bad-time")
      return
    }
    if (start >= toMs) return
    if (if (stop == null) start < fromMs else stop <= fromMs) return

    var title = ""
    var hasTitle = false
    var subTitle: String? = null
    var desc: String? = null
    val categories = ArrayList<String>(2)
    var episodeNum: String? = null
    var episodeRank = -1
    var icon: String? = null
    var ratingSystem: String? = null
    var ratingValue: String? = null
    var tagLive = false
    var tagNew = false
    var titleBadgeLive = false
    var titleBadgeNew = false
    var isPremiere = false
    var previouslyShown = false

    openDepth = 0
    var i = bodyStart
    while (i < bodyEnd) {
      val lt = XmltvByteTokens.indexOfByte(buf, i, bodyEnd, '<'.code.toByte())
      if (lt < 0 || lt + 1 >= bodyEnd) break
      val b1 = buf[lt + 1].toInt() and 0xFF
      if (!XmltvByteTokens.isMarkupStart(b1)) { i = lt + 1; continue }
      if (b1 == '/'.code) { closeUnknown(buf, lt + 2, bodyEnd); i = lt + 2; continue }
      if (b1 == '!'.code || b1 == '?'.code) {
        val skip = XmltvByteTokens.skipMarkup(buf, lt, bodyEnd)
        if (skip < 0) { recordWarning("programme-malformed"); return }
        i = skip; continue
      }
      val tagEnd = XmltvByteTokens.findTagEnd(buf, lt, bodyEnd)
      if (tagEnd < 0) { recordWarning("programme-malformed"); return }
      val ns = lt + 1
      val nLen = XmltvByteTokens.nameEnd(buf, ns, tagEnd) - ns
      val selfClosing = buf[tagEnd - 2] == '/'.code.toByte()

      if (XmltvByteTokens.isTag(buf, ns, nLen, BYTES_ICON)) {
        if (openDepth == 0 && icon == null) {
          val src = XmltvByteTokens.readAttr(buf, ns + nLen, tagEnd - 1, "src")
          if (src != null) icon = XmltvTextHelpers.sanitizeArtworkUrl(src)
        }
        if (!selfClosing) pushOpen(ns, nLen)
        i = tagEnd; continue
      }
      if (openDepth == 0) {
        if (XmltvByteTokens.isTag(buf, ns, nLen, BYTES_LIVE)) { tagLive = true; if (!selfClosing) pushOpen(ns, nLen); i = tagEnd; continue }
        if (XmltvByteTokens.isTag(buf, ns, nLen, BYTES_NEW)) { tagNew = true; if (!selfClosing) pushOpen(ns, nLen); i = tagEnd; continue }
        if (XmltvByteTokens.isTag(buf, ns, nLen, BYTES_PREMIERE)) { isPremiere = true; if (!selfClosing) pushOpen(ns, nLen); i = tagEnd; continue }
        if (XmltvByteTokens.isTag(buf, ns, nLen, BYTES_PREVIOUSLY_SHOWN)) { previouslyShown = true; if (!selfClosing) pushOpen(ns, nLen); i = tagEnd; continue }
      }

      val wantedBytes = when {
        XmltvByteTokens.isTag(buf, ns, nLen, BYTES_TITLE) -> BYTES_TITLE
        XmltvByteTokens.isTag(buf, ns, nLen, BYTES_DESC) -> BYTES_DESC
        XmltvByteTokens.isTag(buf, ns, nLen, BYTES_CATEGORY) -> BYTES_CATEGORY
        XmltvByteTokens.isTag(buf, ns, nLen, BYTES_EPISODE_NUM) -> BYTES_EPISODE_NUM
        XmltvByteTokens.isTag(buf, ns, nLen, BYTES_SUB_TITLE) -> BYTES_SUB_TITLE
        XmltvByteTokens.isTag(buf, ns, nLen, BYTES_RATING) -> BYTES_RATING
        else -> null
      }
      if (wantedBytes == null) {
        if (!selfClosing) pushOpen(ns, nLen)
        i = tagEnd; continue
      }
      if (selfClosing) { i = tagEnd; continue }
      val close = XmltvByteTokens.findCloseTag(buf, tagEnd, bodyEnd, wantedBytes, false)
      if (close < 0) { recordWarning("programme-malformed"); return }
      val gt = XmltvByteTokens.indexOfByte(buf, close, bodyEnd, '>'.code.toByte())
      if (gt < 0) { recordWarning("programme-malformed"); return }
      i = gt + 1

      when {
        wantedBytes === BYTES_TITLE -> if (!hasTitle) {
          val cleaned = XmltvTextHelpers.cleanTitleAndFlags(XmltvByteTokens.readElementText(buf, tagEnd, close))
          title = cleaned.title; titleBadgeLive = cleaned.isLive; titleBadgeNew = cleaned.isNew; hasTitle = true
        }
        wantedBytes === BYTES_CATEGORY -> {
          val t = XmltvByteTokens.readElementText(buf, tagEnd, close)
          if (t.isNotEmpty()) categories.add(t)
        }
        wantedBytes === BYTES_DESC -> if (desc == null) {
          val t = XmltvByteTokens.readElementText(buf, tagEnd, close)
          if (t.isNotEmpty()) desc = t
        }
        wantedBytes === BYTES_SUB_TITLE -> if (subTitle == null) {
          val t = XmltvTextHelpers.stripInlineHtml(XmltvByteTokens.readElementText(buf, tagEnd, close))
          if (t.isNotEmpty()) subTitle = t
        }
        wantedBytes === BYTES_EPISODE_NUM -> {
          val sys = XmltvByteTokens.readAttr(buf, ns + nLen, tagEnd - 1, "system")
          val rank = XmltvTextHelpers.episodeNumRank(sys)
          if (rank > episodeRank) {
            val t = XmltvByteTokens.readElementText(buf, tagEnd, close)
            if (t.isNotEmpty() && (rank != 3 || XmltvTextHelpers.isValidXmltvNs(t))) {
              episodeNum = t; episodeRank = rank
            }
          }
        }
        wantedBytes === BYTES_RATING -> if (openDepth == 0 && ratingValue == null) {
          val sys = XmltvByteTokens.readAttr(buf, ns + nLen, tagEnd - 1, "system")?.trim()
          val value = XmltvByteTokens.extractRatingValue(buf, tagEnd, close)
          if (!value.isNullOrEmpty()) {
            ratingValue = value
            if (!sys.isNullOrEmpty()) ratingSystem = sys
          }
        }
      }
    }

    if (episodeNum == null && desc != null) episodeNum = XmltvTextHelpers.extractDescEpisodeNum(desc!!)
    seenProgrammes += 1
    ingestProgramme(
      OpenProgramme(
        channel = channel, start = start, title = title, subTitle = subTitle, desc = desc,
        categories = categories, episodeNum = episodeNum, icon = icon,
        isLive = tagLive || titleBadgeLive, isNew = tagNew || titleBadgeNew,
        isPremiere = isPremiere, previouslyShown = previouslyShown,
        ratingSystem = ratingSystem, ratingValue = ratingValue,
      ),
      stop,
      sink,
    )
  }

  private fun ingestProgramme(p: OpenProgramme, stop: Long?, sink: ProgrammeRowSink) {
    val prev = openByChannel[p.channel]
    if (prev != null) {
      if (p.start > prev.start) {
        openByChannel.remove(p.channel)
        emitClamped(toStageRow(prev, p.start), sink)
      } else if (p.start == prev.start) {
        openByChannel.remove(p.channel)
      } else {
        val clampedStop = if (stop == null) prev.start else minOf(stop, prev.start)
        emitClamped(toStageRow(p, clampedStop), sink)
        return
      }
    }
    if (stop == null) openByChannel[p.channel] = p
    else emitClamped(toStageRow(p, stop), sink)
  }

  private fun flushOpenProgrammes(sink: ProgrammeRowSink) {
    for (p in openByChannel.values) emitClamped(toStageRow(p, p.start + OPEN_END_MS), sink)
    openByChannel.clear()
  }

  private fun toStageRow(p: OpenProgramme, stop: Long): StagedProgrammeRow {
    val flags = if (p.isLive || p.isNew || p.isPremiere || p.previouslyShown) {
      XmltvTextHelpers.encodeProgrammeFlags(p.isLive, p.isNew, p.isPremiere, p.previouslyShown)
    } else 0
    return StagedProgrammeRow(
      sourceId = sourceId, guideId = p.channel, start = p.start, stop = stop,
      title = p.title, subTitle = p.subTitle, description = p.desc,
      categoriesJson = if (p.categories.isEmpty()) null else XmltvTextHelpers.encodeJsonStringArray(p.categories),
      episodeNum = p.episodeNum, icon = p.icon, runId = runId,
      genre = XmltvTextHelpers.normalizeEpgGenre(p.categories), flags = flags,
      ratingSystem = p.ratingSystem, ratingValue = p.ratingValue,
      titleFold = XmltvTextHelpers.foldText(p.title),
      descriptionFold = if (p.desc != null) XmltvTextHelpers.foldText(p.desc) else "",
    )
  }

  private fun emitClamped(row: StagedProgrammeRow, sink: ProgrammeRowSink) {
    val prev = lastByChannel[row.guideId]
    if (prev == null) {
      sink.onRow(row)
      lastByChannel[row.guideId] = row
      stagedCounts[row.guideId] = (stagedCounts[row.guideId] ?: 0) + 1
      stagedProgrammes += 1
      return
    }
    if (row.start == prev.start) {
      sink.onRow(row)
      lastByChannel[row.guideId] = row
      return
    }
    if (row.start > prev.start) {
      if (prev.stop > row.start) sink.onRow(prev.copy(stop = row.start))
      sink.onRow(row)
      lastByChannel[row.guideId] = row
      stagedCounts[row.guideId] = (stagedCounts[row.guideId] ?: 0) + 1
      stagedProgrammes += 1
      return
    }
    val clamped = if (row.stop > prev.start) row.copy(stop = prev.start) else row
    if (clamped.stop > clamped.start) {
      sink.onRow(clamped)
      stagedCounts[row.guideId] = (stagedCounts[row.guideId] ?: 0) + 1
      stagedProgrammes += 1
    }
  }

  private fun pushOpen(start: Int, len: Int) {
    if (openDepth >= MAX_OPEN_STACK) return
    openStarts[openDepth] = start
    openLens[openDepth] = len
    openDepth += 1
  }

  private fun closeUnknown(bytes: ByteArray, at: Int, limit: Int) {
    val len = XmltvByteTokens.nameEnd(bytes, at, limit) - at
    val floor = maxOf(0, openDepth - LOOKBACK)
    var k = openDepth - 1
    while (k >= floor) {
      if (openLens[k] == len) {
        val start = openStarts[k]
        var same = true
        for (j in 0 until len) {
          if (bytes[start + j] != bytes[at + j]) { same = false; break }
        }
        if (same) { openDepth = k; return }
      }
      k -= 1
    }
  }

  private fun recordWarning(code: String) {
    warnings += 1
    if (warningCodes.size < MAX_WARNINGS) warningCodes.add(code)
  }
}

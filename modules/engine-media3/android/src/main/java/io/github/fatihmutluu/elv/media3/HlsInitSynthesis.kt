package io.github.fatihmutluu.elv.media3

import android.net.Uri
import android.util.Base64
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.UriUtil
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.hls.playlist.DefaultHlsPlaylistParserFactory
import androidx.media3.exoplayer.hls.playlist.HlsMediaPlaylist
import androidx.media3.exoplayer.hls.playlist.HlsMultivariantPlaylist
import androidx.media3.exoplayer.hls.playlist.HlsPlaylist
import androidx.media3.exoplayer.hls.playlist.HlsPlaylistParserFactory
import androidx.media3.exoplayer.upstream.ParsingLoadable
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.util.Locale

private const val TS_PACKET_SIZE = 188
private const val TS_SYNC_BYTE: Byte = 0x47
private const val PAT_PID = 0x0000
private const val STREAM_TYPE_H264 = 0x1B
private const val STREAM_TYPE_HEVC = 0x24
private const val MAX_INIT_VIDEO_PACKETS = 16
private const val MAX_SYNTHESIS_CACHE_ENTRIES = 32
internal const val MAX_INIT_PROBE_BYTES = 256 * 1024

private enum class TsVideoCodec { H264, HEVC }

private data class TsScanResult(
  val patPacket: ByteArray?,
  val pmtPacket: ByteArray?,
  val videoPackets: List<ByteArray>,
  val foundSps: Boolean,
  val foundPps: Boolean,
)

private data class NalScanState(
  val foundSps: Boolean,
  val foundPps: Boolean,
  val hasNalAfterParamSets: Boolean,
)

private fun findTsSyncOffset(bytes: ByteArray): Int {
  val limit = bytes.size - TS_PACKET_SIZE
  for (i in 0..limit) {
    if (bytes[i] == TS_SYNC_BYTE && (i + TS_PACKET_SIZE >= bytes.size || bytes[i + TS_PACKET_SIZE] == TS_SYNC_BYTE)) {
      return i
    }
  }
  return -1
}

private fun parsePatPmtPid(packet: ByteArray, payloadOffset: Int, pusi: Boolean): Int {
  var pos = payloadOffset
  if (pusi) {
    if (pos >= TS_PACKET_SIZE) return -1
    pos += 1 + (packet[pos].toInt() and 0xFF)
  }
  if (pos + 8 > TS_PACKET_SIZE) return -1
  if ((packet[pos].toInt() and 0xFF) != 0x00) return -1
  val sectionLen = ((packet[pos + 1].toInt() and 0x0F) shl 8) or (packet[pos + 2].toInt() and 0xFF)
  val sectionEnd = minOf(TS_PACKET_SIZE, pos + 3 + sectionLen - 4)
  var entry = pos + 8
  while (entry + 4 <= sectionEnd) {
    val programNumber = ((packet[entry].toInt() and 0xFF) shl 8) or (packet[entry + 1].toInt() and 0xFF)
    val pid = ((packet[entry + 2].toInt() and 0x1F) shl 8) or (packet[entry + 3].toInt() and 0xFF)
    if (programNumber != 0 && pid != 0) return pid
    entry += 4
  }
  return -1
}

private fun parsePmtVideoStream(packet: ByteArray, payloadOffset: Int, pusi: Boolean): Pair<Int, TsVideoCodec>? {
  var pos = payloadOffset
  if (pusi) {
    if (pos >= TS_PACKET_SIZE) return null
    pos += 1 + (packet[pos].toInt() and 0xFF)
  }
  if (pos + 12 > TS_PACKET_SIZE) return null
  if ((packet[pos].toInt() and 0xFF) != 0x02) return null
  val sectionLen = ((packet[pos + 1].toInt() and 0x0F) shl 8) or (packet[pos + 2].toInt() and 0xFF)
  val programInfoLen = ((packet[pos + 10].toInt() and 0x0F) shl 8) or (packet[pos + 11].toInt() and 0xFF)
  val sectionEnd = minOf(TS_PACKET_SIZE, pos + 3 + sectionLen - 4)
  var es = pos + 12 + programInfoLen
  while (es + 5 <= sectionEnd) {
    val streamType = packet[es].toInt() and 0xFF
    val esPid = ((packet[es + 1].toInt() and 0x1F) shl 8) or (packet[es + 2].toInt() and 0xFF)
    val esInfoLen = ((packet[es + 3].toInt() and 0x0F) shl 8) or (packet[es + 4].toInt() and 0xFF)
    when (streamType) {
      STREAM_TYPE_H264 -> return esPid to TsVideoCodec.H264
      STREAM_TYPE_HEVC -> return esPid to TsVideoCodec.HEVC
    }
    es += 5 + esInfoLen
  }
  return null
}

private fun scanAnnexBNals(esBytes: ByteArray, codec: TsVideoCodec): NalScanState {
  var foundSps = false
  var foundPps = false
  var hasNalAfterParamSets = false
  var i = 0
  val size = esBytes.size
  while (i + 3 < size) {
    val startCodeLen = when {
      esBytes[i] == 0.toByte() && esBytes[i + 1] == 0.toByte() && esBytes[i + 2] == 1.toByte() -> 3
      i + 4 < size &&
        esBytes[i] == 0.toByte() &&
        esBytes[i + 1] == 0.toByte() &&
        esBytes[i + 2] == 0.toByte() &&
        esBytes[i + 3] == 1.toByte() -> 4
      else -> 0
    }
    if (startCodeLen == 0) {
      i += 1
      continue
    }
    val headerIdx = i + startCodeLen
    if (headerIdx >= size) break
    val header = esBytes[headerIdx].toInt() and 0xFF
    val hadBoth = foundSps && foundPps
    when (codec) {
      TsVideoCodec.H264 -> {
        when (header and 0x1F) {
          7 -> foundSps = true
          8 -> foundPps = true
          else -> if (hadBoth) hasNalAfterParamSets = true
        }
      }
      TsVideoCodec.HEVC -> {
        when ((header shr 1) and 0x3F) {
          33 -> foundSps = true
          34 -> foundPps = true
          else -> if (hadBoth) hasNalAfterParamSets = true
        }
      }
    }
    i = headerIdx + 1
  }
  return NalScanState(foundSps, foundPps, hasNalAfterParamSets)
}

private fun scanTsBytes(tsBytes: ByteArray): TsScanResult {
  val syncStart = findTsSyncOffset(tsBytes)
  if (syncStart < 0) return TsScanResult(null, null, emptyList(), foundSps = false, foundPps = false)

  var patPacket: ByteArray? = null
  var pmtPid = -1
  var pmtPacket: ByteArray? = null
  var videoPid = -1
  var videoCodec: TsVideoCodec? = null
  var videoPesStarted = false
  val videoPackets = mutableListOf<ByteArray>()
  val esOut = ByteArrayOutputStream(1024)
  var nalState = NalScanState(foundSps = false, foundPps = false, hasNalAfterParamSets = false)

  var off = syncStart
  while (off + TS_PACKET_SIZE <= tsBytes.size) {
    if (tsBytes[off] != TS_SYNC_BYTE) break
    val b1 = tsBytes[off + 1].toInt() and 0xFF
    val b2 = tsBytes[off + 2].toInt() and 0xFF
    val b3 = tsBytes[off + 3].toInt() and 0xFF
    val pusi = (b1 and 0x40) != 0
    val pid = ((b1 and 0x1F) shl 8) or b2
    val afc = (b3 shr 4) and 0x03
    val hasAdaptation = (afc and 0x02) != 0
    val hasPayload = (afc and 0x01) != 0
    var payloadStart = 4
    if (hasAdaptation) {
      val afLen = tsBytes[off + 4].toInt() and 0xFF
      payloadStart = 5 + afLen
    }
    if (hasPayload && payloadStart < TS_PACKET_SIZE) {
      val packet = tsBytes.copyOfRange(off, off + TS_PACKET_SIZE)
      when {
        pid == PAT_PID && patPacket == null -> {
          val parsedPmt = parsePatPmtPid(packet, payloadStart, pusi)
          if (parsedPmt > 0) {
            pmtPid = parsedPmt
            patPacket = packet
          }
        }
        pmtPid > 0 && pid == pmtPid && pmtPacket == null -> {
          val parsedVideo = parsePmtVideoStream(packet, payloadStart, pusi)
          if (parsedVideo != null) {
            videoPid = parsedVideo.first
            videoCodec = parsedVideo.second
            pmtPacket = packet
          }
        }
        videoPid > 0 && pid == videoPid -> {
          var esOffset = payloadStart
          var accept = videoPesStarted
          if (pusi) {
            if (payloadStart + 9 <= TS_PACKET_SIZE &&
              packet[payloadStart] == 0.toByte() &&
              packet[payloadStart + 1] == 0.toByte() &&
              packet[payloadStart + 2] == 1.toByte()
            ) {
              val pesHeaderLen = packet[payloadStart + 8].toInt() and 0xFF
              esOffset = payloadStart + 9 + pesHeaderLen
              videoPesStarted = true
              accept = true
            }
          }
          if (accept && videoPackets.size < MAX_INIT_VIDEO_PACKETS) {
            videoPackets += packet
            if (esOffset < TS_PACKET_SIZE) {
              esOut.write(packet, esOffset, TS_PACKET_SIZE - esOffset)
              val codec = videoCodec
              if (codec != null) {
                nalState = scanAnnexBNals(esOut.toByteArray(), codec)
                if (nalState.foundSps && nalState.foundPps && nalState.hasNalAfterParamSets) {
                  break
                }
              }
            }
          }
        }
      }
    }
    off += TS_PACKET_SIZE
  }
  return TsScanResult(patPacket, pmtPacket, videoPackets, nalState.foundSps, nalState.foundPps)
}

/**
 * Extracts a minimal valid MPEG-TS initialization segment containing PAT + PMT + H.264/HEVC SPS/PPS packets from
 * [tsBytes], or `null` if [tsBytes] is not valid MPEG-TS or lacks SPS/PPS (#183).
 */
internal fun extractTsInitSegment(tsBytes: ByteArray): ByteArray? {
  val scan = scanTsBytes(tsBytes)
  val pat = scan.patPacket ?: return null
  val pmt = scan.pmtPacket ?: return null
  if (!scan.foundSps || !scan.foundPps || scan.videoPackets.isEmpty()) return null
  val total = (2 + scan.videoPackets.size) * TS_PACKET_SIZE
  val out = ByteArray(total)
  pat.copyInto(out, 0)
  pmt.copyInto(out, TS_PACKET_SIZE)
  for (i in scan.videoPackets.indices) {
    scan.videoPackets[i].copyInto(out, (2 + i) * TS_PACKET_SIZE)
  }
  return out
}

/** True when [tsBytes] contains valid PAT + PMT and H.264/HEVC video SPS + PPS parameter sets (#183). */
internal fun hasVideoParameterSets(tsBytes: ByteArray): Boolean {
  val scan = scanTsBytes(tsBytes)
  return scan.patPacket != null && scan.pmtPacket != null && scan.foundSps && scan.foundPps
}

/** Encodes synthesized MPEG-TS init bytes as a `data:video/mp2t;base64,...` URI for Media3 `DataSchemeDataSource`. */
internal fun encodeTsInitDataUri(initBytes: ByteArray): String =
  "data:video/mp2t;base64," + Base64.encodeToString(initBytes, Base64.NO_WRAP)

private fun isTsSegmentUrl(url: String): Boolean {
  val clean = url.substringBefore('#').substringBefore('?')
  val last = clean.substringAfterLast('/')
  val ext = if ('.' in last) last.substringAfterLast('.').lowercase(Locale.ROOT) else ""
  return ext == "ts" || ext == "mts" || ext == "m2ts"
}

/** Reads up to [maxBytes] from [dataSource] for [uri], always closing the source in `finally`. */
@OptIn(UnstableApi::class)
internal fun probeSegmentPrefix(
  dataSource: DataSource,
  uri: Uri,
  maxBytes: Int = MAX_INIT_PROBE_BYTES,
): ByteArray? {
  val out = ByteArrayOutputStream(minOf(maxBytes, 32 * 1024))
  val buffer = ByteArray(8 * 1024)
  try {
    dataSource.open(DataSpec(uri))
    var remaining = maxBytes
    while (remaining > 0) {
      val read = dataSource.read(buffer, 0, minOf(buffer.size, remaining))
      if (read == C.RESULT_END_OF_INPUT) break
      if (read > 0) {
        out.write(buffer, 0, read)
        remaining -= read
      }
    }
  } finally {
    runCatching { dataSource.close() }
  }
  return out.toByteArray().takeIf { it.isNotEmpty() }
}

internal sealed interface CachedInitResult {
  data object NotNeeded : CachedInitResult
  data class Synthesized(val dataUri: String) : CachedInitResult
}

/**
 * Wraps [DefaultHlsPlaylistParserFactory] for VOD HLS-TS playlists (#183): when a finished (`hasEndTag`) `.ts`
 * playlist lacks `#EXT-X-MAP` and discontinuities, probes segment 1 (skipping synthesis if segment 1 already carries
 * SPS/PPS) and segment 0 to synthesize a `data:video/mp2t;base64,...` `initializationSegment`, cached in a bounded LRU.
 */
@OptIn(UnstableApi::class)
internal class InitSynthesizingPlaylistParserFactory(
  private val probeSegment: (Uri) -> ByteArray?,
  private val delegate: HlsPlaylistParserFactory = DefaultHlsPlaylistParserFactory(),
  private val cache: MutableMap<String, CachedInitResult> = sharedCache,
) : HlsPlaylistParserFactory {
  override fun createPlaylistParser(): ParsingLoadable.Parser<HlsPlaylist> =
    wrap(delegate.createPlaylistParser())

  override fun createPlaylistParser(
    multivariantPlaylist: HlsMultivariantPlaylist,
    previousMediaPlaylist: HlsMediaPlaylist?,
  ): ParsingLoadable.Parser<HlsPlaylist> =
    wrap(delegate.createPlaylistParser(multivariantPlaylist, previousMediaPlaylist))

  private fun wrap(parser: ParsingLoadable.Parser<HlsPlaylist>): ParsingLoadable.Parser<HlsPlaylist> =
    ParsingLoadable.Parser { uri, inputStream ->
      val parsed = parser.parse(uri, inputStream)
      if (parsed is HlsMediaPlaylist) maybeSynthesize(parsed) else parsed
    }

  private fun maybeSynthesize(playlist: HlsMediaPlaylist): HlsMediaPlaylist {
    if (!isEligible(playlist)) return playlist
    val key = playlist.baseUri
    val cached = synchronized(cache) { cache[key] }
    when (cached) {
      is CachedInitResult.NotNeeded -> return playlist
      is CachedInitResult.Synthesized -> return attachInitSegment(playlist, cached.dataUri)
      null -> Unit
    }

    val seg1Uri = UriUtil.resolveToUri(playlist.baseUri, playlist.segments[1].url)
    val seg1Bytes = safeProbe(seg1Uri) ?: return playlist
    if (hasVideoParameterSets(seg1Bytes)) {
      synchronized(cache) { cache[key] = CachedInitResult.NotNeeded }
      return playlist
    }

    val seg0Uri = UriUtil.resolveToUri(playlist.baseUri, playlist.segments[0].url)
    val seg0Bytes = safeProbe(seg0Uri) ?: return playlist
    val initBytes = extractTsInitSegment(seg0Bytes)
    if (initBytes == null) {
      synchronized(cache) { cache[key] = CachedInitResult.NotNeeded }
      return playlist
    }

    val dataUri = encodeTsInitDataUri(initBytes)
    synchronized(cache) { cache[key] = CachedInitResult.Synthesized(dataUri) }
    return attachInitSegment(playlist, dataUri)
  }

  private fun safeProbe(uri: Uri): ByteArray? =
    try {
      probeSegment(uri)
    } catch (e: SupersededMediaException) {
      throw e
    } catch (e: InterruptedIOException) {
      throw e
    } catch (_: IOException) {
      null
    }

  private fun isEligible(playlist: HlsMediaPlaylist): Boolean {
    if (!playlist.hasEndTag) return false
    if (playlist.segments.size < 2) return false
    if (playlist.hasDiscontinuitySequence) return false
    if (playlist.lastSeenInitSegment != null) return false
    if (playlist.protectionSchemes != null) return false
    for (seg in playlist.segments) {
      if (seg.initializationSegment != null) return false
      if (seg.relativeDiscontinuitySequence != 0) return false
      if (seg.fullSegmentEncryptionKeyUri != null) return false
      if (seg.drmInitData != null) return false
      if (!isTsSegmentUrl(seg.url)) return false
    }
    return true
  }

  private fun attachInitSegment(playlist: HlsMediaPlaylist, initDataUri: String): HlsMediaPlaylist {
    val initSeg = HlsMediaPlaylist.Segment(initDataUri, 0L, C.LENGTH_UNSET.toLong(), null, null)
    val rewrittenSegments = playlist.segments.map { seg ->
      HlsMediaPlaylist.Segment(
        seg.url,
        initSeg,
        seg.title,
        seg.durationUs,
        seg.relativeDiscontinuitySequence,
        seg.relativeStartTimeUs,
        seg.drmInitData,
        seg.fullSegmentEncryptionKeyUri,
        seg.encryptionIV,
        seg.byteRangeOffset,
        seg.byteRangeLength,
        seg.hasGapTag,
        seg.parts,
      )
    }
    return HlsMediaPlaylist(
      playlist.playlistType,
      playlist.baseUri,
      playlist.tags,
      playlist.startOffsetUs,
      playlist.preciseStart,
      playlist.startTimeUs,
      playlist.hasDiscontinuitySequence,
      playlist.discontinuitySequence,
      playlist.mediaSequence,
      playlist.version,
      playlist.targetDurationUs,
      playlist.partTargetDurationUs,
      playlist.hasIndependentSegments,
      playlist.hasEndTag,
      playlist.hasProgramDateTime,
      playlist.protectionSchemes,
      rewrittenSegments,
      playlist.trailingParts,
      playlist.serverControl,
      playlist.renditionReports,
      playlist.interstitials,
      initSeg,
    )
  }

  internal companion object {
    private val sharedCache: MutableMap<String, CachedInitResult> =
      object : LinkedHashMap<String, CachedInitResult>(MAX_SYNTHESIS_CACHE_ENTRIES, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CachedInitResult>?): Boolean =
          size > MAX_SYNTHESIS_CACHE_ENTRIES
      }

    internal fun resetCacheForTest() {
      synchronized(sharedCache) { sharedCache.clear() }
    }
  }
}

package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.hls.playlist.DefaultHlsPlaylistParserFactory
import androidx.media3.exoplayer.hls.playlist.HlsMediaPlaylist
import androidx.media3.exoplayer.hls.playlist.HlsMultivariantPlaylist
import androidx.media3.exoplayer.hls.playlist.HlsPlaylist
import androidx.media3.exoplayer.hls.playlist.HlsPlaylistParserFactory
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.ParsingLoadable
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.extractor.ts.TsExtractor
import java.io.BufferedInputStream
import java.util.concurrent.atomic.AtomicBoolean

/** One `load`: what to play and how. Built from the JavaScript `LoadCommand`; never persisted. */
internal data class LoadRequest(
  val url: String,
  val headers: Map<String, String>,
  val live: Boolean,
  val startMs: Long?,
  val softwareAudio: Boolean,
  /** The response to an earlier guess was an HLS playlist; [url] is then the playlist after redirects. */
  val playlistDetected: Boolean = false,
)

/** IPTV MPEG-TS often lacks IDR flags and access unit delimiters. */
private const val TS_FLAGS =
  DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS

private fun tsCapableFactory(): DefaultExtractorsFactory = DefaultExtractorsFactory().setTsExtractorFlags(TS_FLAGS)

/** Only the MPEG-TS extractor, configured as [DefaultExtractorsFactory] does it, so nothing else sniffs the stream. */
@OptIn(UnstableApi::class)
private class TsOnlyExtractorsFactory : ExtractorsFactory {
  private val delegate = tsCapableFactory()

  override fun createExtractors(): Array<Extractor> = tsOnly(delegate.createExtractors())

  override fun createExtractors(uri: Uri, responseHeaders: Map<String, List<String>>): Array<Extractor> =
    tsOnly(delegate.createExtractors(uri, responseHeaders))

  override fun setSubtitleParserFactory(subtitleParserFactory: SubtitleParser.Factory): ExtractorsFactory {
    delegate.setSubtitleParserFactory(subtitleParserFactory)
    return this
  }

  private fun tsOnly(extractors: Array<Extractor>): Array<Extractor> =
    extractors.filterIsInstance<TsExtractor>().toTypedArray()
}

/**
 * Playlist parsers that call a readable body without the `#EXTM3U` header the provider's notice, whatever its
 * content type, so it takes the connection-limit path instead of failing as a malformed manifest.
 */
@OptIn(UnstableApi::class)
private class NoticeAwarePlaylistParserFactory : HlsPlaylistParserFactory {
  private val delegate = DefaultHlsPlaylistParserFactory()

  override fun createPlaylistParser(): ParsingLoadable.Parser<HlsPlaylist> = guarded(delegate.createPlaylistParser())

  override fun createPlaylistParser(
    multivariantPlaylist: HlsMultivariantPlaylist,
    previousMediaPlaylist: HlsMediaPlaylist?,
  ): ParsingLoadable.Parser<HlsPlaylist> =
    guarded(delegate.createPlaylistParser(multivariantPlaylist, previousMediaPlaylist))

  private fun guarded(parser: ParsingLoadable.Parser<HlsPlaylist>) =
    ParsingLoadable.Parser { uri, input ->
      val stream = BufferedInputStream(input, SNIFF_BYTES)
      stream.mark(SNIFF_BYTES)
      val prefix = ByteArray(SNIFF_BYTES)
      var filled = 0
      while (filled < prefix.size) {
        val read = stream.read(prefix, filled, prefix.size - filled)
        if (read < 0) break
        filled += read
      }
      stream.reset()
      if (isPlaylistNotice(prefix, filled)) throw ProviderNoticeException(null)
      parser.parse(uri, stream)
    }
}

/**
 * Applies [failsAtOnce]: a failure the playback service must see goes to it at once instead of Media3's silent
 * retries, which would also open more provider connections. [manifestLoaded] turns true once the media's timeline
 * is known (the first HLS manifest loaded).
 */
@OptIn(UnstableApi::class)
private class ServiceOwnedRetryPolicy(
  private val hls: Boolean,
  private val manifestLoaded: AtomicBoolean,
) : DefaultLoadErrorHandlingPolicy() {
  override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long {
    val error = loadErrorInfo.exception
    val refused = error is ProviderNoticeException || error is HlsDetectedException ||
      error is SupersededMediaException || error is HttpDataSource.InvalidContentTypeException
    val status = (error as? HttpDataSource.InvalidResponseCodeException)?.responseCode
    return if (failsAtOnce(status, refused, hls, manifestLoaded.get())) {
      C.TIME_UNSET
    } else {
      super.getRetryDelayMsFor(loadErrorInfo)
    }
  }
}

/** Builds the media source of one generation: every request passes the connection gate and the response sniffing. */
@OptIn(UnstableApi::class)
internal fun createMediaSource(
  request: LoadRequest,
  gate: ConnectionGate,
  generation: Long,
  manifestLoaded: AtomicBoolean,
): MediaSource {
  val type = sourceTypeFor(request.url, request.live, request.playlistDetected)
  val hls = type == SourceType.HLS
  val userAgentKey = request.headers.keys.firstOrNull { it.equals("User-Agent", ignoreCase = true) }
  val http = DefaultHttpDataSource.Factory()
    .setAllowCrossProtocolRedirects(true)
    .setUserAgent(userAgentKey?.let { request.headers[it] })
    .setDefaultRequestProperties(request.headers.filterKeys { it != userAgentKey })
  val sniffed = DataSource.Factory { SniffingDataSource(http.createDataSource(), hls) }
  val dataSources = GatedDataSourceFactory(sniffed, gate, generation)
  val item = MediaItem.fromUri(request.url)
  return when (type) {
    SourceType.HLS -> HlsMediaSource.Factory(dataSources).setPlaylistParserFactory(NoticeAwarePlaylistParserFactory())
    SourceType.TS -> ProgressiveMediaSource.Factory(dataSources, TsOnlyExtractorsFactory())
    SourceType.PROGRESSIVE -> ProgressiveMediaSource.Factory(dataSources, tsCapableFactory())
  }.setLoadErrorHandlingPolicy(ServiceOwnedRetryPolicy(hls, manifestLoaded))
    .createMediaSource(item)
}

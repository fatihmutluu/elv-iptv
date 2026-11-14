package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.hls.HlsDataSourceFactory
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.Extractor
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.extractor.text.SubtitleParser
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory
import androidx.media3.extractor.ts.TsExtractor
import java.util.concurrent.atomic.AtomicBoolean

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

/**
 * Builds the media source of one generation. Every request passes the connection gate and the response sniffing;
 * HLS requests are sniffed by their Media3 data type (playlist, segment, or unsniffed key).
 */
@OptIn(UnstableApi::class)
internal fun createMediaSource(
  request: LoadRequest,
  gate: ConnectionGate,
  generation: Long,
  manifestLoaded: AtomicBoolean,
): MediaSource {
  val type = request.sourceType()
  val userAgentKey = request.headers.keys.firstOrNull { it.equals("User-Agent", ignoreCase = true) }
  val http = DefaultHttpDataSource.Factory()
    .setAllowCrossProtocolRedirects(true)
    .setUserAgent(userAgentKey?.let { request.headers[it] })
    .setDefaultRequestProperties(request.headers.filterKeys { it != userAgentKey })
  val gated = { kind: RequestKind ->
    GatedDataSource(SniffingDataSource(http.createDataSource(), kind), gate, generation)
  }
  val progressive = DataSource.Factory { gated(RequestKind.PROGRESSIVE) }
  val factory: MediaSource.Factory = when (type) {
    SourceType.HLS -> HlsMediaSource.Factory(HlsDataSourceFactory { dataType -> gated(requestKindFor(dataType)) })
    SourceType.TS -> ProgressiveMediaSource.Factory(progressive, TsOnlyExtractorsFactory())
    SourceType.PROGRESSIVE -> ProgressiveMediaSource.Factory(progressive, tsCapableFactory())
  }
  return factory
    .setLoadErrorHandlingPolicy(ServiceOwnedRetryPolicy(type == SourceType.HLS, manifestLoaded))
    .createMediaSource(MediaItem.fromUri(request.url))
}

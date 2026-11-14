package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.datasource.HttpDataSource
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

/** One `load`: what to play and how. Built from the JavaScript `LoadCommand`; never persisted. */
internal data class LoadRequest(
  val url: String,
  val headers: Map<String, String>,
  val live: Boolean,
  val startMs: Long?,
  val softwareAudio: Boolean,
)

/** IPTV MPEG-TS often lacks IDR flags and access unit delimiters. */
private const val TS_FLAGS =
  DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS

private fun tsCapableFactory(): DefaultExtractorsFactory = DefaultExtractorsFactory().setTsExtractorFlags(TS_FLAGS)

/** Only the MPEG-TS extractor, configured like [DefaultExtractorsFactory] does it, so nothing else sniffs the stream. */
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
 * HTTP status errors, provider notices and superseded requests fail at once instead of Media3's silent retries: the
 * playback service owns recovery, and a retry would open another provider connection. Other I/O errors keep the
 * default retries, which ride out short network drops (ladder rung 0).
 */
@OptIn(UnstableApi::class)
private object ServiceOwnedRetryPolicy : DefaultLoadErrorHandlingPolicy() {
  override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long =
    when (loadErrorInfo.exception) {
      is HttpDataSource.InvalidResponseCodeException,
      is HttpDataSource.InvalidContentTypeException,
      is SupersededMediaException,
      -> C.TIME_UNSET
      else -> super.getRetryDelayMsFor(loadErrorInfo)
    }
}

/** Builds the media source of one generation: every request passes the connection gate. */
@OptIn(UnstableApi::class)
internal fun createMediaSource(request: LoadRequest, gate: ConnectionGate, generation: Long): MediaSource {
  val type = sourceTypeFor(request.url, request.live)
  val userAgentKey = request.headers.keys.firstOrNull { it.equals("User-Agent", ignoreCase = true) }
  val http = DefaultHttpDataSource.Factory()
    .setAllowCrossProtocolRedirects(true)
    .setUserAgent(userAgentKey?.let { request.headers[it] })
    .setDefaultRequestProperties(request.headers.filterKeys { it != userAgentKey })
    .setContentTypePredicate { contentType -> !isNoticeContentType(contentType, hls = type == SourceType.HLS) }
  val dataSources = GatedDataSourceFactory(http, gate, generation)
  val item = MediaItem.fromUri(request.url)
  return when (type) {
    SourceType.HLS -> HlsMediaSource.Factory(dataSources)
    SourceType.TS -> ProgressiveMediaSource.Factory(dataSources, TsOnlyExtractorsFactory())
    SourceType.PROGRESSIVE -> ProgressiveMediaSource.Factory(dataSources, tsCapableFactory())
  }.setLoadErrorHandlingPolicy(ServiceOwnedRetryPolicy).createMediaSource(item)
}

package io.github.fatihmutluu.elv.media3

import android.net.Uri
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.hls.DefaultHlsExtractorFactory
import androidx.media3.exoplayer.hls.HlsDataSourceFactory
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.hls.playlist.DefaultHlsPlaylistTracker
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
import okhttp3.Call

/** IPTV MPEG-TS often lacks IDR flags and access unit delimiters. */
internal const val TS_FLAGS =
  DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES or DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS

private const val TIMESTAMP_ADJUSTER_TIMEOUT_MS = 5_000L
private const val LIVE_HLS_STUCK_TARGET_DURATION_COEFFICIENT = 8.0
private const val NORMAL_RAM_TS_SEARCH_PACKETS = 1_200
internal const val PROGRESS_MIN_INTERVAL_MS = 500L

/**
 * Lightweight throttled [TransferListener] emitting cumulative network bytes received at most once per
 * [minIntervalMs] while [shouldReport] is true and bytes actually advanced (#314, #321).
 */
@OptIn(UnstableApi::class)
internal class ProgressTransferListener(
  private val minIntervalMs: Long = PROGRESS_MIN_INTERVAL_MS,
  private val clockMs: () -> Long = SystemClock::uptimeMillis,
  private val shouldReport: () -> Boolean = { true },
  private val onProgress: (bytesReceived: Long, atMs: Long) -> Unit,
) : TransferListener {
  private val lock = Any()
  private var totalBytes = 0L
  private var lastEmittedBytes = 0L
  private var lastEmittedAtMs = Long.MIN_VALUE

  override fun onTransferInitializing(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) = Unit

  override fun onTransferStart(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) = Unit

  override fun onBytesTransferred(
    source: DataSource,
    dataSpec: DataSpec,
    isNetwork: Boolean,
    bytesTransferred: Int,
  ) {
    if (!isNetwork || bytesTransferred <= 0) return
    val emitBytes: Long
    val emitAt: Long
    synchronized(lock) {
      totalBytes += bytesTransferred.toLong()
      if (!shouldReport() || totalBytes <= lastEmittedBytes) return
      val now = clockMs()
      if (lastEmittedAtMs != Long.MIN_VALUE && now - lastEmittedAtMs < minIntervalMs) return
      lastEmittedAtMs = now
      lastEmittedBytes = totalBytes
      emitBytes = totalBytes
      emitAt = now
    }
    onProgress(emitBytes, emitAt)
  }

  override fun onTransferEnd(source: DataSource, dataSpec: DataSpec, isNetwork: Boolean) = Unit
}

/** Scales MPEG-TS PCR/PTS search window by device RAM: 600 packets on low-RAM sticks, 1,200 packets otherwise. */
@OptIn(UnstableApi::class)
internal fun tsSearchBytesFor(lowRam: Boolean): Int =
  if (lowRam) TsExtractor.DEFAULT_TIMESTAMP_SEARCH_BYTES else NORMAL_RAM_TS_SEARCH_PACKETS * TsExtractor.TS_PACKET_SIZE

@OptIn(UnstableApi::class)
private fun tsCapableFactory(lowRam: Boolean): DefaultExtractorsFactory =
  DefaultExtractorsFactory()
    .setTsExtractorFlags(TS_FLAGS)
    .setTsExtractorTimestampSearchBytes(tsSearchBytesFor(lowRam))
    .setConstantBitrateSeekingEnabled(true)
    .setDisableArtworkMetadata(true)

/** Only the MPEG-TS extractor, configured as [tsCapableFactory] does it, so nothing else sniffs the stream. */
@OptIn(UnstableApi::class)
private class TsOnlyExtractorsFactory(lowRam: Boolean) : ExtractorsFactory {
  private val delegate = tsCapableFactory(lowRam)

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
 * Applies [failsAtOnce] to both variant fallback and load retries: a failure the playback service must see (auth 403,
 * panel limit codes, provider notices, or any HTTP failure before the first `#EXTM3U` manifest opened) aborts at once
 * instead of walking Variants `2..N` or opening Media3 retry connections.
 */
@OptIn(UnstableApi::class)
internal class ServiceOwnedRetryPolicy(
  private val hls: Boolean,
  private val manifestLoaded: AtomicBoolean,
) : DefaultLoadErrorHandlingPolicy() {
  override fun getFallbackSelectionFor(
    fallbackOptions: LoadErrorHandlingPolicy.FallbackOptions,
    loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo,
  ): LoadErrorHandlingPolicy.FallbackSelection? =
    if (shouldFailAtOnce(loadErrorInfo)) null else super.getFallbackSelectionFor(fallbackOptions, loadErrorInfo)

  override fun getRetryDelayMsFor(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Long =
    if (shouldFailAtOnce(loadErrorInfo)) C.TIME_UNSET else super.getRetryDelayMsFor(loadErrorInfo)

  private fun shouldFailAtOnce(loadErrorInfo: LoadErrorHandlingPolicy.LoadErrorInfo): Boolean {
    val error = loadErrorInfo.exception
    val loaded = manifestLoaded.get()
    val refused = isRefusedLoad(error, hls = hls, manifestLoaded = loaded)
    val status = causeOf<HttpDataSource.InvalidResponseCodeException>(error)?.responseCode
    return failsAtOnce(status, refused, hls, loaded)
  }
}

/**
 * The data sources of one media generation's requests, by kind: each one is an OkHttp request ([streamDataSource])
 * that passes the connection gate and the response sniffing and sends [LoadRequest.headers]. A force-close of the gate
 * cancels its call. [gateTimeoutMs] is the gate's backstop (see [GatedDataSource]).
 */
@OptIn(UnstableApi::class)
internal fun requestSources(
  request: LoadRequest,
  gate: ConnectionGate,
  generation: Long,
  client: Call.Factory,
  gateTimeoutMs: Long = GATE_TIMEOUT_MS,
  transferListener: TransferListener? = null,
  onManifestLoaded: () -> Unit = {},
): (RequestKind) -> DataSource = { kind ->
  val (http, calls) = streamDataSource(request.headers, client, request.url)
  val sniffing = SniffingDataSource(
    upstream = http,
    kind = kind,
    onManifestLoaded = if (kind == RequestKind.MANIFEST) onManifestLoaded else ({}),
  )
  GatedDataSource(sniffing, gate, generation, calls::cancel, gateTimeoutMs).also { gatedSource ->
    if (transferListener != null) gatedSource.addTransferListener(transferListener)
  }
}

/**
 * Builds the media source of one generation, tagged with [prepareSerial] as `MediaItem.mediaId`. Every request passes
 * the connection gate and the response sniffing; HLS requests wire [TS_FLAGS], bounded timestamp-adjuster initialization
 * and an `8.0` live playlist-stuck coefficient (#236, #247).
 */
@OptIn(UnstableApi::class)
internal fun createMediaSource(
  request: LoadRequest,
  gate: ConnectionGate,
  generation: Long,
  prepareSerial: Long,
  lowRam: Boolean,
  client: Call.Factory,
  transferListener: TransferListener? = null,
): MediaSource {
  val manifestLoaded = AtomicBoolean(false)
  val type = request.sourceType()
  val gated = requestSources(
    request = request,
    gate = gate,
    generation = generation,
    client = client,
    transferListener = transferListener,
  ) { manifestLoaded.set(true) }
  val progressive = DataSource.Factory { gated(RequestKind.PROGRESSIVE) }
  val factory: MediaSource.Factory = when (type) {
    SourceType.HLS ->
      HlsMediaSource.Factory(HlsDataSourceFactory { dataType -> gated(requestKindFor(dataType)) })
        .setExtractorFactory(DefaultHlsExtractorFactory(TS_FLAGS, true))
        .setTimestampAdjusterInitializationTimeoutMs(TIMESTAMP_ADJUSTER_TIMEOUT_MS)
        .apply {
          if (request.live) {
            setPlaylistTrackerFactory { dataSourceFactory, errorPolicy, parserFactory, cmcd, downloadExecutor ->
              DefaultHlsPlaylistTracker(
                dataSourceFactory,
                errorPolicy,
                parserFactory,
                cmcd,
                LIVE_HLS_STUCK_TARGET_DURATION_COEFFICIENT,
                downloadExecutor,
              )
            }
          }
        }
    SourceType.TS -> ProgressiveMediaSource.Factory(progressive, TsOnlyExtractorsFactory(lowRam))
    SourceType.PROGRESSIVE -> ProgressiveMediaSource.Factory(progressive, tsCapableFactory(lowRam))
  }
  val mediaItem = MediaItem.Builder()
    .setUri(request.url)
    .setMediaId(prepareSerial.toString())
    .build()
  return factory
    .setLoadErrorHandlingPolicy(ServiceOwnedRetryPolicy(type == SourceType.HLS, manifestLoaded))
    .createMediaSource(mediaItem)
}

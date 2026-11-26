package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSchemeDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.datasource.TransferListener
import androidx.media3.exoplayer.dash.DashMediaSource
import androidx.media3.exoplayer.dash.DefaultDashChunkSource
import androidx.media3.exoplayer.hls.DefaultHlsExtractorFactory
import androidx.media3.exoplayer.hls.HlsDataSourceFactory
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.hls.playlist.DefaultHlsPlaylistTracker
import androidx.media3.exoplayer.smoothstreaming.DefaultSsChunkSource
import androidx.media3.exoplayer.smoothstreaming.SsMediaSource
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.MergingMediaSource
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.exoplayer.source.SingleSampleMediaSource
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
private const val LOW_RAM_TS_SEARCH_PACKETS = 1_800
private const val NORMAL_RAM_TS_SEARCH_PACKETS = 2_400
internal const val PROGRESS_MIN_INTERVAL_MS = 500L

/**
 * Routes `data:` URIs (such as synthesized VOD HLS `#EXT-X-MAP` init segments, #183) directly to Media3's
 * [DataSchemeDataSource] without touching OkHttp or [ConnectionGate], delegating all other URIs lazily to
 * [defaultDataSourceFactory].
 */
@OptIn(UnstableApi::class)
internal class SchemeRoutingDataSource(
  private val defaultDataSourceFactory: () -> DataSource,
  private val dataSchemeDataSourceFactory: () -> DataSource = { DataSchemeDataSource() },
) : DataSource {
  private val transferListeners = mutableListOf<TransferListener>()
  private var activeDataSource: DataSource? = null

  override fun addTransferListener(transferListener: TransferListener) {
    transferListeners += transferListener
    activeDataSource?.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    val scheme = dataSpec.uri.normalizeScheme().scheme
    val source = if (DataSchemeDataSource.SCHEME_DATA == scheme) {
      dataSchemeDataSourceFactory()
    } else {
      defaultDataSourceFactory()
    }
    for (listener in transferListeners) {
      source.addTransferListener(listener)
    }
    activeDataSource = source
    return source.open(dataSpec)
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
    activeDataSource?.read(buffer, offset, length) ?: C.RESULT_END_OF_INPUT

  override fun getUri(): Uri? = activeDataSource?.uri

  override fun getResponseHeaders(): Map<String, List<String>> =
    activeDataSource?.responseHeaders ?: emptyMap()

  override fun close() {
    val active = activeDataSource ?: return
    activeDataSource = null
    active.close()
  }
}

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

/** Scales MPEG-TS PCR/PTS search window by device RAM: 1,800 packets on low-RAM sticks, 2,400 packets otherwise (#438). */
@OptIn(UnstableApi::class)
internal fun tsSearchBytesFor(lowRam: Boolean): Int =
  (if (lowRam) LOW_RAM_TS_SEARCH_PACKETS else NORMAL_RAM_TS_SEARCH_PACKETS) * TsExtractor.TS_PACKET_SIZE

@OptIn(UnstableApi::class)
internal fun tsCapableFactory(lowRam: Boolean, live: Boolean): DefaultExtractorsFactory =
  DefaultExtractorsFactory()
    .setTsExtractorFlags(TS_FLAGS)
    .setTsExtractorTimestampSearchBytes(tsSearchBytesFor(lowRam))
    .setConstantBitrateSeekingEnabled(true)
    .setConstantBitrateSeekingAlwaysEnabled(!live)
    .setDisableArtworkMetadata(true)

/** Only the MPEG-TS extractor, configured as [tsCapableFactory] does it, so nothing else sniffs the stream. */
@OptIn(UnstableApi::class)
private class TsOnlyExtractorsFactory(lowRam: Boolean, live: Boolean) : ExtractorsFactory {
  private val delegate = tsCapableFactory(lowRam, live)

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
 * Builds the media source of one generation, tagged with [prepareSerial] as `MediaItem.mediaId`. Every primary
 * request passes the connection gate and response sniffing; external sidecar subtitles (#308) are attached via
 * [MergingMediaSource] + [SingleSampleMediaSource] backed strictly by [StreamHttp.subtitleDataSourceFactory] so
 * primary stream credentials never leak onto subtitle requests.
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
  timeShiftRingBuffer: TimeShiftRingBuffer? = null,
  timeShiftTracker: TimeShiftWindowTracker? = null,
  context: Context? = null,
  extractorsDecorator: (ExtractorsFactory) -> ExtractorsFactory = { it },
  vodCache: VodEphemeralCache? = null,
  subtitleDataSourceFactoryProvider: (ExternalSubtitleConfig, Boolean) -> DataSource.Factory = { sub, legacyTls ->
    StreamHttp.subtitleDataSourceFactory(
      subtitleHeaders = sub.headers,
      allowLegacyTls = legacyTls,
      context = context,
    )
  },
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
  val isManagedLocalFile = request.url.startsWith("file://", ignoreCase = true)
  val activeVodCache = if (!request.live && !isManagedLocalFile) vodCache else null
  val progressiveBase = if (isManagedLocalFile) {
    FileDataSource.Factory()
  } else {
    DataSource.Factory {
      val upstream = gated(RequestKind.PROGRESSIVE)
      if (request.live && type == SourceType.TS && timeShiftRingBuffer != null) {
        TimeShiftDataSource(
          upstream = upstream,
          ringBuffer = timeShiftRingBuffer,
          tracker = timeShiftTracker,
        )
      } else {
        upstream
      }
    }
  }
  val progressive = activeVodCache?.wrapUpstream(progressiveBase) ?: progressiveBase
  val cachedSegmentFactory = activeVodCache?.wrapUpstream(DataSource.Factory { gated(RequestKind.SEGMENT) })
  val factory: MediaSource.Factory = when (type) {
    SourceType.HLS ->
      HlsMediaSource.Factory(
        HlsDataSourceFactory { dataType ->
          val upstreamFactory: () -> DataSource =
            if (cachedSegmentFactory != null && (dataType == C.DATA_TYPE_MEDIA || dataType == C.DATA_TYPE_MEDIA_INITIALIZATION)) {
              { cachedSegmentFactory.createDataSource() }
            } else {
              { gated(requestKindFor(dataType)) }
            }
          SchemeRoutingDataSource(defaultDataSourceFactory = upstreamFactory)
        }
      )
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
          } else {
            setPlaylistParserFactory(
              InitSynthesizingPlaylistParserFactory(
                probeSegment = { segmentUri ->
                  probeSegmentPrefix(gated(RequestKind.SEGMENT), segmentUri)
                }
              )
            )
          }
        }
    SourceType.DASH ->
      DashMediaSource.Factory(
        DefaultDashChunkSource.Factory(cachedSegmentFactory ?: DataSource.Factory { gated(RequestKind.SEGMENT) }),
        DataSource.Factory { gated(RequestKind.OTHER) },
      )
    SourceType.SMOOTH_STREAMING ->
      SsMediaSource.Factory(
        DefaultSsChunkSource.Factory(cachedSegmentFactory ?: DataSource.Factory { gated(RequestKind.SEGMENT) }),
        DataSource.Factory { gated(RequestKind.OTHER) },
      )
    SourceType.TS -> ProgressiveMediaSource.Factory(progressive, TsOnlyExtractorsFactory(lowRam, request.live))
    SourceType.PROGRESSIVE ->
      ProgressiveMediaSource.Factory(progressive, extractorsDecorator(tsCapableFactory(lowRam, request.live)))
  }
  val drmConfig = request.drm
  if (drmConfig != null) {
    val drmHttpFactory = DataSource.Factory {
      streamDataSource(drmConfig.licenseHeaders, client, drmConfig.licenseUrl).first
    }
    buildDrmSessionManagerProvider(drmConfig, drmHttpFactory)?.let { provider ->
      factory.setDrmSessionManagerProvider(provider)
    }
  }
  val mediaItem = MediaItem.Builder()
    .setUri(request.url)
    .setMediaId(prepareSerial.toString())
    .build()
  val primarySource = factory
    .setLoadErrorHandlingPolicy(ServiceOwnedRetryPolicy(type == SourceType.HLS, manifestLoaded))
    .createMediaSource(mediaItem)

  val validExternals = request.externalSubtitles.filter { isAllowedExternalSubtitleUri(it.uri) }
  if (validExternals.isEmpty()) return primarySource

  val subtitleSources = validExternals.map { sub ->
    val subConfig = MediaItem.SubtitleConfiguration.Builder(Uri.parse(sub.uri))
      .setId(sub.trackId)
      .setMimeType(sub.mimeType)
      .setLanguage(sub.language)
      .setLabel(sub.label)
      .setRoleFlags(C.ROLE_FLAG_SUBTITLE)
      .build()
    SingleSampleMediaSource.Factory(subtitleDataSourceFactoryProvider(sub, request.allowLegacyTls))
      .setTrackId(sub.trackId)
      .setTreatLoadErrorsAsEndOfStream(true)
      .createMediaSource(subConfig, C.TIME_UNSET)
  }
  return MergingMediaSource(primarySource, *subtitleSources.toTypedArray())
}

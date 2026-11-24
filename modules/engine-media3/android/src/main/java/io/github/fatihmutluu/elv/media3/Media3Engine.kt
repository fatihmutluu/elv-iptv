package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.Surface
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.text.Cue
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

private const val TAG = "ElvMedia3"
private const val EVENT = "onEngineEvent"
private const val REMOTE_ACTION_EVENT = "onRemoteMediaAction"
private const val SUBTITLE_DELAY_TICK_MS = 50L
private val ENGINE_IDS = AtomicInteger(0)

/**
 * The `PlayerEngine` of player core spec 5.1 on Media3, one per player screen (an Expo shared object). ExoPlayer
 * lives on this engine's own playback thread (its application looper): JavaScript calls post there and return at
 * once, and every event is sent from there, tagged with the current attempt token.
 */
@OptIn(UnstableApi::class)
class Media3Engine : SharedObject {
  private val engineId: Int = ENGINE_IDS.incrementAndGet()
  private val hasAppContext: Boolean
  private val onDisposed: (Media3Engine) -> Unit
  private var lowRamDevice = false
  private var appCacheDir: File? = null
  private var activeTimeShiftBuffer: TimeShiftRingBuffer? = null
  private var activeTimeShiftTracker: TimeShiftWindowTracker? = null
  private lateinit var playerFactory: PlayerFactory
  private lateinit var tracksBridge: TrackSelectorBridge
  private lateinit var mediaSessionController: MediaSessionController

  constructor(context: Context, appContext: AppContext, onDisposed: (Media3Engine) -> Unit) : super(appContext) {
    this.hasAppContext = true
    this.onDisposed = onDisposed
    initEngine(context)
  }

  internal constructor(context: Context, onDisposed: (Media3Engine) -> Unit = {}) : super() {
    this.hasAppContext = false
    this.onDisposed = onDisposed
    initEngine(context)
  }

  private val thread = HandlerThread("ElvMedia3").apply { start() }
  private val handler = Handler(thread.looper)
  private val commandFence = CommandFence()
  private val closer = createCloserExecutor()
  internal val gate = ConnectionGate(closer)
  private val http = engineHttpClient()
  private val legacyHttp = legacyTlsClient(http)
  internal val codecPolicy = CodecPolicy()
  private val audioEffects = AudioEffectsController(handler)
  private val audioDelayUs = AtomicLong(0L)
  private val subtitleCueBuffer = TimedSubtitleCueBuffer()
  private var lastDeliveredCues: List<Cue>? = null
  private val subtitleTick = Runnable { refreshDelayedSubtitles() }
  private val fence = PrepareFence()
  private val surfaces = SurfaceController()
  private val reporter = EventReporter(
    handler = handler, fence = fence, hasInvalidAttachedSurface = surfaces::hasInvalidAttachedSurface,
    send = ::sendEvent, onHlsDetected = ::playAsHls, onBehindLiveWindow = ::recoverBehindLiveWindow,
    onAudioFocusDenied = ::handleAudioFocusDenied, onVideoCodecFailed = codecPolicy::recordVideoCodecFailure,
    onDolbyVisionFailed = codecPolicy::recordDolbyVisionFallback, onAudioCodecFailed = ::handleAudioCodecFailed,
    onFirstFrame = surfaces::onFramed, onCue = surfaces::onCue,
    onTerminalError = { mediaSessionController.onPlaybackStopped() },
  )
  private val pictures = object : Player.Listener {
    override fun onVideoSizeChanged(videoSize: VideoSize) { if (fence.isRendererOpen) surfaces.onVideoSizeChanged(videoSize) }
    override fun onTracksChanged(tracks: Tracks) {
      val current = player ?: return
      if (request != null && fence.acceptsPlayer(current)) {
        tracksBridge.onTracksChanged(current, tracks)
        audioEffects.onTracksChanged(tracks)
      }
    }
    override fun onCues(cueGroup: CueGroup) {
      val current = player ?: return
      if (request != null && fence.isRendererOpen && !tracksBridge.isTextDisabled) {
        val sanitized = sanitizeCues(cueGroup.cues, filterSdh = request?.filterSdhSubtitles == true)
        val positionUs = current.currentPosition.coerceAtLeast(0L) * 1_000L
        subtitleCueBuffer.record(positionUs, sanitized)
        applyResolvedSubtitleCues(current)
      }
    }
    override fun onAudioSessionIdChanged(audioSessionId: Int) = audioEffects.onAudioSessionIdChanged(audioSessionId)
    override fun onIsPlayingChanged(isPlaying: Boolean) {
      val current = player ?: return
      if (request != null && fence.acceptsPlayer(current)) {
        mediaSessionController.updatePlayingState(isPlaying)
        if (isPlaying) {
          applyResolvedSubtitleCues(current)
        } else {
          handler.removeCallbacks(subtitleTick)
        }
      }
    }
    override fun onPlaybackStateChanged(playbackState: Int) {
      val current = player ?: return
      if (request != null && fence.acceptsPlayer(current) && playbackState == Player.STATE_READY) {
        applyResolvedSubtitleCues(current)
      }
    }
  }

  @Volatile
  internal var eventObserverForTest: ((Map<String, Any?>) -> Unit)? = null

  @Volatile
  internal var remoteActionObserverForTest: ((Map<String, Any?>) -> Unit)? = null

  private var player: ExoPlayer? = null
  private var playerSoftwareAudio = false
  private var playerPreferHevc = false
  private var playerStreamKind: StreamKind = StreamKind.VOD
  private var playerBufferPreset: BufferPreset = BufferPreset.AUTO
  private var playerDecoderMode: VideoDecoderMode = VideoDecoderMode.AUTO
  private var currentSpeed: Float = PlaybackSpeedPolicy.DEFAULT_SPEED
  private var pitchLock: Boolean = true
  private var audioFallbackAttempted = false
  private var pendingRebuildDeferred = false
  private var activeEpoch = 0
  private var token = 0
  private var generation = 0L
  private var prepares = 0L
  private var request: LoadRequest? = null
  private var lastVodPositionMs: Long? = null

  override val releasesAfterPendingViewUpdates: Boolean = true

  /** True once the off-UI-thread `MediaCodecList` probe confirms hardware 4K HEVC decoding (#150). */
  val supportsHardwareHevc4k: Boolean get() = codecPolicy.supportsHardwareHevc4k

  internal fun load(attempt: Int, next: LoadRequest) {
    val epoch = commandFence.recordLoad(attempt, next) ?: return
    post {
      val action = commandFence.beginMedia(epoch)
      if (action !is CommandFence.MediaAction.Run) return@post
      activeEpoch = action.epoch
      reporter.end()
      tearDownTimeShiftCache()
      if (!isAllowedPlaybackUrl(next.url)) {
        rejectDisallowedUrl(attempt, rebuildFirst = action.rebuildFirst)
        return@post
      }
      val normalized = next.copy(url = next.url.trim())
      if (request?.url != normalized.url && !normalized.preferHevcOverDolbyVision) codecPolicy.clearDolbyVisionFallback()
      token = attempt
      request = normalized
      audioFallbackAttempted = false
      audioDelayUs.set(0L)
      clearSubtitles(resetDelay = true)
      currentSpeed = PlaybackSpeedPolicy.DEFAULT_SPEED
      lastVodPositionMs = if (normalized.live) null else normalized.startMs?.coerceAtLeast(0L)
      tracksBridge.onLoad(normalized)
      surfaces.onLoad()
      prepare(normalized, normalized.startMs, forceRebuild = action.rebuildFirst || pendingRebuildDeferred)
    }
  }

  fun retry(attempt: Int) {
    val epoch = commandFence.recordRetry(attempt) ?: return
    post {
      val action = commandFence.beginMedia(epoch)
      if (action !is CommandFence.MediaAction.Run) return@post
      activeEpoch = action.epoch
      adopt(attempt)
      val current = request ?: action.request ?: return@post
      if (!isAllowedPlaybackUrl(current.url)) {
        rejectDisallowedUrl(attempt, rebuildFirst = action.rebuildFirst)
        return@post
      }
      val normalized = current.copy(url = current.url.trim())
      request = normalized
      snapshotVodPosition()
      prepare(
        normalized,
        currentVodPositionOrStart(normalized),
        forceRebuild = action.rebuildFirst || pendingRebuildDeferred,
      )
    }
  }

  fun play(attempt: Int) = postInEpoch(attempt) {
    player?.play()
    if (request != null) mediaSessionController.onPlaybackActive()
  }
  fun pause(attempt: Int) = postInEpoch(attempt) { player?.pause() }

  fun seek(attempt: Int, positionMs: Long) = postInEpoch(attempt) {
    val current = player ?: return@postInEpoch
    if (request?.live == true) {
      val ringWindow = activeTimeShiftTracker?.currentWindow()
      val ringSeekable = ringWindow != null && ringWindow.bufferedWindowMs >= MIN_LIVE_TIMESHIFT_WINDOW_MS
      val isSeekable = current.isCurrentMediaItemSeekable || ringSeekable
      if (!isSeekable) return@postInEpoch
      val edgeMs = if (current.isCurrentMediaItemSeekable && current.duration != C.TIME_UNSET) {
        current.duration
      } else {
        ringWindow?.liveEdgeMs ?: current.duration
      }
      val minStartMs = if (current.isCurrentMediaItemSeekable) 0L else (ringWindow?.liveSeekableStartMs ?: 0L)
      when (val resolution = resolveMedia3LiveSeek(positionMs, isSeekable, edgeMs, minStartMs = minStartMs)) {
        LiveSeekResolution.Ignore -> return@postInEpoch
        LiveSeekResolution.JumpToDefaultLiveEdge -> {
          clearSubtitles(resetDelay = false)
          if (current.isCurrentMediaItemSeekable) {
            current.seekToDefaultPosition()
          } else if (edgeMs != C.TIME_UNSET && edgeMs >= 0L) {
            current.seekTo(edgeMs)
          }
        }
        is LiveSeekResolution.SeekTo -> {
          clearSubtitles(resetDelay = false)
          current.seekTo(resolution.positionMs)
        }
      }
      return@postInEpoch
    }
    if (!current.isCurrentMediaItemSeekable) return@postInEpoch
    val clamped = positionMs.coerceAtLeast(0L)
    if (request?.live == false) {
      lastVodPositionMs = clamped
      current.setSeekParameters(vodSeekParametersFor(clamped, current.currentPosition))
    }
    clearSubtitles(resetDelay = false)
    current.seekTo(clamped)
  }

  /** Enables Media3's scrubbing mode on VOD streams only; reset unconditionally on stop/load/retry/recreate (#222). */
  fun setScrubbing(attempt: Int, scrubbing: Boolean) = postInEpoch(attempt) {
    player?.let { it.isScrubbingModeEnabled = scrubbing && request?.live == false }
  }

  /** Applies clamped `[0.25, 4.0]` playback speed on VOD streams only with current [pitchLock] (#264). */
  fun setSpeed(attempt: Int, rate: Double) = postInEpoch(attempt) {
    if (request?.live != false) return@postInEpoch
    currentSpeed = PlaybackSpeedPolicy.clampSpeed(rate)
    player?.playbackParameters = PlaybackSpeedPolicy.parameters(currentSpeed, pitchLock)
  }

  /** Updates pitch-lock preference and re-applies [PlaybackParameters] immediately while VOD is active (#264). */
  fun setPitchLock(locked: Boolean) = post {
    pitchLock = locked
    if (request?.live == false) {
      player?.playbackParameters = PlaybackSpeedPolicy.parameters(currentSpeed, pitchLock)
    }
  }

  /** Updates Android lock-screen / Bluetooth `MediaSession` metadata and track-stepping state (#412). */
  internal fun setMediaMetadata(payload: MediaSessionMetadataPayload?) = post {
    mediaSessionController.setMediaMetadata(payload)
  }

  /** Enables or disables opt-in background audio playback across task removal (#412). */
  fun setBackgroundAudioEnabled(enabled: Boolean) = post {
    mediaSessionController.setBackgroundAudioEnabled(enabled)
  }

  /** Configures stereo loudness boost in dB via [AudioEffectsController] (multichannel-safe, #260). */
  fun setAudioBoostDb(attempt: Int, db: Double) = postInEpoch(attempt) { if (db.isFinite()) audioEffects.setBoostDb(db) }

  fun selectAudioTrack(attempt: Int, id: String) = postInEpoch(attempt) { tracksBridge.selectAudioTrack(player, id) }
  fun selectSubtitleTrack(attempt: Int, id: String?) = postInEpoch(attempt) { tracksBridge.selectSubtitleTrack(player, id) }

  /** Shifts audio timing relative to video in milliseconds (`[-30_000, 30_000]`) without buffer reallocation (#203, #59). */
  fun setAudioDelay(attempt: Int, delayMs: Long) = postInEpoch(attempt) {
    audioDelayUs.set(syncDelayMsToUs(delayMs))
  }

  /** Shifts subtitle cue timing in milliseconds (`[-30_000, 30_000]`) without flushing buffered cues (#203, #59). */
  fun setSubtitleDelay(attempt: Int, delayMs: Long) = postInEpoch(attempt) {
    subtitleCueBuffer.setDelayMs(delayMs)
    player?.let { applyResolvedSubtitleCues(it) }
  }

  /** Constrains or selects an adaptive video rendition ID, or restores automatic ABR when [id] is `null` (#59). */
  fun selectVideoQuality(attempt: Int, id: String?) = postInEpoch(attempt) {
    tracksBridge.selectVideoQuality(player, id)
  }

  fun stop(attempt: Int) {
    val epoch = commandFence.recordStop(attempt) ?: return
    post {
      if (!commandFence.canRunStop()) return@post
      if (epoch > activeEpoch) activeEpoch = epoch
      adopt(attempt)
      clearSessionState()
      player?.stop()
      player?.clearMediaItems()
    }
  }

  fun recreate(attempt: Int) {
    val epoch = commandFence.recordRecreate(attempt) ?: return
    post {
      val action = commandFence.beginRecreate(epoch)
      if (action !is CommandFence.RecreateAction.Run) return@post
      activeEpoch = action.epoch
      adopt(attempt)
      snapshotVodPosition()
      player?.isScrubbingModeEnabled = false
      tracksBridge.onPrepareReuse()
      clearSubtitles(resetDelay = false)
      tearDownTimeShiftCache()
      reporter.end()
      beginGeneration()
      pendingRebuildDeferred = false
      replacePlayer(playerSoftwareAudio, playerPreferHevc, playerStreamKind, playerBufferPreset, playerDecoderMode)
    }
  }

  fun attachSurface(next: Surface) {
    surfaces.offerSurface(next)
    post { surfaces.attachPendingSurface(next, player, ::sendSurfaceChange) }
  }

  fun detachSurface(old: Surface, timeoutMs: Long): Boolean {
    surfaces.clearOfferedIfSame(old)
    if (commandFence.isDisposedNow) return true
    if (Looper.myLooper() === thread.looper) {
      detachNow(old)
      return true
    }
    val detached = CountDownLatch(1)
    val posted = handler.postAtFrontOfQueue {
      try {
        detachNow(old)
      } finally {
        detached.countDown()
      }
    }
    return !posted || detached.await(timeoutMs, TimeUnit.MILLISECONDS)
  }

  internal fun bindView(sink: ViewSink) = post { surfaces.bindView(sink) }
  internal fun unbindView(sink: ViewSink) = post { surfaces.unbindView(sink) }
  internal fun cueScreen(cue: ScreenCue, played: Boolean) = post { surfaces.onCue(cue, played) }

  fun dispose() {
    if (!commandFence.markDisposed()) return
    onDisposed(this)
    http.dispatcher.cancelAll()
    handler.post {
      clearSessionState()
      mediaSessionController.dispose()
      http.dispatcher.cancelAll()
      codecPolicy.stopAudioCapabilities()
      releasePlayer()
      audioEffects.release()
      http.dispatcher.executorService.shutdown()
      closer.shutdown()
      thread.quitSafely()
    }
  }

  override fun sharedObjectDidRelease() = dispose()

  private fun postInEpoch(attempt: Int, action: () -> Unit) {
    val epoch = commandFence.recordInEpochCommand(attempt) ?: return
    post {
      if (!commandFence.beginInEpoch(epoch)) return@post
      adopt(attempt)
      action()
    }
  }

  private fun post(command: () -> Unit) {
    handler.post {
      if (commandFence.isDisposedNow) return@post
      try {
        command()
      } catch (e: Exception) {
        reporter.end()
        mediaSessionController.onPlaybackStopped()
        Log.e(TAG, "engine command failed: ${e.javaClass.simpleName}")
        sendEvent(mapOf("type" to "error", "error" to mapOf("code" to "unknown", "detail" to e.javaClass.simpleName)))
        surfaces.onCue(ScreenCue.ERROR, played = false)
      }
    }
  }

  private fun detachNow(old: Surface) = surfaces.detachNow(old, player, ::sendSurfaceChange)
  private fun sendSurfaceChange(change: String) = sendEvent(mapOf("type" to "surface", "change" to change))

  private fun rejectDisallowedUrl(attempt: Int, rebuildFirst: Boolean) {
    if (rebuildFirst) pendingRebuildDeferred = true
    token = attempt
    clearSessionState()
    player?.stop()
    player?.clearMediaItems()
    Log.w(TAG, "rejected playback URL with disallowed scheme")
    sendEvent(
      mapOf(
        "type" to "error",
        "error" to mapOf("code" to "unsupported-format", "detail" to "disallowed-url-scheme"),
      ),
    )
    surfaces.onCue(ScreenCue.ERROR, played = false)
  }

  private fun clearSessionState() {
    reporter.end()
    tearDownTimeShiftCache()
    player?.isScrubbingModeEnabled = false
    currentSpeed = PlaybackSpeedPolicy.DEFAULT_SPEED
    player?.playbackParameters = PlaybackParameters.DEFAULT
    audioDelayUs.set(0L)
    clearSubtitles(resetDelay = true)
    audioEffects.onStop()
    mediaSessionController.onPlaybackStopped()
    request = null
    audioFallbackAttempted = false
    lastVodPositionMs = null
    tracksBridge.onStop()
    surfaces.onStop()
    beginGeneration()
  }

  private fun clearSubtitles(resetDelay: Boolean) {
    handler.removeCallbacks(subtitleTick)
    if (resetDelay) subtitleCueBuffer.reset() else subtitleCueBuffer.clearCues()
    lastDeliveredCues = null
    surfaces.clearCues()
  }

  private fun applyResolvedSubtitleCues(current: ExoPlayer) {
    handler.removeCallbacks(subtitleTick)
    if (request == null || !fence.isRendererOpen || tracksBridge.isTextDisabled) return
    val positionUs = current.currentPosition.coerceAtLeast(0L) * 1_000L
    val resolved = subtitleCueBuffer.resolveCues(positionUs)
    if (resolved != lastDeliveredCues) {
      lastDeliveredCues = resolved
      surfaces.onCues(resolved)
    }
    if (current.isPlaying && subtitleCueBuffer.delayMs != 0L && subtitleCueBuffer.isNotEmpty) {
      handler.postDelayed(subtitleTick, SUBTITLE_DELAY_TICK_MS)
    }
  }

  private fun refreshDelayedSubtitles() {
    val current = player ?: return
    applyResolvedSubtitleCues(current)
  }

  private fun stopFromTaskRemoved() {
    post {
      clearSessionState()
      player?.stop()
      player?.clearMediaItems()
    }
  }

  private fun stopFromRemoteController() {
    val runStop = {
      if (!commandFence.isDisposedNow) {
        clearSessionState()
        player?.stop()
        player?.clearMediaItems()
        sendRemoteMediaAction(SessionForwardingPlayer.ACTION_STOP)
      }
    }
    if (Looper.myLooper() === thread.looper) runStop() else post(runStop)
  }

  private fun sendRemoteMediaAction(action: String) {
    if (commandFence.isDisposedNow) return
    val payload = mapOf("engineId" to engineId, "action" to action)
    remoteActionObserverForTest?.invoke(payload)
    if (hasAppContext) emit(REMOTE_ACTION_EVENT, payload)
  }

  private fun snapshotVodPosition() {
    val p = player ?: return
    if (request?.live == false && p.mediaItemCount > 0) lastVodPositionMs = p.currentPosition.coerceAtLeast(0L)
  }

  private fun currentVodPositionOrStart(req: LoadRequest): Long? = if (req.live) null else (lastVodPositionMs ?: req.startMs)
  private fun adopt(attempt: Int) { if (attempt > token) token = attempt }

  private fun sendEvent(fields: Map<String, Any?>) {
    val stamped = commandFence.filterOutboundToken(fields["type"] as? String, activeEpoch, token) ?: return
    val payload = fields + ("attempt" to stamped)
    eventObserverForTest?.invoke(payload)
    if (hasAppContext) emit(EVENT, payload)
  }

  private fun beginGeneration() {
    generation += 1
    gate.beginMedia(generation)
  }

  private fun tearDownTimeShiftCache() {
    activeTimeShiftBuffer?.close()
    activeTimeShiftBuffer = null
    activeTimeShiftTracker = null
  }

  private fun initEngine(context: Context) {
    val profile = readDeviceMemoryProfile(context)
    lowRamDevice = profile.lowRam
    val cacheDir: File? = context.cacheDir
    appCacheDir = cacheDir
    cacheDir?.let { TimeShiftRingBuffer.purgeOrphansOnStartup(it) }
    playerFactory = PlayerFactory(
      context = context,
      looper = thread.looper,
      loadControlForStream = { kind: StreamKind, preset: BufferPreset -> profile.loadControl(kind, preset) },
      codecPolicy = codecPolicy,
      audioDelayUs = audioDelayUs,
    )
    tracksBridge = TrackSelectorBridge(
      isActivePlayer = { candidate -> candidate === player && fence.acceptsPlayer(candidate) },
      onTracks = { snapshot -> if (request != null) sendEvent(mapOf("type" to "tracks", "tracks" to snapshot)) },
      onClearCues = { clearSubtitles(resetDelay = false) },
      captioningEnabled = { isSystemCaptioningEnabled(context) },
    )
    mediaSessionController = MediaSessionController(
      context = context,
      onRemoteMediaAction = ::sendRemoteMediaAction,
      onTaskRemovedStop = ::stopFromTaskRemoved,
      onRemoteStop = ::stopFromRemoteController,
    )
    post {
      codecPolicy.startAudioCapabilities(context, handler)
      codecPolicy.startHardwareHevc4kProbe(handler)
      player = buildPlayer(softwareAudio = false)
    }
  }

  private fun playAsHls() {
    val detectedIn = generation
    post {
      val current = request ?: return@post
      if (detectedIn != generation || current.playlistDetected) return@post
      rememberHlsUrl(current.url)
      val next = current.asDetectedPlaylist()
      request = next
      prepare(next, currentVodPositionOrStart(next), newGeneration = true)
    }
  }

  private fun recoverBehindLiveWindow() {
    val current = player ?: return
    if (request?.live != true) return
    clearSubtitles(resetDelay = false)
    current.seekToDefaultPosition()
    current.prepare()
  }

  private fun handleAudioFocusDenied(): Boolean {
    if (!playerFactory.audioFocusAllowed) return false
    playerFactory.disableAudioFocus()
    val current = request ?: return true
    snapshotVodPosition()
    prepare(current, currentVodPositionOrStart(current), newGeneration = true, forceRebuild = true)
    return true
  }

  private fun handleAudioCodecFailed(): Boolean {
    if (playerSoftwareAudio || audioFallbackAttempted) return false
    val current = request ?: return false
    audioFallbackAttempted = true
    snapshotVodPosition()
    val next = current.copy(softwareAudio = true)
    request = next
    prepare(next, currentVodPositionOrStart(next), newGeneration = true)
    return true
  }

  private fun prepare(next: LoadRequest, positionMs: Long?, newGeneration: Boolean = true, forceRebuild: Boolean = false) {
    reporter.end()
    tearDownTimeShiftCache()
    tracksBridge.onPrepareReuse()
    clearSubtitles(resetDelay = false)
    if (newGeneration) beginGeneration()
    val existing = player
    val streamKind = next.streamKind()
    val bufferPreset = next.bufferPreset
    val decoderMode = next.decoderMode
    val terminal = existing != null && (existing.playbackState == Player.STATE_ENDED || existing.playerError != null)
    val rebuild = forceRebuild || existing == null || terminal || playerSoftwareAudio != next.softwareAudio ||
      playerPreferHevc != next.preferHevcOverDolbyVision || playerStreamKind != streamKind ||
      playerBufferPreset != bufferPreset || playerDecoderMode != decoderMode
    if (rebuild) {
      pendingRebuildDeferred = false
      replacePlayer(next.softwareAudio, next.preferHevcOverDolbyVision, streamKind, bufferPreset, decoderMode)
    } else {
      existing.isScrubbingModeEnabled = false
      existing.stop()
    }
    val current = player ?: return
    current.isScrubbingModeEnabled = false
    current.playbackParameters =
      if (next.live) PlaybackParameters.DEFAULT else PlaybackSpeedPolicy.parameters(currentSpeed, pitchLock)
    current.setSeekParameters(if (next.live) SeekParameters.EXACT else vodSeekParametersFor(positionMs ?: 0L, null))
    tracksBridge.applyInitialParameters(current)
    val serial = ++prepares
    val prepareGen = generation
    val isLiveTs = next.live && next.sourceType() == SourceType.TS
    if (isLiveTs) {
      appCacheDir?.let { cacheDir ->
        val ring = TimeShiftRingBuffer.create(cacheDir, lowRam = lowRamDevice)
        activeTimeShiftBuffer = ring
        activeTimeShiftTracker = TimeShiftWindowTracker(ring)
      }
    }
    reporter.begin(
      current,
      next.live,
      prepareSerial = serial,
      reused = !rebuild,
      isLiveTs = isLiveTs,
      ringWindowProvider = activeTimeShiftTracker?.let { tracker -> tracker::currentWindow },
    )
    val transferListener = ProgressTransferListener(shouldReport = { reporter.isWaitingForMedia }) { bytes, atMs ->
      post { if (generation == prepareGen) reporter.onTransferProgress(bytes, atMs) }
    }
    val httpClient = if (next.allowLegacyTls) legacyHttp else http
    val source = createMediaSource(
      next,
      gate,
      prepareGen,
      serial,
      lowRamDevice,
      httpClient,
      transferListener,
      timeShiftRingBuffer = activeTimeShiftBuffer,
      timeShiftTracker = activeTimeShiftTracker,
    )
    if (positionMs == null) current.setMediaSource(source, true) else current.setMediaSource(source, positionMs)
    current.playWhenReady = true
    current.prepare()
    mediaSessionController.onPlaybackActive()
  }

  private fun buildPlayer(
    softwareAudio: Boolean,
    preferHevc: Boolean = false,
    streamKind: StreamKind = StreamKind.VOD,
    bufferPreset: BufferPreset = BufferPreset.AUTO,
    decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
  ): ExoPlayer {
    playerSoftwareAudio = softwareAudio
    playerPreferHevc = preferHevc
    playerStreamKind = streamKind
    playerBufferPreset = bufferPreset
    playerDecoderMode = decoderMode
    return playerFactory.build(
      softwareAudio = softwareAudio,
      preferHevcOverDolbyVision = preferHevc,
      live = streamKind != StreamKind.VOD,
      streamKind = streamKind,
      bufferPreset = bufferPreset,
      decoderMode = decoderMode,
    ).also { built ->
      built.addListener(reporter)
      built.addAnalyticsListener(reporter)
      built.addListener(pictures)
      built.playbackParameters =
        if (streamKind == StreamKind.VOD) PlaybackSpeedPolicy.parameters(currentSpeed, pitchLock) else PlaybackParameters.DEFAULT
      audioEffects.onAudioSessionIdChanged(built.audioSessionId)
      surfaces.attachToNewPlayer(built, ::sendSurfaceChange)
      mediaSessionController.onPlayerChanged(built)
    }
  }

  private fun replacePlayer(
    softwareAudio: Boolean,
    preferHevc: Boolean = false,
    streamKind: StreamKind = StreamKind.VOD,
    bufferPreset: BufferPreset = BufferPreset.AUTO,
    decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
  ): ExoPlayer {
    val old = player
    player = null
    if (old != null) {
      old.isScrubbingModeEnabled = false
      old.removeListener(reporter)
      old.removeAnalyticsListener(reporter)
      old.removeListener(pictures)
      old.clearVideoSurface()
      audioEffects.onStop()
      audioEffects.onAudioSessionIdChanged(C.AUDIO_SESSION_ID_UNSET)
      mediaSessionController.updatePlayingState(false)
    }
    try {
      val built = buildPlayer(softwareAudio, preferHevc, streamKind, bufferPreset, decoderMode)
      player = built
      return built
    } finally {
      if (old != null) {
        if (player == null) {
          mediaSessionController.onPlaybackStopped()
        }
        old.release()
        gate.dropForced()
      }
    }
  }

  private fun releasePlayer() {
    val old = player ?: return
    player = null
    old.isScrubbingModeEnabled = false
    old.removeListener(reporter)
    old.removeAnalyticsListener(reporter)
    old.removeListener(pictures)
    audioEffects.onStop()
    audioEffects.onAudioSessionIdChanged(C.AUDIO_SESSION_ID_UNSET)
    mediaSessionController.updatePlayingState(false)
    old.release()
    gate.dropForced()
  }
}

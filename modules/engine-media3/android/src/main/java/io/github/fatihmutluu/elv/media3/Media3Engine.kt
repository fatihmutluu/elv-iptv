package io.github.fatihmutluu.elv.media3

import android.app.Activity
import android.content.Context
import android.os.Build
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
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.text.TextOutput
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
  private lateinit var appContextRef: Context
  private lateinit var externalSubLoader: ExternalSubtitleLoader
  private var activeTimeShiftBuffer: TimeShiftRingBuffer? = null
  private var activeTimeShiftTracker: TimeShiftWindowTracker? = null
  private lateinit var playerFactory: PlayerFactory
  private lateinit var tracksBridge: TrackSelectorBridge
  private lateinit var mediaSessionController: MediaSessionController
  private lateinit var displayRefresh: DisplayRefreshController

  private val assOverlay: AssOverlayBridge

  constructor(
    context: Context, appContext: AppContext,
    options: MultiViewEngineOptions = MultiViewEngineOptions(), onDisposed: (Media3Engine) -> Unit,
  ) : super(appContext) {
    this.hasAppContext = true
    this.onDisposed = onDisposed
    this.assOverlay = AssOverlayBridge()
    initEngine(context, options, activityProvider = { appContext.currentActivity })
  }

  internal constructor(
    context: Context, onDisposed: (Media3Engine) -> Unit = {},
    assOverlay: AssOverlayBridge = AssOverlayBridge(), options: MultiViewEngineOptions = MultiViewEngineOptions(),
    activityProvider: () -> Activity? = { null },
  ) : super() {
    this.hasAppContext = false
    this.onDisposed = onDisposed
    this.assOverlay = assOverlay
    initEngine(context, options, activityProvider = activityProvider)
  }

  private val thread = HandlerThread("ElvMedia3").apply { start() }
  private val handler = Handler(thread.looper)
  private val commandFence = CommandFence()
  private val closer = createCloserExecutor()
  internal val gate = ConnectionGate(closer)
  private val http = engineHttpClient()
  internal val codecPolicy = CodecPolicy()
  private val audioEffects = AudioEffectsController(handler)
  private val audioDelayUs = AtomicLong(0L)
  private var baseAudioDelayMs: Long = 0L
  private var audioDelayByRefreshRateMs: Map<String, Long> = emptyMap()
  private val fence = PrepareFence()
  private val surfaces = SurfaceController()
  private val subtitles = EngineSubtitleDelivery(handler, surfaces) { player?.let(::applyResolvedSubtitleCues) }
  private val secondaryTextOutput = TextOutput { cueGroup ->
    val current = player ?: return@TextOutput
    val req = request ?: return@TextOutput
    subtitles.onSecondaryRendererCues(
      current, cueGroup.cues, req.filterSdhSubtitles, tracksBridge.isTextDisabled,
      fence.isRendererOpen, tracksBridge.selectedExternalPrimaryId, tracksBridge.selectedSecondarySubtitleId,
    )
  }
  @Volatile
  private var activePtsGeneration = 0L
  private val ptsEstimator = PtsFrameRateEstimator { fps ->
    val gen = activePtsGeneration
    post { if (gen == generation && request != null) reporter.onEstimatedFrameRate(fps) }
  }
  private val reporter = EventReporter(
    handler = handler, fence = fence, hasInvalidAttachedSurface = surfaces::hasInvalidAttachedSurface,
    send = ::sendEvent, onHlsDetected = ::playAsHls, onBehindLiveWindow = ::recoverBehindLiveWindow,
    onAudioFocusDenied = ::handleAudioFocusDenied, onVideoCodecFailed = codecPolicy::recordVideoCodecFailure,
    onDolbyVisionFailed = codecPolicy::recordDolbyVisionFallback, onAudioCodecFailed = ::handleAudioCodecFailed,
    onFirstFrame = surfaces::onFramed, onCue = surfaces::onCue,
    onTerminalError = { mediaSessionController.onPlaybackStopped() },
    onVideoFrameRateDetected = { fps -> displayRefresh.onContentFrameRate(fps) },
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
      val req = request ?: return
      subtitles.onPrimaryCues(
        current, cueGroup.cues, req.filterSdhSubtitles, tracksBridge.isTextDisabled,
        fence.isRendererOpen, tracksBridge.selectedExternalPrimaryId, tracksBridge.selectedSecondarySubtitleId,
      )
    }
    override fun onAudioSessionIdChanged(audioSessionId: Int) = audioEffects.onAudioSessionIdChanged(audioSessionId)
    override fun onIsPlayingChanged(isPlaying: Boolean) {
      val current = player ?: return
      if (request != null && fence.acceptsPlayer(current)) {
        if (handleAudioFocus) mediaSessionController.updatePlayingState(isPlaying)
        if (isPlaying) applyResolvedSubtitleCues(current) else subtitles.cancelTick()
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
  private var handleAudioFocus: Boolean = true
  private var multiViewTileCount: Int = MIN_MULTIVIEW_TILES
  private var playerHandleAudioFocus: Boolean = true
  private var playerMultiViewTileCount: Int = MIN_MULTIVIEW_TILES
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
      baseAudioDelayMs = 0L
      normalized.audioDelayByRefreshRateMs?.let { audioDelayByRefreshRateMs = it }
      syncEffectiveAudioDelay()
      normalized.autoFrameRate?.let(::applyDisplaySyncMode)
      normalized.nightModeDrc?.let(audioEffects::setNightModeDrc)
      ptsEstimator.reset()
      subtitles.resetAll()
      assOverlay.clearForZap()
      normalized.subtitleStyle?.let(surfaces::onSubtitleStyle)
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
    if (request != null && handleAudioFocus) mediaSessionController.onPlaybackActive()
  }
  fun pause(attempt: Int) = postInEpoch(attempt) { player?.pause() }

  fun seek(attempt: Int, positionMs: Long) = postInEpoch(attempt) {
    val current = player ?: return@postInEpoch
    performEngineSeek(current, request, positionMs, activeTimeShiftTracker) {
      clearSubtitles(resetDelay = false)
    }?.let { lastVodPositionMs = it }
  }

  /** Enables Media3's scrubbing mode on VOD streams only; reset unconditionally on stop/load/retry/recreate (#222). */
  fun setScrubbing(attempt: Int, scrubbing: Boolean) =
    postInEpoch(attempt) { player?.let { it.isScrubbingModeEnabled = scrubbing && request?.live == false } }

  /** Applies clamped `[0.25, 4.0]` playback speed on VOD streams only with current [pitchLock] (#264). */
  fun setSpeed(attempt: Int, rate: Double) = postInEpoch(attempt) {
    if (request?.live != false) return@postInEpoch
    currentSpeed = PlaybackSpeedPolicy.clampSpeed(rate)
    player?.playbackParameters = PlaybackSpeedPolicy.parameters(currentSpeed, pitchLock)
  }

  /** Updates pitch-lock preference and re-applies [PlaybackParameters] immediately while VOD is active (#264). */
  fun setPitchLock(locked: Boolean) = post {
    pitchLock = locked
    if (request?.live == false) player?.playbackParameters = PlaybackSpeedPolicy.parameters(currentSpeed, pitchLock)
  }

  /** Updates Android lock-screen / Bluetooth `MediaSession` metadata and track-stepping state (#412). */
  internal fun setMediaMetadata(payload: MediaSessionMetadataPayload?) = post { mediaSessionController.setMediaMetadata(payload) }

  /** Enables or disables opt-in background audio playback across task removal (#412). */
  fun setBackgroundAudioEnabled(enabled: Boolean) = post { mediaSessionController.setBackgroundAudioEnabled(enabled) }

  /** Configures Multi-View audio focus ownership and tile-count buffer scaling (`#34`, `#221`). */
  fun configureMultiView(handleAudioFocus: Boolean, tileCount: Int) = post {
    val wasAudioFocus = this.handleAudioFocus
    this.handleAudioFocus = handleAudioFocus
    this.multiViewTileCount = clampMultiViewTileCount(tileCount)
    val current = player ?: return@post
    val desiredFocus = this.handleAudioFocus && playerFactory.audioFocusAllowed
    if (request == null && (playerHandleAudioFocus != desiredFocus || playerMultiViewTileCount != this.multiViewTileCount)) {
      if (!this.handleAudioFocus) mediaSessionController.detachPlayer()
      replacePlayer(playerSoftwareAudio, playerPreferHevc, playerStreamKind, playerBufferPreset, playerDecoderMode)
      return@post
    }
    current.volume = if (this.handleAudioFocus) 1f else 0f
    if (playerHandleAudioFocus != desiredFocus || wasAudioFocus != this.handleAudioFocus) {
      playerHandleAudioFocus = applyMultiViewAudioFocus(current, this.handleAudioFocus, playerFactory)
    }
    if (!this.handleAudioFocus) {
      mediaSessionController.detachPlayer()
    } else if (!wasAudioFocus || mediaSessionController.activeForwardingPlayerForTest == null) {
      mediaSessionController.onPlayerChanged(current)
      if (request != null) {
        mediaSessionController.onPlaybackActive(); mediaSessionController.updatePlayingState(current.isPlaying)
      }
    }
  }

  /** Configures stereo loudness boost in dB via [AudioEffectsController] (multichannel-safe, #260). */
  fun setAudioBoostDb(attempt: Int, db: Double) = postInEpoch(attempt) { if (db.isFinite()) audioEffects.setBoostDb(db) }

  /** Configures stereo API 28+ Night-Mode DRC preset (`OFF`/`LIGHT`/`NIGHT`, multichannel-safe, #115). */
  internal fun setNightModeDrc(preset: NightModeDrcPreset) = post { audioEffects.setNightModeDrc(preset) }

  /** Configures Android Auto Frame-Rate display sync policy (`OFF`/`SEAMLESS`/`ALWAYS`, #116). */
  internal fun setDisplaySync(autoFrameRate: AutoFrameRateMode, @Suppress("UNUSED_PARAMETER") autoDynamicRange: Boolean = true) =
    post { applyDisplaySyncMode(autoFrameRate) }

  /** Configures per-refresh-rate A/V delay offsets in ms (`[-1000, 1000]`, #115). */
  internal fun setAudioDelayByRefreshRate(offsets: Map<String, Long>) = post {
    audioDelayByRefreshRateMs = offsets
    syncEffectiveAudioDelay()
  }

  fun selectAudioTrack(attempt: Int, id: String) = postInEpoch(attempt) { tracksBridge.selectAudioTrack(player, id) }
  fun selectSubtitleTrack(attempt: Int, id: String?) = postInEpoch(attempt) {
    tracksBridge.selectSubtitleTrack(player, id)
    player?.let { applyResolvedSubtitleCues(it) }
  }
  fun selectSecondarySubtitleTrack(attempt: Int, id: String?) = postInEpoch(attempt) {
    tracksBridge.selectSecondarySubtitleTrack(player, id)
    player?.let { applyResolvedSubtitleCues(it) }
  }

  /** Attaches an external sidecar subtitle mid-playback using isolated transport without restarting video (#32, #308). */
  internal fun addExternalSubtitle(attempt: Int, track: ExternalSubtitleConfig) = postInEpoch(attempt) {
    val currentReq = request ?: return@postInEpoch
    if (!isAllowedExternalSubtitleUri(track.uri)) return@postInEpoch
    val alreadyAttached = currentReq.externalSubtitles.any { it.trackId == track.trackId || it.uri == track.uri }
    if (!alreadyAttached) {
      request = currentReq.copy(externalSubtitles = currentReq.externalSubtitles + track)
    }
    if (!subtitles.registerExternalTrack(track)) return@postInEpoch
    tracksBridge.onDynamicExternalSubtitlesChanged(player)
    val loadGen = generation
    externalSubLoader.loadAsync(track, allowLegacyTls = currentReq.allowLegacyTls) { cues ->
      if (cues == null) return@loadAsync
      post {
        if (generation != loadGen || request == null) return@post
        subtitles.storeSidecarCues(track.trackId, cues)
        player?.let { applyResolvedSubtitleCues(it) }
      }
    }
  }

  /** Updates live subtitle appearance styling immediately without restarting playback (#32). */
  internal fun setSubtitleStyle(style: SubtitleStyleConfig?) = post { surfaces.onSubtitleStyle(style) }

  /** Shifts audio timing relative to video in milliseconds (`[-30_000, 30_000]`) without buffer reallocation (#203, #59, #115). */
  fun setAudioDelay(attempt: Int, delayMs: Long) = postInEpoch(attempt) {
    baseAudioDelayMs = delayMs
    syncEffectiveAudioDelay()
  }

  /** Shifts subtitle cue timing in milliseconds (`[-30_000, 30_000]`) without flushing buffered cues (#203, #59). */
  fun setSubtitleDelay(attempt: Int, delayMs: Long) = postInEpoch(attempt) {
    subtitles.setDelayMs(delayMs)
    player?.let { applyResolvedSubtitleCues(it) }
  }

  /** Constrains or selects an adaptive video rendition ID, or restores automatic ABR when [id] is `null` (#59). */
  fun selectVideoQuality(attempt: Int, id: String?) = postInEpoch(attempt) { tracksBridge.selectVideoQuality(player, id) }

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
      assOverlay.clearForZap()
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
      externalSubLoader.dispose()
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
    ptsEstimator.reset()
    displayRefresh.restoreDefault()
    tearDownTimeShiftCache()
    player?.isScrubbingModeEnabled = false
    currentSpeed = PlaybackSpeedPolicy.DEFAULT_SPEED
    player?.playbackParameters = PlaybackParameters.DEFAULT
    baseAudioDelayMs = 0L
    audioDelayUs.set(0L)
    subtitles.resetAll()
    assOverlay.clearForZap()
    audioEffects.onStop()
    mediaSessionController.onPlaybackStopped()
    request = null
    audioFallbackAttempted = false
    lastVodPositionMs = null
    tracksBridge.onStop()
    surfaces.onStop()
    beginGeneration()
  }

  private fun clearSubtitles(resetDelay: Boolean) = subtitles.clearAll(resetDelay = resetDelay)

  private fun applyResolvedSubtitleCues(current: ExoPlayer) {
    val req = request ?: return
    subtitles.applyResolved(
      current, req.filterSdhSubtitles, tracksBridge.isTextDisabled,
      fence.isRendererOpen, tracksBridge.selectedExternalPrimaryId, tracksBridge.selectedSecondarySubtitleId,
    )
  }

  private fun applyDisplaySyncMode(mode: AutoFrameRateMode) {
    displayRefresh.setMode(mode)
    player?.videoChangeFrameRateStrategy = videoChangeFrameRateStrategyForApi(Build.VERSION.SDK_INT, mode)
  }

  private fun syncEffectiveAudioDelay() {
    val offsetMs = resolveAudioDelayOffsetForRefreshRate(audioDelayByRefreshRateMs, displayRefresh.activeRefreshRateHz)
    audioDelayUs.set(syncDelayMsToUs(baseAudioDelayMs + offsetMs))
  }

  private fun stopFromTaskRemoved() = post {
    clearSessionState(); player?.stop(); player?.clearMediaItems()
  }

  private fun stopFromRemoteController() {
    val runStop = {
      if (!commandFence.isDisposedNow) {
        clearSessionState(); player?.stop(); player?.clearMediaItems()
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
    activePtsGeneration = generation
    ptsEstimator.reset()
    gate.beginMedia(generation)
  }
  private fun tearDownTimeShiftCache() { activeTimeShiftBuffer?.close(); activeTimeShiftBuffer = null; activeTimeShiftTracker = null }

  private fun initEngine(
    context: Context,
    options: MultiViewEngineOptions = MultiViewEngineOptions(),
    activityProvider: () -> Activity? = { null },
  ) {
    handleAudioFocus = options.handleAudioFocus
    multiViewTileCount = clampMultiViewTileCount(options.multiViewTileCount)
    appContextRef = context.applicationContext ?: context
    externalSubLoader = ExternalSubtitleLoader(context = appContextRef)
    displayRefresh = DisplayRefreshController(
      activityProvider = activityProvider,
      onActiveRefreshRateChanged = { _ -> syncEffectiveAudioDelay() },
    )
    val profile = readDeviceMemoryProfile(context)
    lowRamDevice = profile.lowRam
    val cacheDir: File? = context.cacheDir
    appCacheDir = cacheDir
    cacheDir?.let { TimeShiftRingBuffer.purgeOrphansOnStartup(it) }
    playerFactory = PlayerFactory(
      context = context, looper = thread.looper,
      loadControlForStream = { kind: StreamKind, preset: BufferPreset -> profile.loadControl(kind, preset) },
      codecPolicy = codecPolicy, audioDelayUs = audioDelayUs,
      secondaryTextOutput = secondaryTextOutput, assOverlayBridge = assOverlay,
    )
    tracksBridge = TrackSelectorBridge(
      isActivePlayer = { candidate -> candidate === player && fence.acceptsPlayer(candidate) },
      onTracks = { snapshot -> if (request != null) sendEvent(mapOf("type" to "tracks", "tracks" to snapshot)) },
      onClearCues = { subtitles.clearPrimary(resetDelay = false) },
      captioningEnabled = { isSystemCaptioningEnabled(context) },
      onClearSecondaryCues = { subtitles.clearSecondary(resetDelay = false) },
      extraExternalSubtitles = subtitles::dynamicExternalTrackSnapshots,
      onSecondaryTargetChanged = { target, primaryOff ->
        playerFactory.lastTrackSelector?.setSecondarySelection(target, primaryOff)
      },
    )
    mediaSessionController = MediaSessionController(
      context = context, onRemoteMediaAction = ::sendRemoteMediaAction,
      onTaskRemovedStop = ::stopFromTaskRemoved, onRemoteStop = ::stopFromRemoteController,
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
      playerBufferPreset != bufferPreset || playerDecoderMode != decoderMode ||
      playerHandleAudioFocus != (handleAudioFocus && playerFactory.audioFocusAllowed) ||
      playerMultiViewTileCount != multiViewTileCount
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
    surfaces.onAssOverlayHandle(assOverlay.activeHandle)
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
      current, next.live, prepareSerial = serial, reused = !rebuild, isLiveTs = isLiveTs,
      ringWindowProvider = activeTimeShiftTracker?.let { tracker -> tracker::currentWindow },
    )
    val transferListener = ProgressTransferListener(shouldReport = { reporter.isWaitingForMedia }) { bytes, atMs ->
      post { if (generation == prepareGen) reporter.onTransferProgress(bytes, atMs) }
    }
    val httpClient = networkScopedClient(
      base = http,
      allowLegacyTls = next.allowLegacyTls,
      dnsFamily = next.dnsFamily,
      hostOverride = next.hostOverride,
      initialUrl = next.url,
    )
    val source = createMediaSource(
      next, gate, prepareGen, serial, lowRamDevice, httpClient, transferListener,
      timeShiftRingBuffer = activeTimeShiftBuffer, timeShiftTracker = activeTimeShiftTracker,
      context = appContextRef, extractorsDecorator = assOverlay::wrapExtractorsFactory,
    )
    if (positionMs == null) current.setMediaSource(source, true) else current.setMediaSource(source, positionMs)
    current.playWhenReady = true
    current.prepare()
    if (handleAudioFocus) mediaSessionController.onPlaybackActive()
  }

  private fun buildPlayer(
    softwareAudio: Boolean, preferHevc: Boolean = false, streamKind: StreamKind = StreamKind.VOD,
    bufferPreset: BufferPreset = BufferPreset.AUTO, decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
  ): ExoPlayer {
    playerSoftwareAudio = softwareAudio; playerPreferHevc = preferHevc
    playerStreamKind = streamKind; playerBufferPreset = bufferPreset; playerDecoderMode = decoderMode
    playerMultiViewTileCount = multiViewTileCount
    return playerFactory.build(
      softwareAudio = softwareAudio, preferHevcOverDolbyVision = preferHevc,
      live = streamKind != StreamKind.VOD, streamKind = streamKind,
      bufferPreset = bufferPreset, decoderMode = decoderMode,
      handleAudioFocus = handleAudioFocus, multiViewTileCount = multiViewTileCount,
      autoFrameRateMode = displayRefresh.mode,
    ).also { built ->
      playerHandleAudioFocus = handleAudioFocus && playerFactory.audioFocusAllowed
      built.volume = if (handleAudioFocus) 1f else 0f
      built.addListener(reporter); built.addAnalyticsListener(reporter); built.addListener(pictures)
      built.setVideoFrameMetadataListener(ptsEstimator)
      built.playbackParameters =
        if (streamKind == StreamKind.VOD) PlaybackSpeedPolicy.parameters(currentSpeed, pitchLock) else PlaybackParameters.DEFAULT
      audioEffects.onAudioSessionIdChanged(built.audioSessionId)
      surfaces.attachToNewPlayer(built, ::sendSurfaceChange)
      surfaces.onAssOverlayHandle(assOverlay.activeHandle)
      if (handleAudioFocus) mediaSessionController.onPlayerChanged(built)
    }
  }

  private fun detachPlayerInstance(old: ExoPlayer, clearSurface: Boolean) {
    old.isScrubbingModeEnabled = false
    old.clearVideoFrameMetadataListener(ptsEstimator)
    old.removeListener(reporter); old.removeAnalyticsListener(reporter); old.removeListener(pictures)
    if (clearSurface) old.clearVideoSurface()
    audioEffects.onStop(); audioEffects.onAudioSessionIdChanged(C.AUDIO_SESSION_ID_UNSET)
    mediaSessionController.updatePlayingState(false)
  }

  private fun replacePlayer(
    softwareAudio: Boolean, preferHevc: Boolean = false, streamKind: StreamKind = StreamKind.VOD,
    bufferPreset: BufferPreset = BufferPreset.AUTO, decoderMode: VideoDecoderMode = VideoDecoderMode.AUTO,
  ): ExoPlayer {
    val old = player; player = null
    surfaces.detachAssOverlaySync(DETACH_TIMEOUT_MS); assOverlay.release()
    if (old != null) detachPlayerInstance(old, clearSurface = true)
    try {
      return buildPlayer(softwareAudio, preferHevc, streamKind, bufferPreset, decoderMode).also { player = it }
    } finally {
      if (old != null) {
        if (player == null) mediaSessionController.onPlaybackStopped()
        old.release(); gate.dropForced()
      }
    }
  }

  private fun releasePlayer() {
    val old = player; player = null
    surfaces.detachAssOverlaySync(DETACH_TIMEOUT_MS); assOverlay.release()
    if (old == null) return
    detachPlayerInstance(old, clearSurface = false)
    old.release(); gate.dropForced()
  }
}

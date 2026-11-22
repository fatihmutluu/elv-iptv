package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.Surface
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.SeekParameters
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val TAG = "ElvMedia3"
private const val EVENT = "onEngineEvent"

/**
 * The `PlayerEngine` of player core spec 5.1 on Media3, one per player screen (an Expo shared object). ExoPlayer
 * lives on this engine's own playback thread (its application looper): JavaScript calls post there and return at
 * once, and every event is sent from there, tagged with the current attempt token.
 */
@OptIn(UnstableApi::class)
class Media3Engine : SharedObject {
  private val hasAppContext: Boolean
  private val onDisposed: (Media3Engine) -> Unit
  private var lowRamDevice = false
  private lateinit var playerFactory: PlayerFactory
  private lateinit var tracksBridge: TrackSelectorBridge

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
  internal val codecPolicy = CodecPolicy()
  private val audioEffects = AudioEffectsController(handler)
  private val fence = PrepareFence()
  private val surfaces = SurfaceController()
  private val reporter = EventReporter(
    handler = handler, fence = fence, hasInvalidAttachedSurface = surfaces::hasInvalidAttachedSurface,
    send = ::sendEvent, onHlsDetected = ::playAsHls, onBehindLiveWindow = ::recoverBehindLiveWindow,
    onAudioFocusDenied = ::handleAudioFocusDenied, onVideoCodecFailed = codecPolicy::recordVideoCodecFailure,
    onDolbyVisionFailed = codecPolicy::recordDolbyVisionFallback, onAudioCodecFailed = ::handleAudioCodecFailed,
    onFirstFrame = surfaces::onFramed, onCue = surfaces::onCue,
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
      if (request != null && fence.isRendererOpen && !tracksBridge.isTextDisabled) surfaces.onCues(sanitizeCues(cueGroup.cues))
    }
    override fun onAudioSessionIdChanged(audioSessionId: Int) = audioEffects.onAudioSessionIdChanged(audioSessionId)
  }

  @Volatile
  internal var eventObserverForTest: ((Map<String, Any?>) -> Unit)? = null

  private var player: ExoPlayer? = null
  private var playerSoftwareAudio = false
  private var playerPreferHevc = false
  private var playerStreamKind: StreamKind = StreamKind.VOD
  private var playerBufferPreset: BufferPreset = BufferPreset.AUTO
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
      if (!isAllowedPlaybackUrl(next.url)) {
        rejectDisallowedUrl(attempt, rebuildFirst = action.rebuildFirst)
        return@post
      }
      val normalized = next.copy(url = next.url.trim())
      if (request?.url != normalized.url && !normalized.preferHevcOverDolbyVision) codecPolicy.clearDolbyVisionFallback()
      token = attempt
      request = normalized
      audioFallbackAttempted = false
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

  fun play(attempt: Int) = postInEpoch(attempt) { player?.play() }
  fun pause(attempt: Int) = postInEpoch(attempt) { player?.pause() }

  fun seek(attempt: Int, positionMs: Long) = postInEpoch(attempt) {
    val clamped = positionMs.coerceAtLeast(0L)
    val current = player ?: return@postInEpoch
    if (!current.isCurrentMediaItemSeekable) return@postInEpoch
    if (request?.live == false) {
      lastVodPositionMs = clamped
      current.setSeekParameters(vodSeekParametersFor(clamped, current.currentPosition))
    }
    current.seekTo(clamped)
  }

  /** Enables Media3's scrubbing mode on VOD streams only; reset unconditionally on stop/load/retry/recreate (#222). */
  fun setScrubbing(attempt: Int, scrubbing: Boolean) = postInEpoch(attempt) {
    player?.let { it.isScrubbingModeEnabled = scrubbing && request?.live == false }
  }

  /** Configures stereo loudness boost in dB via [AudioEffectsController] (multichannel-safe, #260). */
  fun setAudioBoostDb(attempt: Int, db: Double) = postInEpoch(attempt) { if (db.isFinite()) audioEffects.setBoostDb(db) }

  fun selectAudioTrack(attempt: Int, id: String) = postInEpoch(attempt) { tracksBridge.selectAudioTrack(player, id) }
  fun selectSubtitleTrack(attempt: Int, id: String?) = postInEpoch(attempt) { tracksBridge.selectSubtitleTrack(player, id) }

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
      surfaces.clearCues()
      reporter.end()
      beginGeneration()
      pendingRebuildDeferred = false
      releasePlayer()
      player = buildPlayer(playerSoftwareAudio, playerPreferHevc, playerStreamKind, playerBufferPreset)
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
    player?.isScrubbingModeEnabled = false
    audioEffects.onStop()
    request = null
    audioFallbackAttempted = false
    lastVodPositionMs = null
    tracksBridge.onStop()
    surfaces.onStop()
    beginGeneration()
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

  private fun initEngine(context: Context) {
    val profile = readDeviceMemoryProfile(context)
    lowRamDevice = profile.lowRam
    playerFactory = PlayerFactory(context, thread.looper, { kind: StreamKind, preset: BufferPreset -> profile.loadControl(kind, preset) }, codecPolicy)
    tracksBridge = TrackSelectorBridge(
      isActivePlayer = { candidate -> candidate === player && fence.acceptsPlayer(candidate) },
      onTracks = { snapshot -> if (request != null) sendEvent(mapOf("type" to "tracks", "tracks" to snapshot)) },
      onClearCues = surfaces::clearCues,
      captioningEnabled = { isSystemCaptioningEnabled(context) },
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
    surfaces.clearCues()
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
    tracksBridge.onPrepareReuse()
    surfaces.clearCues()
    if (newGeneration) beginGeneration()
    val existing = player
    val streamKind = next.streamKind()
    val bufferPreset = next.bufferPreset
    val terminal = existing != null && (existing.playbackState == Player.STATE_ENDED || existing.playerError != null)
    val rebuild = forceRebuild || existing == null || terminal || playerSoftwareAudio != next.softwareAudio ||
      playerPreferHevc != next.preferHevcOverDolbyVision || playerStreamKind != streamKind ||
      playerBufferPreset != bufferPreset
    if (rebuild) {
      pendingRebuildDeferred = false
      existing?.isScrubbingModeEnabled = false
      releasePlayer()
      player = buildPlayer(next.softwareAudio, next.preferHevcOverDolbyVision, streamKind, bufferPreset)
    } else {
      existing.isScrubbingModeEnabled = false
      existing.stop()
    }
    val current = player ?: return
    current.isScrubbingModeEnabled = false
    current.setSeekParameters(if (next.live) SeekParameters.EXACT else vodSeekParametersFor(positionMs ?: 0L, null))
    tracksBridge.applyInitialParameters(current)
    val serial = ++prepares
    val prepareGen = generation
    reporter.begin(
      current,
      next.live,
      prepareSerial = serial,
      reused = !rebuild,
      isLiveTs = next.live && next.sourceType() == SourceType.TS,
    )
    val transferListener = ProgressTransferListener(shouldReport = { reporter.isWaitingForMedia }) { bytes, atMs ->
      post { if (generation == prepareGen) reporter.onTransferProgress(bytes, atMs) }
    }
    val source = createMediaSource(next, gate, prepareGen, serial, lowRamDevice, http, transferListener)
    if (positionMs == null) current.setMediaSource(source, true) else current.setMediaSource(source, positionMs)
    current.playWhenReady = true
    current.prepare()
  }

  private fun buildPlayer(
    softwareAudio: Boolean,
    preferHevc: Boolean = false,
    streamKind: StreamKind = StreamKind.VOD,
    bufferPreset: BufferPreset = BufferPreset.AUTO,
  ): ExoPlayer {
    playerSoftwareAudio = softwareAudio
    playerPreferHevc = preferHevc
    playerStreamKind = streamKind
    playerBufferPreset = bufferPreset
    return playerFactory.build(softwareAudio, preferHevc, live = streamKind != StreamKind.VOD, streamKind = streamKind, bufferPreset = bufferPreset).also { built ->
      built.addListener(reporter)
      built.addListener(pictures)
      audioEffects.onAudioSessionIdChanged(built.audioSessionId)
      surfaces.attachToNewPlayer(built, ::sendSurfaceChange)
    }
  }

  private fun releasePlayer() {
    val old = player ?: return
    player = null
    old.isScrubbingModeEnabled = false
    old.removeListener(reporter)
    old.removeListener(pictures)
    audioEffects.onStop()
    audioEffects.onAudioSessionIdChanged(C.AUDIO_SESSION_ID_UNSET)
    old.release()
    gate.dropForced()
  }
}

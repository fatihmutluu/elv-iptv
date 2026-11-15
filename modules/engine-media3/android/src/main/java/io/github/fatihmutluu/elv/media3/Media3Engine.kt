package io.github.fatihmutluu.elv.media3

import android.app.ActivityManager
import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.util.Log
import android.view.Surface
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "ElvMedia3"
private const val EVENT = "onEngineEvent"

/** Receives what the surface view shows, on the playback thread; [Media3Engine.bindView] sends the state first. */
internal interface ViewSink {
  /** The zap shutter: the load serial [media] and whether its first frame rendered. */
  fun onShutter(media: Long, framed: Boolean)

  /** Media3's decoded picture size; zero while no video renders (the view then keeps the last shape). */
  fun onVideoSize(width: Int, height: Int, pixelRatio: Float)

  /** Whether playback wants the screen kept on ([keepsScreenOn]). */
  fun onScreenOn(on: Boolean)
}

/**
 * The `PlayerEngine` of player core spec 5.1 on Media3, one per player screen (an Expo shared object). ExoPlayer
 * lives on this engine's own playback thread (its application looper): JavaScript calls post there and return at
 * once, and every event is sent from there, tagged with the current attempt token.
 */
@OptIn(UnstableApi::class)
class Media3Engine : SharedObject {
  private val context: Context
  private val hasAppContext: Boolean
  private val onDisposed: (Media3Engine) -> Unit

  constructor(
    context: Context,
    appContext: AppContext,
    onDisposed: (Media3Engine) -> Unit,
  ) : super(appContext) {
    this.context = context
    this.hasAppContext = true
    this.onDisposed = onDisposed
    buffers = loadControlFor(lowRam(context))
    post { player = buildPlayer(softwareAudio = false) }
  }

  internal constructor(
    context: Context,
    onDisposed: (Media3Engine) -> Unit = {},
  ) : super() {
    this.context = context
    this.hasAppContext = false
    this.onDisposed = onDisposed
    buffers = loadControlFor(lowRam(context))
    post { player = buildPlayer(softwareAudio = false) }
  }

  private val thread = HandlerThread("ElvMedia3").apply { start() }
  private val handler = Handler(thread.looper)
  private val disposed = AtomicBoolean(false)
  /** Force-closes superseded connections off the playback thread; its one thread ends after 10 s idle. */
  private val closer = ThreadPoolExecutor(0, 1, 10, TimeUnit.SECONDS, LinkedBlockingQueue()) {
    Thread(it, "ElvMedia3Closer")
  }
  internal val gate = ConnectionGate(closer)
  private val http = engineHttpClient()
  private val buffers: LoadControlValues
  private val reporter = EventReporter(
    handler,
    { fields -> sendEvent(fields) },
    { playAsHls() },
    { onFramed() },
    { cue, played -> onCue(cue, played) },
  )
  private val pictures = object : Player.Listener {
    override fun onVideoSizeChanged(videoSize: VideoSize) {
      view?.onVideoSize(videoSize.width, videoSize.height, videoSize.pixelWidthHeightRatio)
    }
  }

  /** The surface the view offers, written on the UI thread; an attach that a detach overtook is skipped. */
  @Volatile private var offered: Surface? = null

  // Playback-thread state.
  private var player: ExoPlayer? = null
  private var playerSoftwareAudio = false
  private var token = 0
  private var generation = 0L
  private var request: LoadRequest? = null
  private var surface: Surface? = null
  private var media = 0L
  private var framed = false
  private var screenOn = false
  private var view: ViewSink? = null

  /** The engine is passed to the surface view as a prop; let pending view updates apply before it goes. */
  override val releasesAfterPendingViewUpdates: Boolean = true

  /**
   * Starts a new media: the previous one is stopped, a new connection-gate generation begins and the zap shutter
   * covers the surface until this media's first frame.
   */
  internal fun load(attempt: Int, next: LoadRequest) = post {
    reporter.end()
    token = attempt
    request = next
    media += 1
    framed = false
    view?.onShutter(media, false)
    prepare(next, next.startMs)
  }

  /** Re-prepares the current media with a fresh connection: live at the edge, VOD at the current position. */
  fun retry(attempt: Int) = post {
    adopt(attempt)
    val current = request ?: return@post
    val position = if (current.live) null else player?.currentPosition
    prepare(current, position)
  }

  fun play(attempt: Int) = post {
    adopt(attempt)
    player?.play()
  }

  fun pause(attempt: Int) = post {
    adopt(attempt)
    player?.pause()
  }

  /** Seeks when the media allows it; raw live MPEG-TS has no seek. */
  fun seek(attempt: Int, positionMs: Long) = post {
    adopt(attempt)
    val current = player ?: return@post
    if (current.isCurrentMediaItemSeekable) current.seekTo(positionMs.coerceAtLeast(0L))
  }

  /** Stops the media and closes its connections; later requests of it are refused by the gate. The screen may sleep. */
  fun stop(attempt: Int) = post {
    adopt(attempt)
    reporter.end()
    request = null
    beginGeneration()
    player?.stop()
    player?.clearMediaItems()
    onCue(ScreenCue.STOP, played = false)
  }

  /** Releases ExoPlayer and builds a new one on the same thread and surface; it stays idle until `load` or `retry`. */
  fun recreate(attempt: Int) = post {
    adopt(attempt)
    reporter.end()
    beginGeneration()
    releasePlayer()
    player = buildPlayer(playerSoftwareAudio)
  }

  /** Surface view hook (UI thread, returns at once): renders into [next] and reports `surface created` once. */
  fun attachSurface(next: Surface) {
    offered = next
    post {
      if (offered !== next || surface === next) return@post
      surface = next
      player?.setVideoSurface(next)
      sendEvent(mapOf("type" to "surface", "change" to "created"))
    }
  }

  /**
   * Surface view hook for `surfaceDestroyed`, which must not return while the decoder still renders into [old]:
   * detaches it on the playback thread, ahead of queued commands (inline when called there), and waits up to
   * [timeoutMs] for that. Returns false on timeout.
   */
  fun detachSurface(old: Surface, timeoutMs: Long): Boolean {
    if (offered === old) offered = null
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

  /** Surface view hook: [sink] gets the current state now and every change from now on, on the playback thread. */
  internal fun bindView(sink: ViewSink) = post {
    view = sink
    sink.onShutter(media, framed)
    player?.videoSize?.let { sink.onVideoSize(it.width, it.height, it.pixelWidthHeightRatio) }
    sink.onScreenOn(screenOn)
  }

  internal fun unbindView(sink: ViewSink) = post {
    if (view === sink) view = null
  }

  internal fun cueScreen(cue: ScreenCue, played: Boolean) = post {
    onCue(cue, played)
  }

  /** Releases the player and ends the playback thread; later commands do nothing. Safe to call twice. */
  fun dispose() {
    if (!disposed.compareAndSet(false, true)) return
    onDisposed(this)
    handler.post {
      reporter.end()
      request = null
      onCue(ScreenCue.STOP, played = false)
      beginGeneration()
      http.dispatcher.cancelAll()
      releasePlayer()
      http.dispatcher.executorService.shutdown()
      closer.shutdown()
      thread.quitSafely()
    }
  }

  override fun sharedObjectDidRelease() = dispose()

  private fun post(command: () -> Unit) {
    handler.post {
      if (disposed.get()) return@post
      try {
        command()
      } catch (e: Exception) {
        Log.e(TAG, "engine command failed: ${e.javaClass.simpleName}")
        sendEvent(mapOf("type" to "error", "error" to mapOf("code" to "unknown", "detail" to e.javaClass.simpleName)))
        onCue(ScreenCue.ERROR, played = false)
      }
    }
  }

  private fun detachNow(old: Surface) {
    if (surface !== old) return
    surface = null
    try {
      player?.clearVideoSurface(old)
    } catch (e: Exception) {
      Log.e(TAG, "surface detach failed: ${e.javaClass.simpleName}")
    }
    sendEvent(mapOf("type" to "surface", "change" to "destroyed"))
  }

  /** The current prepare rendered its first frame: the media's shutter lifts. */
  private fun onFramed() {
    if (framed || media == 0L) return
    framed = true
    view?.onShutter(media, true)
  }

  /** A state, an error or `stop`: the view keeps the screen on or lets it sleep ([keepsScreenOn]). */
  private fun onCue(cue: ScreenCue, played: Boolean) {
    val next = keepsScreenOn(screenOn, cue, played)
    if (next == screenOn) return
    screenOn = next
    view?.onScreenOn(next)
  }

  private fun adopt(attempt: Int) {
    if (attempt > token) token = attempt
  }

  private fun sendEvent(fields: Map<String, Any?>) {
    if (disposed.get() || !hasAppContext) return
    emit(EVENT, fields + ("attempt" to token))
  }

  private fun beginGeneration() {
    generation += 1
    gate.beginMedia(generation)
  }

  /**
   * A progressive guess found an HLS playlist (an extensionless URL redirected to `.m3u8`): prepare the same request
   * as HLS once ([asDetectedPlaylist] keeps the original URL), in the same gate generation, since the guess's
   * connection is already closed. Superseded media and an already detected playlist are left alone.
   */
  private fun playAsHls() {
    val detectedIn = generation
    post {
      val current = request ?: return@post
      if (detectedIn != generation || current.playlistDetected) return@post
      val next = current.asDetectedPlaylist()
      request = next
      prepare(next, next.startMs, newGeneration = false)
    }
  }

  private fun prepare(next: LoadRequest, positionMs: Long?, newGeneration: Boolean = true) {
    reporter.end()
    if (newGeneration) beginGeneration()
    if (player == null || playerSoftwareAudio != next.softwareAudio) {
      releasePlayer()
      player = buildPlayer(next.softwareAudio)
    } else {
      player?.stop()
    }
    val current = player ?: return
    val manifestLoaded = AtomicBoolean(false)
    reporter.begin(current, next.live, manifestLoaded)
    val source = createMediaSource(next, gate, generation, manifestLoaded, http)
    if (positionMs == null) current.setMediaSource(source, true) else current.setMediaSource(source, positionMs)
    current.playWhenReady = true
    current.prepare()
  }

  private fun buildPlayer(softwareAudio: Boolean): ExoPlayer {
    val renderers = createRenderersFactory(context, softwareAudio)
    val loadControl = DefaultLoadControl.Builder()
      .setBufferDurationsMs(
        buffers.minBufferMs,
        buffers.maxBufferMs,
        buffers.bufferForPlaybackMs,
        buffers.bufferForPlaybackAfterRebufferMs,
      )
      .setTargetBufferBytes(buffers.targetBufferBytes)
      .setPrioritizeTimeOverSizeThresholds(false)
      .build()
    val audio = AudioAttributes.Builder()
      .setUsage(C.USAGE_MEDIA)
      .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
      .build()
    playerSoftwareAudio = softwareAudio
    return ExoPlayer.Builder(context, renderers)
      .setLooper(thread.looper)
      .setLoadControl(loadControl)
      .setAudioAttributes(audio, true)
      .setHandleAudioBecomingNoisy(true)
      .build()
      .also { built ->
        built.addListener(reporter)
        built.addListener(pictures)
        surface?.let { built.setVideoSurface(it) }
      }
  }

  /** The gate outlives the player: a released player's forced connections that never closed are forgotten. */
  private fun releasePlayer() {
    val old = player ?: return
    player = null
    old.removeListener(reporter)
    old.removeListener(pictures)
    old.release()
    gate.dropForced()
  }

  private companion object {
    fun lowRam(context: Context): Boolean {
      val activity = context.getSystemService(ActivityManager::class.java) ?: return true
      val memory = ActivityManager.MemoryInfo().also { activity.getMemoryInfo(it) }
      return isLowRam(activity.isLowRamDevice, memory.totalMem)
    }
  }
}

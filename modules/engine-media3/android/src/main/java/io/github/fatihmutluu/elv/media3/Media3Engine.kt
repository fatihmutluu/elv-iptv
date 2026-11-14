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
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.sharedobjects.SharedObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "ElvMedia3"
private const val EVENT = "onEngineEvent"

/** Software decoders first for audio only; video keeps the platform order. */
@OptIn(UnstableApi::class)
private val SOFTWARE_AUDIO_FIRST = MediaCodecSelector { mimeType, secure, tunneling ->
  val decoders = MediaCodecSelector.DEFAULT.getDecoderInfos(mimeType, secure, tunneling)
  if (MimeTypes.isAudio(mimeType)) MediaCodecUtil.getDecoderInfosSortedBySoftwareOnly(decoders) else decoders
}

/** Receives the zap shutter's state on the playback thread: the load serial [media] and whether it [framed]. */
internal fun interface ShutterSink {
  fun onShutter(media: Long, framed: Boolean)
}

/**
 * The `PlayerEngine` of player core spec 5.1 on Media3, one per player screen (an Expo shared object). ExoPlayer
 * lives on this engine's own playback thread (its application looper): JavaScript calls post there and return at
 * once, and every event is sent from there, tagged with the current attempt token.
 */
@OptIn(UnstableApi::class)
class Media3Engine(
  private val context: Context,
  appContext: AppContext,
  private val onDisposed: (Media3Engine) -> Unit,
) : SharedObject(appContext) {
  private val thread = HandlerThread("ElvMedia3").apply { start() }
  private val handler = Handler(thread.looper)
  private val disposed = AtomicBoolean(false)
  private val gate = ConnectionGate()
  private val buffers = loadControlFor(lowRam(context))
  private val reporter = EventReporter(handler, { fields -> sendEvent(fields) }, { playAsHls() }, { onFramed() })

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
  private var shutter: ShutterSink? = null

  /** The engine is passed to the surface view as a prop; let pending view updates apply before it goes. */
  override val releasesAfterPendingViewUpdates: Boolean = true

  init {
    post { player = buildPlayer(softwareAudio = false) }
  }

  /**
   * Starts a new media: the previous one is stopped, a new connection-gate generation begins and the zap shutter
   * covers the surface until this media's first frame.
   */
  internal fun load(attempt: Int, next: LoadRequest) = post {
    reporter.end()
    player?.stop()
    token = attempt
    request = next
    media += 1
    framed = false
    shutter?.onShutter(media, false)
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

  /** Stops the media and closes its connections; later requests of it are refused by the gate. */
  fun stop(attempt: Int) = post {
    adopt(attempt)
    reporter.end()
    request = null
    beginGeneration()
    player?.stop()
    player?.clearMediaItems()
  }

  /** Releases ExoPlayer and builds a new one on the same thread and surface; it stays idle until `load` or `retry`. */
  fun recreate(attempt: Int) = post {
    adopt(attempt)
    reporter.end()
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

  /** Zap shutter hook: [sink] gets the current state now and every change from now on, on the playback thread. */
  internal fun bindShutter(sink: ShutterSink) = post {
    shutter = sink
    sink.onShutter(media, framed)
  }

  internal fun unbindShutter(sink: ShutterSink) = post {
    if (shutter === sink) shutter = null
  }

  /** Releases the player and ends the playback thread; later commands do nothing. Safe to call twice. */
  fun dispose() {
    if (!disposed.compareAndSet(false, true)) return
    onDisposed(this)
    handler.post {
      reporter.end()
      releasePlayer()
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
    shutter?.onShutter(media, true)
  }

  private fun adopt(attempt: Int) {
    if (attempt > token) token = attempt
  }

  private fun sendEvent(fields: Map<String, Any?>) {
    if (disposed.get()) return
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
    if (player == null || playerSoftwareAudio != next.softwareAudio) {
      releasePlayer()
      player = buildPlayer(next.softwareAudio)
    }
    val current = player ?: return
    current.stop()
    if (newGeneration) beginGeneration()
    val manifestLoaded = AtomicBoolean(false)
    reporter.begin(current, next.live, manifestLoaded)
    val source = createMediaSource(next, gate, generation, manifestLoaded)
    if (positionMs == null) current.setMediaSource(source, true) else current.setMediaSource(source, positionMs)
    current.playWhenReady = true
    current.prepare()
  }

  private fun buildPlayer(softwareAudio: Boolean): ExoPlayer {
    val renderers = DefaultRenderersFactory(context)
      .setEnableDecoderFallback(true)
      .setExtensionRendererMode(
        if (softwareAudio) {
          DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER
        } else {
          DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF
        },
      )
      .setMediaCodecSelector(if (softwareAudio) SOFTWARE_AUDIO_FIRST else MediaCodecSelector.DEFAULT)
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
        surface?.let { built.setVideoSurface(it) }
      }
  }

  private fun releasePlayer() {
    val old = player ?: return
    player = null
    old.removeListener(reporter)
    old.release()
  }

  private companion object {
    fun lowRam(context: Context): Boolean {
      val activity = context.getSystemService(ActivityManager::class.java) ?: return true
      val memory = ActivityManager.MemoryInfo().also { activity.getMemoryInfo(it) }
      return isLowRam(activity.isLowRamDevice, memory.totalMem)
    }
  }
}

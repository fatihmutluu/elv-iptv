package io.github.fatihmutluu.elv.media3

import android.os.Handler
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.video.MediaCodecVideoDecoderException
import java.util.concurrent.atomic.AtomicBoolean

private const val TICK_MS = 1_000L

/** Finds the first cause of type [T] in the chain of [error]. */
private inline fun <reified T : Throwable> causeOf(error: Throwable): T? {
  var cause: Throwable? = error
  while (cause != null) {
    if (cause is T) return cause
    cause = cause.cause
  }
  return null
}

/**
 * Turns the player's callbacks into `onEngineEvent` payloads (without the token, which [send] adds) on the playback
 * thread: coarse states, `firstFrame`, `stall` start and end, `error` and `clock` anchors. Anchors follow the
 * effective rate (speed while playing, 0 otherwise), so start, pause, stall start and stall end each send one; seeks
 * send one too, and while playing a tick sends one at most once a second. `firstFrame` is sent once per prepare and
 * never for a frame of the media before it ([FirstFrameFence]); [onFirstFrame] then lifts the zap shutter. A playlist
 * found behind a progressive guess is no error: [onHlsDetected] lets the engine prepare the request again as HLS.
 * Every state and error sent is also handed to [onCue], with whether this prepare played, for the screen-on rule.
 */
@OptIn(UnstableApi::class)
internal class EventReporter(
  private val handler: Handler,
  private val send: (Map<String, Any?>) -> Unit,
  private val onHlsDetected: () -> Unit,
  private val onFirstFrame: () -> Unit,
  private val onCue: (ScreenCue, Boolean) -> Unit,
) : Player.Listener {
  private var player: Player? = null
  private var active = false
  private var live = false
  private var lastState: String? = null
  private var played = false
  private var stalled = false
  private var anchoredRate: Float? = null
  private var manifestLoaded: AtomicBoolean? = null
  private val frames = FirstFrameFence()
  private var prepares = 0L
  private val tick = Runnable { player?.let { anchor(it) } }

  /**
   * Starts reporting a new prepare of [player], called after its `stop`: forgets the previous one, sends the
   * first-frame fence and reports `opening`. [manifestLoaded] is set once the media's timeline is known.
   */
  fun begin(player: ExoPlayer, live: Boolean, manifestLoaded: AtomicBoolean) {
    end()
    this.player = player
    this.live = live
    this.manifestLoaded = manifestLoaded
    val prepare = ++prepares
    frames.begin(prepare)
    player.createMessage { _, _ -> frames.passed(prepare) }.setLooper(handler.looper).send()
    active = true
    sendState("opening")
  }

  /** Stops reporting (load, retry, stop, recreate, release): an open stall ends, the clock tick stops. */
  fun end() {
    if (active && stalled) sendStall("end")
    active = false
    lastState = null
    played = false
    stalled = false
    anchoredRate = null
    handler.removeCallbacks(tick)
  }

  override fun onEvents(player: Player, events: Player.Events) {
    if (!active || player !== this.player) return
    if (events.containsAny(
        Player.EVENT_PLAYBACK_STATE_CHANGED,
        Player.EVENT_PLAY_WHEN_READY_CHANGED,
        Player.EVENT_IS_PLAYING_CHANGED,
        Player.EVENT_PLAYBACK_PARAMETERS_CHANGED,
        Player.EVENT_PLAYER_ERROR,
      )
    ) {
      update(player)
    }
  }

  /** `setMediaSource` publishes a placeholder window at once; the source's own window arrives with its manifest. */
  override fun onTimelineChanged(timeline: Timeline, reason: Int) {
    if (!active || reason != Player.TIMELINE_CHANGE_REASON_SOURCE_UPDATE || timeline.isEmpty) return
    if (!timeline.getWindow(0, Timeline.Window()).isPlaceholder) manifestLoaded?.set(true)
  }

  override fun onPositionDiscontinuity(
    oldPosition: Player.PositionInfo,
    newPosition: Player.PositionInfo,
    reason: Int,
  ) {
    val seek = reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT
    val current = player
    if (active && seek && current != null) anchor(current)
  }

  override fun onRenderedFirstFrame() {
    if (!active || !frames.accept()) return
    send(mapOf("type" to "firstFrame", "atMs" to SystemClock.uptimeMillis().toDouble()))
    onFirstFrame()
  }

  override fun onPlayerError(error: PlaybackException) {
    if (!active) return
    if (causeOf<HlsDetectedException>(error) != null) {
      onHlsDetected()
      return
    }
    val status = causeOf<HttpDataSource.InvalidResponseCodeException>(error)?.responseCode
    val contentType = causeOf<HttpDataSource.InvalidContentTypeException>(error)?.contentType
    val notice = causeOf<ProviderNoticeException>(error)
    val uri = causeOf<HttpDataSource.HttpDataSourceException>(error)?.dataSpec?.uri
    val detail = when {
      notice != null -> "${error.errorCodeName} provider notice ${notice.contentType.orEmpty()}".trimEnd()
      uri != null -> "${error.errorCodeName} ${redactUrl(uri.toString())}"
      else -> error.errorCodeName
    }
    val surfaceLost = causeOf<MediaCodecVideoDecoderException>(error)?.let { !it.isSurfaceValid } == true
    val code = mapError(
      status,
      contentType,
      error.errorCode,
      notice = notice != null,
      live = live,
      played = played,
      surfaceLost = surfaceLost,
    )
    sendError(code, status, detail)
  }

  private fun update(player: Player) {
    val state = stateOf(player)
    if (state == "ended" && live) {
      if (lastState != state) sendError("network", null, "live stream ended")
      lastState = state
    } else if (state != null && state != lastState) {
      lastState = state
      sendState(state)
    }
    if (player.isPlaying) played = true
    val nowStalled = played && player.playWhenReady && player.playbackState == Player.STATE_BUFFERING
    if (nowStalled != stalled) {
      stalled = nowStalled
      sendStall(if (nowStalled) "start" else "end")
    }
    if (effectiveRate(player) != anchoredRate) anchor(player)
  }

  private fun anchor(player: Player) {
    handler.removeCallbacks(tick)
    if (!active) return
    val rate = effectiveRate(player)
    anchoredRate = rate
    val anchor = mutableMapOf<String, Any?>(
      "positionMs" to player.currentPosition.coerceAtLeast(0L).toDouble(),
      "atMs" to SystemClock.uptimeMillis().toDouble(),
      "rate" to rate.toDouble(),
    )
    val duration = player.duration
    if (duration != C.TIME_UNSET) anchor[if (live) "liveEdgeMs" else "durationMs"] = duration.toDouble()
    send(mapOf("type" to "clock", "anchor" to anchor))
    if (rate > 0f) handler.postDelayed(tick, TICK_MS)
  }

  private fun sendState(state: String) {
    send(mapOf("type" to "state", "state" to state))
    ScreenCue.ofState(state)?.let { onCue(it, played) }
  }

  private fun sendStall(phase: String) =
    send(mapOf("type" to "stall", "phase" to phase, "atMs" to SystemClock.uptimeMillis().toDouble()))

  private fun sendError(code: String, httpStatus: Int?, detail: String) {
    val error = mutableMapOf<String, Any?>("code" to code, "detail" to detail)
    if (httpStatus != null) error["httpStatus"] = httpStatus
    send(mapOf("type" to "error", "error" to error))
    onCue(ScreenCue.ERROR, played)
  }

  private companion object {
    fun effectiveRate(player: Player): Float = if (player.isPlaying) player.playbackParameters.speed else 0f

    /** `paused` only when playback is not wanted; buffering and playing only while it is. */
    fun stateOf(player: Player): String? =
      when (player.playbackState) {
        Player.STATE_IDLE -> null
        Player.STATE_ENDED -> "ended"
        else -> when {
          !player.playWhenReady -> "paused"
          player.playbackState == Player.STATE_BUFFERING -> "buffering"
          player.isPlaying -> "playing"
          else -> "ready"
        }
      }
  }
}

package io.github.fatihmutluu.elv.media3

import android.os.Handler
import android.os.SystemClock
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecRenderer
import androidx.media3.exoplayer.video.MediaCodecVideoDecoderException

private const val TICK_MS = 1_000L
private const val MAX_BEHIND_LIVE_RECOVERIES = 2

/**
 * Turns the player's callbacks into `onEngineEvent` payloads (without the token, which [send] adds) on the playback
 * thread: coarse states, `firstFrame`, `stall` start and end, `error` and `clock` anchors. Callbacks are gated behind
 * [fence] so stale messages from a stopped prepare are dropped.
 */
@OptIn(UnstableApi::class)
internal class EventReporter(
  private val handler: Handler,
  private val fence: PrepareFence,
  private val hasInvalidAttachedSurface: () -> Boolean = { false },
  private val send: (Map<String, Any?>) -> Unit,
  private val onHlsDetected: () -> Unit,
  private val onBehindLiveWindow: () -> Unit,
  private val onAudioFocusDenied: () -> Boolean,
  private val onVideoCodecFailed: (MediaCodecInfo) -> Unit,
  private val onDolbyVisionFailed: () -> Unit = {},
  private val onFirstFrame: () -> Unit,
  private val onCue: (ScreenCue, Boolean) -> Unit,
) : Player.Listener {
  private var player: Player? = null
  private var active = false
  private var live = false
  private var lastState: String? = null
  private var played = false
  private var stalled = false
  private var behindLiveRecoveries = 0
  private var anchoredRate: Float? = null
  private val tick = Runnable { player?.let { anchor(it) } }

  /** True while this prepare is opening, buffering, or stalled and transfer progress should be reported. */
  @Volatile
  var isWaitingForMedia: Boolean = false
    private set

  /**
   * Starts reporting a new prepare [prepareSerial] of [player], sends the post-`stop` fence message through Media3's
   * playback thread and reports `opening`.
   */
  fun begin(player: ExoPlayer, live: Boolean, prepareSerial: Long, reused: Boolean) {
    end()
    this.player = player
    this.live = live
    fence.begin(prepareSerial, reused = reused)
    player.createMessage { _, _ -> fence.passed(prepareSerial) }.setLooper(handler.looper).send()
    active = true
    isWaitingForMedia = true
    sendState("opening")
  }

  /** Stops reporting (load, retry, stop, recreate, release): an open stall ends, the clock tick stops, fence closes. */
  fun end() {
    if (active && stalled) sendStall("end")
    active = false
    isWaitingForMedia = false
    fence.reset()
    lastState = null
    played = false
    stalled = false
    behindLiveRecoveries = 0
    anchoredRate = null
    handler.removeCallbacks(tick)
  }

  /** Emits a byte-progress event while opening, buffering, or stalled (#314, #321). */
  fun onTransferProgress(bytesReceived: Long, atMs: Long) {
    if (!active || !isWaitingForMedia) return
    send(
      mapOf(
        "type" to "progress",
        "bytesReceived" to bytesReceived.toDouble(),
        "atMs" to atMs.toDouble(),
      )
    )
  }

  override fun onEvents(player: Player, events: Player.Events) {
    if (!active || player !== this.player || !fence.acceptsPlayer(player)) return
    if (events.containsAny(
        Player.EVENT_PLAYBACK_STATE_CHANGED,
        Player.EVENT_PLAY_WHEN_READY_CHANGED,
        Player.EVENT_PLAYBACK_SUPPRESSION_REASON_CHANGED,
        Player.EVENT_IS_PLAYING_CHANGED,
        Player.EVENT_PLAYBACK_PARAMETERS_CHANGED,
        Player.EVENT_TRACKS_CHANGED,
        Player.EVENT_PLAYER_ERROR,
      )
    ) {
      update(player)
    }
  }

  override fun onPositionDiscontinuity(
    oldPosition: Player.PositionInfo,
    newPosition: Player.PositionInfo,
    reason: Int,
  ) {
    val seek = reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT
    val current = player
    if (active && seek && current != null && fence.acceptsPlayer(current)) anchor(current)
  }

  override fun onRenderedFirstFrame() {
    if (!active || !fence.acceptFirstFrame()) return
    send(mapOf("type" to "firstFrame", "atMs" to SystemClock.uptimeMillis().toDouble()))
    onFirstFrame()
  }

  override fun onPlayerError(error: PlaybackException) {
    val current = player
    if (!active || (current != null && !fence.acceptsPlayer(current))) return
    if (causeOf<SupersededMediaException>(error) != null) return
    if (causeOf<HlsDetectedException>(error) != null) {
      onHlsDetected()
      return
    }
    if (causeOf<SecurityException>(error) != null && onAudioFocusDenied()) return
    if (
      live &&
      error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW &&
      behindLiveRecoveries < MAX_BEHIND_LIVE_RECOVERIES
    ) {
      behindLiveRecoveries += 1
      onBehindLiveWindow()
      return
    }
    val videoDecoderError = causeOf<MediaCodecVideoDecoderException>(error)
    val videoInitError =
      causeOf<MediaCodecRenderer.DecoderInitializationException>(error)?.takeIf {
        it.mimeType != null && MimeTypes.isVideo(it.mimeType)
      }
    val surfaceLost =
      (videoDecoderError?.let { !it.isSurfaceValid } == true) ||
        (videoInitError != null && hasInvalidAttachedSurface())
    val failedCodec = videoDecoderError?.codecInfo ?: videoInitError?.codecInfo
    if (!surfaceLost) {
      if (failedCodec != null) {
        onVideoCodecFailed(failedCodec)
      }
      val isDolbyVisionFailure =
        failedCodec?.mimeType.equals(MimeTypes.VIDEO_DOLBY_VISION, ignoreCase = true) ||
          videoInitError?.mimeType.equals(MimeTypes.VIDEO_DOLBY_VISION, ignoreCase = true)
      if (isDolbyVisionFailure) {
        onDolbyVisionFailed()
      }
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
    val validVodEof =
      !live && player.duration != C.TIME_UNSET && player.duration > 0L && player.currentPosition > 0L
    if (state == "ended" && (live || (!played && !validVodEof))) {
      if (lastState != state) {
        sendError("network", null, if (live) "live stream ended" else "empty media ended before playback")
      }
      lastState = state
    } else if (state != null && state != lastState) {
      lastState = state
      sendState(state)
    }
    if (player.isPlaying) {
      played = true
      behindLiveRecoveries = 0
      if (isAudioOnlyTracks(player.currentTracks) && fence.acceptAudioFirstFrame()) {
        send(mapOf("type" to "firstFrame", "atMs" to SystemClock.uptimeMillis().toDouble()))
      }
    }
    val suppressed = player.playbackSuppressionReason != Player.PLAYBACK_SUPPRESSION_REASON_NONE
    val nowStalled =
      played && player.playWhenReady && !suppressed && player.playbackState == Player.STATE_BUFFERING
    if (nowStalled != stalled) {
      stalled = nowStalled
      sendStall(if (nowStalled) "start" else "end")
    }
    isWaitingForMedia = !played || stalled || lastState == "opening" || lastState == "buffering"
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
    val tracks = player.currentTracks
    val hasVideo = if (tracks.isEmpty) null else hasSelectedVideoTrack(tracks)
    if (hasVideo != null) anchor["hasVideoTrack"] = hasVideo
    val counters = (player as? ExoPlayer)?.videoDecoderCounters
    if (counters != null) {
      counters.ensureUpdated()
      anchor["decodedVideoFrames"] = counters.renderedOutputBufferCount.toDouble()
    } else if (hasVideo == true) {
      anchor["decodedVideoFrames"] = 0.0
    }
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

    fun hasSelectedVideoTrack(tracks: Tracks): Boolean =
      tracks.groups.any { group -> group.type == C.TRACK_TYPE_VIDEO && group.isSelected }

    fun isAudioOnlyTracks(tracks: Tracks): Boolean {
      var hasAudio = false
      for (group in tracks.groups) {
        if (group.type == C.TRACK_TYPE_VIDEO && (group.isSelected || group.isSupported)) return false
        if (group.type == C.TRACK_TYPE_AUDIO && (group.isSelected || group.isSupported)) hasAudio = true
      }
      return hasAudio
    }

    /** `paused` when playback is not wanted or transiently suppressed (e.g. phone call audio-focus loss). */
    fun stateOf(player: Player): String? =
      when (player.playbackState) {
        Player.STATE_IDLE -> null
        Player.STATE_ENDED -> "ended"
        else -> when {
          !player.playWhenReady ||
            player.playbackSuppressionReason != Player.PLAYBACK_SUPPRESSION_REASON_NONE -> "paused"
          player.playbackState == Player.STATE_BUFFERING -> "buffering"
          player.isPlaying -> "playing"
          else -> "ready"
        }
      }
  }
}

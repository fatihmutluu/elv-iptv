package io.github.fatihmutluu.elv.media3

import android.util.Log
import android.view.Surface
import androidx.annotation.OptIn
import androidx.media3.common.VideoSize
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer

private const val TAG = "ElvMedia3"

/** Receives what the surface view shows, on the playback thread; [SurfaceController.bindView] sends the state first. */
internal interface ViewSink {
  /** The zap shutter: the load serial [media] and whether its first frame rendered. */
  fun onShutter(media: Long, framed: Boolean)

  /** Media3's decoded picture size; zero while no video renders (the view then keeps the last shape). */
  fun onVideoSize(width: Int, height: Int, pixelRatio: Float)

  /** Whether playback wants the screen kept on ([keepsScreenOn]). */
  fun onScreenOn(on: Boolean)

  /** Active text/bitmap subtitle cues to render inside `SubtitleView` (empty clears visible subtitles). */
  fun onCues(cues: List<Cue>) = Unit
}

/**
 * Playback-thread coordinator for the video [Surface], [ViewSink] binding, zap shutter serials, per-media
 * `awaitingVideoSize` gating (#331), subtitle cues and `keepScreenOn` state (#84, #279).
 */
@OptIn(UnstableApi::class)
internal class SurfaceController {
  /** The surface the view offers, written on the UI thread; an attach that a detach overtook is skipped. */
  @Volatile
  private var offered: Surface? = null

  private var surface: Surface? = null
  private var view: ViewSink? = null
  private var media = 0L
  private var framed = false
  private var screenOn = false
  private var awaitingVideoSize = true
  private var lastVideoSize: VideoSize = VideoSize.UNKNOWN
  private var currentCues: List<Cue> = emptyList()

  /** Records [next] from the UI thread before posting [attachPendingSurface] to the playback thread. */
  fun offerSurface(next: Surface) {
    offered = next
  }

  /** Clears [offered] on the UI thread when [old] is being destroyed. */
  fun clearOfferedIfSame(old: Surface) {
    if (offered === old) offered = null
  }

  /** Attaches [next] on the playback thread if still current and valid; returns true when newly attached. */
  fun attachPendingSurface(next: Surface, player: ExoPlayer?, onSurfaceChange: (String) -> Unit): Boolean {
    if (offered !== next || surface === next || !next.isValid) return false
    surface = next
    player?.setVideoSurface(next)
    onSurfaceChange("created")
    return true
  }

  /** Detaches [old] on the playback thread and reports `destroyed` if it was the attached surface. */
  fun detachNow(old: Surface, player: ExoPlayer?, onSurfaceChange: (String) -> Unit) {
    if (surface !== old) return
    surface = null
    try {
      player?.clearVideoSurface(old)
    } catch (e: Exception) {
      Log.e(TAG, "surface detach failed: ${e.javaClass.simpleName}")
    }
    onSurfaceChange("destroyed")
  }

  /** Whether an attached [Surface] became invalid asynchronously before `surfaceDestroyed` ran. */
  fun hasInvalidAttachedSurface(): Boolean = surface?.let { !it.isValid } == true

  /**
   * Binds the currently attached valid [Surface] onto a newly constructed [ExoPlayer], or clears [surface] and emits
   * `destroyed` when an attached surface invalidated asynchronously before `surfaceDestroyed` ran.
   */
  fun attachToNewPlayer(player: ExoPlayer, onSurfaceChange: (String) -> Unit = {}) {
    val active = surface ?: return
    if (!active.isValid) {
      surface = null
      onSurfaceChange("destroyed")
      return
    }
    player.setVideoSurface(active)
  }

  /** Binds [sink] on the playback thread and immediately delivers current shutter, gated size, screen-on and cues. */
  fun bindView(sink: ViewSink) {
    if (view != null && view !== sink) {
      Log.w(TAG, "replacing active ViewSink binding; only one Media3Surface per engine is supported")
    }
    view = sink
    sink.onShutter(media, framed)
    if (!awaitingVideoSize && lastVideoSize.width > 0 && lastVideoSize.height > 0) {
      sink.onVideoSize(lastVideoSize.width, lastVideoSize.height, lastVideoSize.pixelWidthHeightRatio)
    }
    sink.onScreenOn(screenOn)
    sink.onCues(currentCues)
  }

  fun unbindView(sink: ViewSink) {
    if (view === sink) view = null
  }

  /** Begins a new media zap: advances the shutter serial, clears cues and gates stale video size until decoded. */
  fun onLoad() {
    clearCues()
    media += 1
    framed = false
    awaitingVideoSize = true
    lastVideoSize = VideoSize.UNKNOWN
    view?.onShutter(media, false)
  }

  /** Resets video size gating and clears cues on `stop` / `dispose`. */
  fun onStop() {
    clearCues()
    awaitingVideoSize = true
    lastVideoSize = VideoSize.UNKNOWN
    onCue(ScreenCue.STOP, played = false)
  }

  /** Lifts the zap shutter once the active video media rendered its first frame. */
  fun onFramed() {
    if (framed || media == 0L) return
    framed = true
    view?.onShutter(media, true)
  }

  /** Delivers a fenced [videoSize] from the active media, unlocking [awaitingVideoSize] once positive. */
  fun onVideoSizeChanged(videoSize: VideoSize) {
    if (videoSize.width > 0 && videoSize.height > 0) {
      awaitingVideoSize = false
      lastVideoSize = videoSize
    }
    view?.onVideoSize(videoSize.width, videoSize.height, videoSize.pixelWidthHeightRatio)
  }

  fun onCues(cues: List<Cue>) {
    currentCues = cues
    view?.onCues(cues)
  }

  fun clearCues() {
    currentCues = emptyList()
    view?.onCues(emptyList())
  }

  fun onCue(cue: ScreenCue, played: Boolean) {
    val next = keepsScreenOn(screenOn, cue, played)
    if (next == screenOn) return
    screenOn = next
    view?.onScreenOn(next)
  }
}

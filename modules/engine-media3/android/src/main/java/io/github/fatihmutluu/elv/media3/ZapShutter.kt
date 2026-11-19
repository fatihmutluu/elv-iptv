package io.github.fatihmutluu.elv.media3

import androidx.media3.common.Player

/**
 * The zap shutter's state on the UI thread (player core spec 6.1): it covers the surface before any media and from
 * each `load` until the first frame of that same media. Reports name their media by its load serial, so a late
 * report about an older media changes nothing, and a media that showed its first frame stays uncovered.
 */
internal class ZapShutter {
  private var media = 0L
  private var framed = false

  /** True while the surface must stay hidden behind the black shutter. */
  val covers: Boolean
    get() = !framed

  /** Applies the engine's report that [media] is loaded and whether its first frame rendered; returns [covers]. */
  fun update(media: Long, framed: Boolean): Boolean {
    if (media > this.media) {
      this.media = media
      this.framed = framed
    } else if (media == this.media && media > 0L) {
      this.framed = this.framed || framed
    }
    return covers
  }

  /** Forgets every media: the view was bound to another engine, whose serials start again. */
  fun reset() {
    media = 0L
    framed = false
  }
}

/**
 * Gates renderer and playback callbacks across prepares on the engine's application looper. Each prepare sends a
 * `PlayerMessage` behind `player.stop()` through Media3's internal playback thread: renderer callbacks
 * (`onRenderedFirstFrame`, `onVideoSizeChanged`, `onCues`) and reused-player updates queued before `MSG_STOP` arrive
 * before [passed] and are discarded as stale, while `MediaItem.mediaId` also verifies item identity.
 */
internal class PrepareFence {
  private var current = 0L
  private var rendererOpen = false
  private var playbackOpen = false
  private var firstFrameReported = false

  /** True once the post-`stop` barrier message of [current] arrived on the application thread. */
  val isRendererOpen: Boolean
    get() = rendererOpen

  /** Prepare [prepare] began; when [reused] is false (a freshly built `ExoPlayer`), playback callbacks are open. */
  fun begin(prepare: Long, reused: Boolean = true) {
    current = prepare
    rendererOpen = false
    playbackOpen = !reused
    firstFrameReported = false
  }

  /** Closes all gates when reporting stops (`stop`, `recreate`, `dispose`, failed command). */
  fun reset() {
    rendererOpen = false
    playbackOpen = false
    firstFrameReported = false
  }

  /** The fence message of [prepare] arrived on the application thread. */
  fun passed(prepare: Long) {
    if (prepare == current) {
      rendererOpen = true
      playbackOpen = true
    }
  }

  /** True when [mediaId] belongs to [current] (or no `MediaItem` is set) and the playback gate is open. */
  fun acceptsMediaId(mediaId: String?): Boolean =
    playbackOpen && (mediaId == null || mediaId == current.toString())

  /** True when [player]'s callbacks belong to the active prepare. */
  fun acceptsPlayer(player: Player): Boolean = acceptsMediaId(player.currentMediaItem?.mediaId)

  /** A video `onRenderedFirstFrame` arrived: true once for [current] after [passed]. */
  fun acceptFirstFrame(): Boolean {
    if (!rendererOpen || firstFrameReported) return false
    firstFrameReported = true
    return true
  }

  /** An audio-only stream reached `playing`: reports `firstFrame` once for [current] while keeping the shutter closed. */
  fun acceptAudioFirstFrame(): Boolean {
    if (!playbackOpen || firstFrameReported) return false
    firstFrameReported = true
    return true
  }
}

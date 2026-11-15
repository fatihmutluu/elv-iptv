package io.github.fatihmutluu.elv.media3

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
 * Tells the first frame of the current prepare from a stale one on the playback thread. Media3 posts a renderer's
 * first-frame callback to the application thread, so the previous media's can arrive after a `load` already ran.
 * Each prepare sends a player message through Media3's playback thread after its `stop`; the message reaches the
 * application thread after every callback of the stopped renderers, so only callbacks after it are the new media's,
 * and only the first of them is reported.
 */
internal class FirstFrameFence {
  private var current = 0L
  private var open = false
  private var reported = false

  /** Prepare [prepare] began: callbacks are stale until its fence message arrives. */
  fun begin(prepare: Long) {
    current = prepare
    open = false
    reported = false
  }

  /** The fence message of [prepare] arrived on the application thread. */
  fun passed(prepare: Long) {
    if (prepare == current) open = true
  }

  /** A first-frame callback arrived: true when it is the current prepare's first frame. */
  fun accept(): Boolean {
    if (!open || reported) return false
    reported = true
    return true
  }
}

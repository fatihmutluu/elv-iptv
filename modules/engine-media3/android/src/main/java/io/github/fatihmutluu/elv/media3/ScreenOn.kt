package io.github.fatihmutluu.elv.media3

/** The engine reports that decide whether the screen stays on: its `state` events, an error and `stop`. */
internal enum class ScreenCue {
  OPENING,
  BUFFERING,
  READY,
  PLAYING,
  PAUSED,
  ENDED,
  ERROR,
  STOP,
  ;

  companion object {
    /** The cue of an engine `state` event name, or null for a name that is no state. */
    fun ofState(state: String): ScreenCue? =
      when (state) {
        "opening" -> OPENING
        "buffering" -> BUFFERING
        "ready" -> READY
        "playing" -> PLAYING
        "paused" -> PAUSED
        "ended" -> ENDED
        else -> null
      }
  }
}

/**
 * Whether the screen stays on after [cue] (player core spec 6.1), given whether it was kept on [before] and whether
 * the current prepare [played]: on while playing and while buffering after it played; off on pause, end, an error and
 * `stop`. Opening, ready and buffering before the first play keep [before], so a zap or a recovery retry from a
 * playing media never lets the screen sleep.
 */
internal fun keepsScreenOn(before: Boolean, cue: ScreenCue, played: Boolean): Boolean =
  when (cue) {
    ScreenCue.PLAYING -> true
    ScreenCue.BUFFERING -> before || played
    ScreenCue.OPENING, ScreenCue.READY -> before
    ScreenCue.PAUSED, ScreenCue.ENDED, ScreenCue.ERROR, ScreenCue.STOP -> false
  }

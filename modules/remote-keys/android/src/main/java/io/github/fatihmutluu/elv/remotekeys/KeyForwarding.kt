package io.github.fatihmutluu.elv.remotekeys

import android.view.KeyEvent
import android.view.Window

/** Decides which window key events reach JavaScript and wraps window callbacks. */
object KeyForwarding {
  /**
   * Returns "down" for a first key press, "up" for any release, and null for events JavaScript must not see:
   * auto-repeats, ACTION_MULTIPLE and synthesized fallback events.
   */
  fun action(action: Int, repeatCount: Int, flags: Int): String? {
    if (flags and KeyEvent.FLAG_FALLBACK != 0) return null
    return when (action) {
      KeyEvent.ACTION_DOWN -> if (repeatCount == 0) "down" else null
      KeyEvent.ACTION_UP -> "up"
      else -> null
    }
  }

  /** Wraps [callback] so key events and focus loss go to [onEvent]; returns [callback] itself if already wrapped. */
  fun wrap(callback: Window.Callback, onEvent: (Map<String, Any>) -> Unit): Window.Callback =
    if (callback is ForwardingWindowCallback) callback else ForwardingWindowCallback(callback, onEvent)
}

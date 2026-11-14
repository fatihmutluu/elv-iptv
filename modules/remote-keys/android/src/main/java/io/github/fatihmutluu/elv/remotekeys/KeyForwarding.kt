package io.github.fatihmutluu.elv.remotekeys

import android.view.KeyEvent
import android.view.Window

/** Decides which window key events reach JavaScript, wraps window callbacks and holds the current event sink. */
object KeyForwarding {
  @Volatile
  private var sink: ((Map<String, Any>) -> Unit)? = null

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

  /**
   * Builds the `onKey` payload of a forwarded key. `eventTime` is the event's uptime stamp; JavaScript subtracts it
   * from `uptimeMs()` on receipt, so the age includes the wait for the JS thread.
   */
  fun payload(action: String, keyCode: Int, flags: Int, eventTime: Long): Map<String, Any> =
    mapOf(
      "action" to action,
      "keyCode" to keyCode,
      "canceled" to (flags and KeyEvent.FLAG_CANCELED != 0),
      "eventTime" to eventTime.toDouble(),
    )

  /**
   * Wraps [callback] so key events and focus loss reach the current sink; returns [callback] itself if already wrapped.
   * The sink is process-wide, so a wrapper that outlives its module (JS reload) reports to the new module.
   */
  fun wrap(callback: Window.Callback): Window.Callback =
    if (callback is ForwardingWindowCallback) callback else ForwardingWindowCallback(callback)

  /** Makes [newSink] the receiver of all forwarded events, replacing any earlier one. */
  fun setSink(newSink: (Map<String, Any>) -> Unit) {
    sink = newSink
  }

  /** Removes [oldSink] if it is still the current sink; a newer module's sink is left alone. */
  fun clearSink(oldSink: (Map<String, Any>) -> Unit) {
    if (sink === oldSink) sink = null
  }

  /** Delivers [payload] to the current sink; a failing sink never propagates to the key dispatch. */
  fun emit(payload: Map<String, Any>) {
    try {
      sink?.invoke(payload)
    } catch (_: Exception) {
    }
  }
}

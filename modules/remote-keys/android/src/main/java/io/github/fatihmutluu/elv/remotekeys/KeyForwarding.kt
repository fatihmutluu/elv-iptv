package io.github.fatihmutluu.elv.remotekeys

import android.view.KeyEvent
import android.view.Window
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicReference

/** Decides which window key events reach JavaScript, wraps window callbacks and holds the current event sink. */
object KeyForwarding {
  private val BLUR_PAYLOAD: Map<String, Any> = mapOf("action" to "blur")
  private val sink = AtomicReference<((Map<String, Any>) -> Unit)?>(null)

  /**
   * UI-thread registry of windows already wrapped by [ForwardingWindowCallback], keyed weakly with a [Boolean] value so
   * the map never retains a strong `value -> callback (Activity) -> Window (key)` cycle across destroyed activities.
   * Keyed by [Any] internally so pure-JVM JUnit tests can verify guarding and GC without instantiating the Android SDK's
   * stubbed [Window] constructor, while [wrap] enforces [Window] for production callers.
   */
  private val wrappedWindows = WeakHashMap<Any, Boolean>()

  /**
   * Returns "down" for a first key press, "up" for any release, and null for events JavaScript must not see:
   * auto-repeats, ACTION_MULTIPLE, synthesized fallback events and keys a soft keyboard (IME) injected.
   */
  fun action(action: Int, repeatCount: Int, flags: Int): String? {
    if (flags and (KeyEvent.FLAG_FALLBACK or KeyEvent.FLAG_SOFT_KEYBOARD) != 0) return null
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
   * Wraps [callback] for [window] on the UI thread unless [window] already has a [ForwardingWindowCallback] in its
   * chain, preventing double-wrapping if another library wraps `window.callback` after us.
   */
  fun wrap(window: Window, callback: Window.Callback): Window.Callback = wrapWindow(window, callback)

  internal fun wrapWindow(windowKey: Any, callback: Window.Callback): Window.Callback {
    if (wrappedWindows.containsKey(windowKey)) return callback
    val wrapper = wrap(callback) as ForwardingWindowCallback
    wrappedWindows[windowKey] = true
    return wrapper
  }

  /**
   * Wraps [callback] so key events and focus loss reach the current sink; returns [callback] itself if already wrapped.
   * The sink is process-wide, so a wrapper that outlives its module (JS reload) reports to the new module.
   */
  fun wrap(callback: Window.Callback): Window.Callback =
    if (callback is ForwardingWindowCallback) callback else ForwardingWindowCallback(callback)

  /** Makes [newSink] the receiver of all forwarded events, replacing any earlier one. */
  fun setSink(newSink: (Map<String, Any>) -> Unit) {
    sink.set(newSink)
  }

  /** Removes [oldSink] atomically if it is still the current sink; a newer module's sink is left alone. */
  fun clearSink(oldSink: (Map<String, Any>) -> Unit) {
    sink.compareAndSet(oldSink, null)
  }

  /** Emits a window blur event to cancel held keys on focus loss or activity backgrounding. */
  fun emitBlur() {
    emit(BLUR_PAYLOAD)
  }

  /** Delivers [payload] to the current sink; a failing sink never propagates to the key dispatch. */
  fun emit(payload: Map<String, Any>) {
    try {
      sink.get()?.invoke(payload)
    } catch (_: Exception) {
    }
  }
}

package io.github.fatihmutluu.elv.remotekeys

import android.app.Activity
import android.app.Dialog
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.view.KeyEvent
import android.view.View
import android.view.Window
import android.view.inspector.WindowInspector
import java.lang.ref.WeakReference
import java.lang.reflect.Modifier
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicReference

/** Decides which window key events reach JavaScript, wraps window callbacks and holds the current event sink. */
object KeyForwarding {
  private const val MAX_DELEGATE_DEPTH = 6
  private const val MAX_CONTEXT_DEPTH = 16
  private val BLUR_PAYLOAD: Map<String, Any> = mapOf("action" to "blur")
  private val sink = AtomicReference<((Map<String, Any>) -> Unit)?>(null)

  /**
   * UI-thread registry of windows wrapped by [ForwardingWindowCallback], storing a [WeakReference] to our wrapper
   * so the map never retains a strong `value -> callback (Activity) -> Window (key)` cycle across destroyed activities,
   * while allowing [wrapWindow] to detect when an SDK/DevSupport replaced `window.callback` completely (`#439`).
   */
  private val wrappedWindows = WeakHashMap<Any, WeakReference<ForwardingWindowCallback>>()

  /** UI-thread registry of secondary/modal root views that already have an unhandled-key listener attached. */
  private val modalViews = WeakHashMap<Any, Boolean>()

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

  /** Forwards a native [KeyEvent] to the current sink when it passes [action] filtering. */
  fun forwardKeyEvent(event: KeyEvent?) {
    if (event == null) return
    forwardRawKey(event.action, event.repeatCount, event.flags, event.keyCode, event.eventTime)
  }

  internal fun forwardRawKey(
    actionCode: Int,
    repeatCount: Int,
    flags: Int,
    keyCode: Int,
    eventTime: Long,
  ): Boolean {
    val mapped = action(actionCode, repeatCount, flags) ?: return false
    emit(payload(mapped, keyCode, flags, eventTime))
    return true
  }

  /**
   * Wraps [callback] for [window] on the UI thread unless [callback] already is or delegates to this window's active
   * [ForwardingWindowCallback]. Automatically re-wraps if an SDK or DevSupport replaced `window.callback` (`#439`).
   */
  fun wrap(
    window: Window,
    callback: Window.Callback,
    onFocusLost: (() -> Unit)? = null,
  ): Window.Callback = wrapWindow(window, callback, onFocusLost)

  internal fun wrapWindow(
    windowKey: Any,
    callback: Window.Callback,
    onFocusLost: (() -> Unit)? = null,
  ): Window.Callback {
    if (callback is ForwardingWindowCallback) {
      wrappedWindows[windowKey] = WeakReference(callback)
      return callback
    }
    val existingWrapper = wrappedWindows[windowKey]?.get()
    if (existingWrapper != null && containsInDelegateChain(callback, existingWrapper)) {
      return callback
    }
    val wrapper = ForwardingWindowCallback(callback, onFocusLost)
    wrappedWindows[windowKey] = WeakReference(wrapper)
    return wrapper
  }

  /**
   * Wraps [callback] so key events and focus loss reach the current sink; returns [callback] itself if already wrapped.
   * The sink is process-wide, so a wrapper that outlives its module (JS reload) reports to the new module.
   */
  fun wrap(callback: Window.Callback): Window.Callback =
    if (callback is ForwardingWindowCallback) callback else ForwardingWindowCallback(callback)

  /**
   * Wraps a [Dialog]'s window callback so keys pressed while a dialog/modal has focus reach JavaScript (`#439`).
   * Also records the dialog's decor view in [modalViews] so [installModalWindows] skips it without double-emitting.
   */
  fun wrapDialog(dialog: Dialog): Boolean {
    val window = dialog.window ?: return false
    val current = window.callback ?: return false
    val decorView = window.peekDecorView() ?: window.decorView
    val wrapped = wrapDialogWindow(window, current, decorView)
    if (wrapped !== current) {
      window.callback = wrapped
      return true
    }
    return false
  }

  internal fun wrapDialogWindow(
    windowKey: Any,
    callback: Window.Callback,
    decorViewKey: Any?,
  ): Window.Callback {
    val wrapped = wrapWindow(windowKey, callback)
    if (decorViewKey != null) modalViews[decorViewKey] = true
    return wrapped
  }

  internal fun isModalViewHandled(viewKey: Any): Boolean = modalViews.containsKey(viewKey)

  /**
   * Discovers secondary/modal windows owned by [activity] on Android API 29+ via public
   * [WindowInspector.getGlobalWindowViews]. Prefers wrapping an accessible [Dialog.getWindow] callback first (so
   * DPAD/Select keys are intercepted before focusable child controls consume them) and falls back to a deduplicated,
   * non-consuming [View.OnUnhandledKeyEventListener], never double-attaching to dialogs wrapped via [wrapDialog] (`#439`).
   */
  fun installModalWindows(activity: Activity): Int {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return 0
    val globalViews = try {
      WindowInspector.getGlobalWindowViews()
    } catch (_: Throwable) {
      return 0
    }
    val mainDecor = activity.window?.decorView
    var installed = 0
    for (view in globalViews) {
      if (view === mainDecor) continue
      val dialog = findDialog(view.context)
      val owned =
        findActivity(view.context) === activity || (dialog != null && findActivity(dialog.context) === activity)
      if (!owned) continue
      val added = installModalViewCandidate(
        viewKey = view,
        tryWrapDialog = {
          if (dialog != null && dialog.window != null) {
            wrapDialog(dialog)
            true
          } else {
            false
          }
        },
        attachUnhandledListener = {
          view.addOnUnhandledKeyEventListener(
            View.OnUnhandledKeyEventListener { _, event ->
              forwardKeyEvent(event)
              false
            },
          )
        },
      )
      if (added) installed += 1
    }
    return installed
  }

  internal fun installModalViewCandidate(
    viewKey: Any,
    tryWrapDialog: () -> Boolean,
    attachUnhandledListener: () -> Unit,
  ): Boolean {
    if (modalViews.containsKey(viewKey)) return false
    if (tryWrapDialog()) {
      modalViews[viewKey] = true
      return true
    }
    attachUnhandledListener()
    modalViews[viewKey] = true
    return true
  }

  internal fun installModalView(viewKey: Any, attach: () -> Unit): Boolean =
    installModalViewCandidate(viewKey, tryWrapDialog = { false }, attachUnhandledListener = attach)

  /** Reflection-free [ContextWrapper] unwrapping to identify a [Dialog] backing a modal root view when exposed. */
  internal fun findDialog(context: Context?): Dialog? {
    var current: Any? = context
    var depth = 0
    while (current != null && depth < MAX_CONTEXT_DEPTH) {
      if (current is Dialog) return current
      if (current !is ContextWrapper) return null
      val base = current.baseContext
      if (base === current) return null
      current = base
      depth += 1
    }
    return null
  }

  /** Reflection-free [ContextWrapper] unwrapping to identify the owning [Activity] of a view context. */
  internal fun findActivity(context: Context?): Activity? {
    var current = context
    var depth = 0
    while (current != null && depth < MAX_CONTEXT_DEPTH) {
      if (current is Activity) return current
      if (current !is ContextWrapper) return null
      val base = current.baseContext
      if (base === current) return null
      current = base
      depth += 1
    }
    return null
  }

  private fun containsInDelegateChain(
    root: Window.Callback,
    target: ForwardingWindowCallback,
  ): Boolean {
    val queue = ArrayDeque<Pair<Window.Callback, Int>>()
    val visited = mutableListOf<Window.Callback>()
    queue.addLast(root to 0)
    visited.add(root)

    fun enqueue(candidate: Window.Callback?, depth: Int) {
      if (candidate == null || depth > MAX_DELEGATE_DEPTH) return
      if (visited.any { it === candidate }) return
      visited.add(candidate)
      queue.addLast(candidate to depth)
    }

    while (queue.isNotEmpty()) {
      val (node, depth) = queue.removeFirst()
      if (node === target) return true
      if (depth >= MAX_DELEGATE_DEPTH) continue

      if (node is ForwardingWindowCallback) {
        enqueue(node.wrapped, depth + 1)
      }

      readWrappedGetter(node)?.let { enqueue(it, depth + 1) }

      var cls: Class<*>? = node.javaClass
      while (cls != null && cls != Any::class.java) {
        for (field in cls.declaredFields) {
          if (Modifier.isStatic(field.modifiers)) continue
          if (!Window.Callback::class.java.isAssignableFrom(field.type)) continue
          val value = try {
            field.isAccessible = true
            field.get(node)
          } catch (_: Throwable) {
            null
          }
          if (value is Window.Callback) enqueue(value, depth + 1)
        }
        cls = cls.superclass
      }
    }
    return false
  }

  private fun readWrappedGetter(node: Window.Callback): Window.Callback? {
    var cls: Class<*>? = node.javaClass
    while (cls != null && cls != Any::class.java) {
      try {
        val method = cls.getDeclaredMethod("getWrapped")
        if (method.parameterTypes.isEmpty()) {
          method.isAccessible = true
          val value = method.invoke(node)
          if (value is Window.Callback) return value
        }
      } catch (_: Throwable) {
      }
      cls = cls.superclass
    }
    return null
  }

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

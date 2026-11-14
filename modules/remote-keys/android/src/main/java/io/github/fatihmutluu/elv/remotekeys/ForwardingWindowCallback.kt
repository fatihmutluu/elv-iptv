package io.github.fatihmutluu.elv.remotekeys

import android.os.SystemClock
import android.view.ActionMode
import android.view.KeyEvent
import android.view.KeyboardShortcutGroup
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.SearchEvent
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent

/**
 * Delegates every [Window.Callback] method to [wrapped], including the interface's Java default methods that Kotlin
 * `by` delegation skips. Key events and focus loss are reported to [KeyForwarding]; no key is ever consumed here.
 */
class ForwardingWindowCallback(private val wrapped: Window.Callback) : Window.Callback {
  override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    val action = KeyForwarding.action(event.action, event.repeatCount, event.flags)
    if (action != null) {
      KeyForwarding.emit(
        mapOf(
          "action" to action,
          "keyCode" to event.keyCode,
          "canceled" to (event.flags and KeyEvent.FLAG_CANCELED != 0),
          "ageMs" to maxOf(0L, SystemClock.uptimeMillis() - event.eventTime).toDouble(),
        ),
      )
    }
    return wrapped.dispatchKeyEvent(event)
  }

  override fun onWindowFocusChanged(hasFocus: Boolean) {
    if (!hasFocus) KeyForwarding.emit(mapOf("action" to "blur"))
    wrapped.onWindowFocusChanged(hasFocus)
  }

  override fun dispatchKeyShortcutEvent(event: KeyEvent) = wrapped.dispatchKeyShortcutEvent(event)
  override fun dispatchTouchEvent(event: MotionEvent) = wrapped.dispatchTouchEvent(event)
  override fun dispatchTrackballEvent(event: MotionEvent) = wrapped.dispatchTrackballEvent(event)
  override fun dispatchGenericMotionEvent(event: MotionEvent) = wrapped.dispatchGenericMotionEvent(event)
  override fun dispatchPopulateAccessibilityEvent(event: AccessibilityEvent) =
    wrapped.dispatchPopulateAccessibilityEvent(event)
  override fun onCreatePanelView(featureId: Int): View? = wrapped.onCreatePanelView(featureId)
  override fun onCreatePanelMenu(featureId: Int, menu: Menu) = wrapped.onCreatePanelMenu(featureId, menu)
  override fun onPreparePanel(featureId: Int, view: View?, menu: Menu) = wrapped.onPreparePanel(featureId, view, menu)
  override fun onMenuOpened(featureId: Int, menu: Menu) = wrapped.onMenuOpened(featureId, menu)
  override fun onMenuItemSelected(featureId: Int, item: MenuItem) = wrapped.onMenuItemSelected(featureId, item)
  override fun onWindowAttributesChanged(attrs: WindowManager.LayoutParams?) = wrapped.onWindowAttributesChanged(attrs)
  override fun onContentChanged() = wrapped.onContentChanged()
  override fun onAttachedToWindow() = wrapped.onAttachedToWindow()
  override fun onDetachedFromWindow() = wrapped.onDetachedFromWindow()
  override fun onPanelClosed(featureId: Int, menu: Menu) = wrapped.onPanelClosed(featureId, menu)
  override fun onSearchRequested() = wrapped.onSearchRequested()
  override fun onSearchRequested(searchEvent: SearchEvent?) = wrapped.onSearchRequested(searchEvent)
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?): ActionMode? =
    wrapped.onWindowStartingActionMode(callback)
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? =
    wrapped.onWindowStartingActionMode(callback, type)
  override fun onActionModeStarted(mode: ActionMode?) = wrapped.onActionModeStarted(mode)
  override fun onActionModeFinished(mode: ActionMode?) = wrapped.onActionModeFinished(mode)
  override fun onProvideKeyboardShortcuts(data: MutableList<KeyboardShortcutGroup>?, menu: Menu?, deviceId: Int) =
    wrapped.onProvideKeyboardShortcuts(data, menu, deviceId)
  override fun onPointerCaptureChanged(hasCapture: Boolean) = wrapped.onPointerCaptureChanged(hasCapture)
}

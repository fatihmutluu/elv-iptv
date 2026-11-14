package io.github.fatihmutluu.elv.remotekeys

import android.view.ActionMode
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.SearchEvent
import android.view.View
import android.view.Window
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent

class FakeCallback : Window.Callback {
  override fun dispatchKeyEvent(event: KeyEvent?) = false
  override fun dispatchKeyShortcutEvent(event: KeyEvent?) = false
  override fun dispatchTouchEvent(event: MotionEvent?) = false
  override fun dispatchTrackballEvent(event: MotionEvent?) = false
  override fun dispatchGenericMotionEvent(event: MotionEvent?) = false
  override fun dispatchPopulateAccessibilityEvent(event: AccessibilityEvent?) = false
  override fun onCreatePanelView(featureId: Int): View? = null
  override fun onCreatePanelMenu(featureId: Int, menu: Menu) = false
  override fun onPreparePanel(featureId: Int, view: View?, menu: Menu) = false
  override fun onMenuOpened(featureId: Int, menu: Menu) = false
  override fun onMenuItemSelected(featureId: Int, item: MenuItem) = false
  override fun onWindowAttributesChanged(attrs: WindowManager.LayoutParams?) {}
  override fun onContentChanged() {}
  val focusChanges = mutableListOf<Boolean>()
  override fun onWindowFocusChanged(hasFocus: Boolean) {
    focusChanges.add(hasFocus)
  }
  override fun onAttachedToWindow() {}
  override fun onDetachedFromWindow() {}
  override fun onPanelClosed(featureId: Int, menu: Menu) {}
  override fun onSearchRequested() = false
  override fun onSearchRequested(searchEvent: SearchEvent?) = false
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?): ActionMode? = null
  override fun onWindowStartingActionMode(callback: ActionMode.Callback?, type: Int): ActionMode? = null
  override fun onActionModeStarted(mode: ActionMode?) {}
  override fun onActionModeFinished(mode: ActionMode?) {}
}

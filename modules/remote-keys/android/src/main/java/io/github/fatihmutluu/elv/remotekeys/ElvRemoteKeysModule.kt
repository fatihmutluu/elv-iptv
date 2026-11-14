package io.github.fatihmutluu.elv.remotekeys

import android.app.Activity
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference

/**
 * Forwards first key downs, key ups and window blur of the main window to JavaScript as `onKey`. `uptimeMs()` gives
 * JavaScript the clock of the events' `eventTime`, so it can age each event when it receives it.
 */
class ElvRemoteKeysModule : Module() {
  private var sink: ((Map<String, Any>) -> Unit)? = null

  override fun definition() = ModuleDefinition {
    Name("ElvRemoteKeys")

    Events("onKey")

    Function("uptimeMs") {
      SystemClock.uptimeMillis().toDouble()
    }

    OnStartObserving("onKey") {
      stopSending()
      val weakModule = WeakReference(this@ElvRemoteKeysModule)
      val newSink: (Map<String, Any>) -> Unit = { payload ->
        weakModule.get()?.sendEvent("onKey", payload)
      }
      sink = newSink
      KeyForwarding.setSink(newSink)
      installOnUiThread()
    }

    OnStopObserving("onKey") {
      stopSending()
    }

    OnDestroy {
      stopSending()
    }

    OnActivityEntersForeground {
      installOnUiThread()
    }
  }

  private fun stopSending() {
    sink?.let { KeyForwarding.clearSink(it) }
    sink = null
  }

  /** Window callbacks belong to the UI thread; `OnStartObserving` runs on the JS thread. */
  private fun installOnUiThread() {
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread { install(activity) }
  }

  private fun install(activity: Activity) {
    val window = activity.window ?: return
    val current = window.callback ?: return
    val wrapped = KeyForwarding.wrap(current)
    if (wrapped !== current) window.callback = wrapped
  }
}

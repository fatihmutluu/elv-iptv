package io.github.fatihmutluu.elv.remotekeys

import android.app.Activity
import android.os.SystemClock
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicReference

/**
 * Forwards first key downs, key ups and window blur of the main window to JavaScript as `onKey`. `uptimeMs()` gives
 * JavaScript the clock of the events' `eventTime`, so it can age each event when it receives it.
 */
class ElvRemoteKeysModule : Module() {
  private val sink = AtomicReference<((Map<String, Any>) -> Unit)?>(null)

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
      sink.set(newSink)
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

    OnActivityEntersBackground {
      KeyForwarding.emitBlur()
    }
  }

  private fun stopSending() {
    sink.getAndSet(null)?.let { KeyForwarding.clearSink(it) }
  }

  /** Window callbacks belong to the UI thread; `OnStartObserving` runs on the JS thread. */
  private fun installOnUiThread() {
    val activity = appContext.currentActivity ?: return
    activity.runOnUiThread { install(activity) }
  }

  private fun install(activity: Activity) {
    val window = activity.window ?: return
    val current = window.callback ?: return
    val weakActivity = WeakReference(activity)
    val wrapped = KeyForwarding.wrap(window, current) {
      weakActivity.get()?.let { act ->
        act.window?.decorView?.post { KeyForwarding.installModalWindows(act) }
      }
    }
    if (wrapped !== current) window.callback = wrapped
    KeyForwarding.installModalWindows(activity)
  }
}

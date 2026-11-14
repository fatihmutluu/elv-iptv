package io.github.fatihmutluu.elv.remotekeys

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
      install()
    }

    OnStopObserving("onKey") {
      stopSending()
    }

    OnDestroy {
      stopSending()
    }

    OnActivityEntersForeground {
      install()
    }
  }

  private fun stopSending() {
    sink?.let { KeyForwarding.clearSink(it) }
    sink = null
  }

  private fun install() {
    val window = appContext.currentActivity?.window ?: return
    val current = window.callback ?: return
    val wrapped = KeyForwarding.wrap(current)
    if (wrapped !== current) window.callback = wrapped
  }
}

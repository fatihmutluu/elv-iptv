package io.github.fatihmutluu.elv.remotekeys

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** Forwards first key downs, key ups and window blur of the main window to JavaScript as `onKey`. */
class ElvRemoteKeysModule : Module() {
  @Volatile
  private var observing = false

  override fun definition() = ModuleDefinition {
    Name("ElvRemoteKeys")

    Events("onKey")

    OnStartObserving("onKey") {
      observing = true
      install()
    }

    OnStopObserving("onKey") {
      observing = false
    }

    OnActivityEntersForeground {
      install()
    }
  }

  private fun install() {
    val window = appContext.currentActivity?.window ?: return
    val current = window.callback ?: return
    val wrapped = KeyForwarding.wrap(current) { payload ->
      if (observing) sendEvent("onKey", payload)
    }
    if (wrapped !== current) window.callback = wrapped
  }
}

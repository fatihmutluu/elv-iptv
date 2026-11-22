package io.github.fatihmutluu.elv.media3

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.display.DisplayManager
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Display

/** Mandatory debounce window before emitting TV standby so 1–4 s AFR mode switches never kill live playback (#143). */
internal const val STANDBY_DEBOUNCE_MS = 6_000L

/** True for display states that indicate the TV panel/output is off, dozing, or suspended (#143). */
internal fun isDisplayStandbyState(state: Int): Boolean =
  state == Display.STATE_OFF ||
    state == Display.STATE_DOZE ||
    state == Display.STATE_DOZE_SUSPEND ||
    state == Display.STATE_ON_SUSPEND

/** True for display states that indicate an active display output (#143). */
internal fun isDisplayActiveState(state: Int): Boolean =
  state == Display.STATE_ON || state == Display.STATE_VR

/**
 * Pure debounced state machine for HDMI-CEC / TV standby detection (#143):
 * - Emits `true` only after [debounceMs] of uninterrupted standby, preventing AFR `Display.Mode` switches from
 *   self-killing playback.
 * - Immediately cancels any pending timer when the display or HDMI sink recovers within [debounceMs].
 * - Never emits `true` for a signal source unless an active state on that source was previously observed.
 */
internal class StandbyDebounceController(
  private val debounceMs: Long = STANDBY_DEBOUNCE_MS,
  private val schedule: (delayMs: Long, action: Runnable) -> Unit,
  private val cancel: (action: Runnable) -> Unit,
  private val onStandbyChanged: (Boolean) -> Unit,
) {
  private val lock = Any()
  private var sawDisplayActive = false
  private var displayActive: Boolean? = null
  private var sawHdmiPlugged = false
  private var hdmiPlugged: Boolean? = null
  private var standby = false
  private var stopped = false
  private var pendingTask: Runnable? = null
  private var pendingToken = 0L

  fun onDisplayActive(active: Boolean) {
    if (active) {
      update {
        sawDisplayActive = true
        displayActive = true
      }
    } else {
      update {
        displayActive = false
      }
    }
  }

  fun onHdmiPlugged(plugged: Boolean) {
    if (plugged) {
      update {
        sawHdmiPlugged = true
        hdmiPlugged = true
      }
    } else {
      update {
        hdmiPlugged = false
      }
    }
  }

  fun stop() {
    val toCancel: Runnable?
    synchronized(lock) {
      stopped = true
      toCancel = pendingTask
      pendingTask = null
      pendingToken += 1
    }
    toCancel?.let(cancel)
  }

  private fun isDownLocked(): Boolean =
    (sawDisplayActive && displayActive == false) ||
      (sawHdmiPlugged && hdmiPlugged == false)

  private fun update(mutate: () -> Unit) {
    var taskToSchedule: Runnable? = null
    var taskToCancel: Runnable? = null
    var emitChange: Boolean? = null
    synchronized(lock) {
      if (stopped) return
      mutate()
      if (isDownLocked()) {
        if (!standby && pendingTask == null) {
          val taskToken = ++pendingToken
          val task = Runnable {
            var emitStandby = false
            synchronized(lock) {
              if (stopped || pendingToken != taskToken) return@Runnable
              pendingTask = null
              if (isDownLocked() && !standby) {
                standby = true
                emitStandby = true
              }
            }
            if (emitStandby) onStandbyChanged(true)
          }
          pendingTask = task
          taskToSchedule = task
        }
      } else {
        if (pendingTask != null) {
          taskToCancel = pendingTask
          pendingTask = null
          pendingToken += 1
        }
        if (standby) {
          standby = false
          emitChange = false
        }
      }
    }
    taskToCancel?.let(cancel)
    taskToSchedule?.let { schedule(debounceMs, it) }
    emitChange?.let(onStandbyChanged)
  }
}

/**
 * Android TV HDMI-CEC / display standby monitor (#143): watches [DisplayManager.DisplayListener] and
 * [AudioManager.ACTION_HDMI_AUDIO_PLUG] on TV devices only and reports debounced standby transitions.
 */
internal class StandbyMonitor(
  context: Context,
  private val handler: Handler = Handler(Looper.getMainLooper()),
  private val debounceMs: Long = STANDBY_DEBOUNCE_MS,
  private val onStandbyChanged: (Boolean) -> Unit,
) {
  private val appContext = context.applicationContext ?: context
  private var controller: StandbyDebounceController? = null
  private var displayManager: DisplayManager? = null
  private var receiverRegistered = false
  @Volatile
  private var started = false

  internal val isStartedForTest: Boolean
    get() = started

  private val displayListener = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) = Unit
    override fun onDisplayRemoved(displayId: Int) = Unit
    override fun onDisplayChanged(displayId: Int) {
      if (displayId != Display.DEFAULT_DISPLAY) return
      val state = displayManager?.getDisplay(Display.DEFAULT_DISPLAY)?.state ?: return
      handleDisplayState(state)
    }
  }

  private val hdmiReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent != null) handleHdmiIntent(intent)
    }
  }

  fun start() {
    if (!isTvDevice(appContext)) return
    if (started) return
    started = true
    val nextController = StandbyDebounceController(
      debounceMs = debounceMs,
      schedule = { delay, action -> handler.postDelayed(action, delay) },
      cancel = { action -> handler.removeCallbacks(action) },
      onStandbyChanged = onStandbyChanged,
    )
    controller = nextController

    val dm = runCatching { appContext.getSystemService(DisplayManager::class.java) }.getOrNull()
    displayManager = dm
    if (dm != null) {
      runCatching { dm.registerDisplayListener(displayListener, handler) }
      val initialState = runCatching { dm.getDisplay(Display.DEFAULT_DISPLAY)?.state }.getOrNull()
      if (initialState != null) handleDisplayState(initialState)
    }

    val filter = IntentFilter(AudioManager.ACTION_HDMI_AUDIO_PLUG)
    val stickyResult = runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        appContext.registerReceiver(hdmiReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
      } else {
        @Suppress("DEPRECATION")
        appContext.registerReceiver(hdmiReceiver, filter)
      }
    }
    if (stickyResult.isSuccess) {
      receiverRegistered = true
      stickyResult.getOrNull()?.let(::handleHdmiIntent)
    }
  }

  fun stop() {
    if (!started) return
    started = false
    controller?.stop()
    controller = null
    displayManager?.let { dm ->
      runCatching { dm.unregisterDisplayListener(displayListener) }
    }
    displayManager = null
    if (receiverRegistered) {
      receiverRegistered = false
      runCatching { appContext.unregisterReceiver(hdmiReceiver) }
    }
  }

  internal fun handleHdmiIntentForTest(intent: Intent) = handleHdmiIntent(intent)

  private fun handleDisplayState(state: Int) {
    when {
      isDisplayActiveState(state) -> controller?.onDisplayActive(true)
      isDisplayStandbyState(state) -> controller?.onDisplayActive(false)
    }
  }

  private fun handleHdmiIntent(intent: Intent) {
    if (intent.action != AudioManager.ACTION_HDMI_AUDIO_PLUG) return
    when (intent.getIntExtra(AudioManager.EXTRA_AUDIO_PLUG_STATE, -1)) {
      1 -> controller?.onHdmiPlugged(true)
      0 -> controller?.onHdmiPlugged(false)
    }
  }
}

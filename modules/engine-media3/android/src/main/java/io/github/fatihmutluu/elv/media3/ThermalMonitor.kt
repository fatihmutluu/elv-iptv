package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.os.Build
import android.os.PowerManager
import androidx.annotation.RequiresApi

internal const val THERMAL_STATE_NOMINAL = "nominal"
internal const val THERMAL_STATE_FAIR = "fair"
internal const val THERMAL_STATE_SERIOUS = "serious"
internal const val THERMAL_STATE_CRITICAL = "critical"

/**
 * Maps Android `PowerManager.THERMAL_STATUS_*` integer levels to ELV's cross-platform thermal states (`#232`):
 * - `0` (`THERMAL_STATUS_NONE`) or negative -> `"nominal"`
 * - `1` (`THERMAL_STATUS_LIGHT`), `2` (`THERMAL_STATUS_MODERATE`) -> `"fair"`
 * - `3` (`THERMAL_STATUS_SEVERE`) -> `"serious"`
 * - `>= 4` (`THERMAL_STATUS_CRITICAL` / `EMERGENCY` / `SHUTDOWN`) -> `"critical"`
 */
internal fun mapAndroidThermalStatus(status: Int): String =
  when {
    status <= 0 -> THERMAL_STATE_NOMINAL
    status <= 2 -> THERMAL_STATE_FAIR
    status == 3 -> THERMAL_STATE_SERIOUS
    else -> THERMAL_STATE_CRITICAL
  }

/** Abstraction over Android API 29+ `PowerManager` thermal status APIs for safe API-level gating and unit tests. */
internal interface ThermalBackend {
  fun currentStatus(): Int
  fun registerListener(listener: (Int) -> Unit): () -> Unit
}

@RequiresApi(Build.VERSION_CODES.Q)
private class Api29ThermalBackend(
  private val appContext: Context,
) : ThermalBackend {
  override fun currentStatus(): Int {
    val powerManager = runCatching {
      appContext.getSystemService(PowerManager::class.java)
    }.getOrNull() ?: return 0
    return runCatching { powerManager.currentThermalStatus }.getOrDefault(0)
  }

  override fun registerListener(listener: (Int) -> Unit): () -> Unit {
    val powerManager = runCatching {
      appContext.getSystemService(PowerManager::class.java)
    }.getOrNull() ?: return {}
    val nativeListener = PowerManager.OnThermalStatusChangedListener { status ->
      listener(status)
    }
    val registered = runCatching {
      powerManager.addThermalStatusListener(nativeListener)
      true
    }.getOrDefault(false)
    if (!registered) return {}
    return {
      runCatching {
        powerManager.removeThermalStatusListener(nativeListener)
      }
    }
  }
}

private fun defaultThermalBackend(context: Context, sdkInt: Int): ThermalBackend? =
  if (sdkInt >= Build.VERSION_CODES.Q && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
    Api29ThermalBackend(context.applicationContext ?: context)
  } else {
    null
  }

/** Reads the current normalized Android thermal state, safely returning `"nominal"` below API 29 or on OEM denial. */
internal fun readCurrentThermalState(
  context: Context,
  sdkInt: Int = Build.VERSION.SDK_INT,
): String {
  val backend = defaultThermalBackend(context, sdkInt) ?: return THERMAL_STATE_NOMINAL
  val status = runCatching { backend.currentStatus() }.getOrDefault(0)
  return mapAndroidThermalStatus(status)
}

/**
 * Android `PowerManager` thermal watchdog (`#232`): guarded strictly on API >= 29 (`Build.VERSION_CODES.Q`, since
 * `minSdkVersion` is 28), reads current thermal state, deduplicates mapped level transitions, and catches OEM
 * `SecurityException` / `UnsupportedOperationException` cleanly.
 */
internal class ThermalMonitor(
  context: Context,
  private val sdkInt: Int = Build.VERSION.SDK_INT,
  private val backendFactory: (Context) -> ThermalBackend? = { ctx -> defaultThermalBackend(ctx, sdkInt) },
  private val onThermalChanged: (String) -> Unit,
) {
  private val appContext = context.applicationContext ?: context
  private val lock = Any()
  private var backend: ThermalBackend? = null
  private var unregister: (() -> Unit)? = null
  private var lastEmittedState: String = THERMAL_STATE_NOMINAL

  @Volatile
  private var started = false

  internal val isStartedForTest: Boolean
    get() = started

  fun currentThermalState(): String {
    if (sdkInt < Build.VERSION_CODES.Q) return THERMAL_STATE_NOMINAL
    val active = synchronized(lock) {
      backend ?: backendFactory(appContext).also { backend = it }
    } ?: return THERMAL_STATE_NOMINAL
    val status = runCatching { active.currentStatus() }.getOrDefault(0)
    return mapAndroidThermalStatus(status)
  }

  fun start() {
    if (sdkInt < Build.VERSION_CODES.Q) return
    val activeBackend: ThermalBackend
    synchronized(lock) {
      if (started) return
      activeBackend = backend ?: backendFactory(appContext)?.also { backend = it } ?: return
      started = true
      lastEmittedState = runCatching {
        mapAndroidThermalStatus(activeBackend.currentStatus())
      }.getOrDefault(THERMAL_STATE_NOMINAL)
    }
    val cleanup = runCatching {
      activeBackend.registerListener { status ->
        handleThermalStatus(status)
      }
    }.getOrNull()
    if (cleanup == null) {
      synchronized(lock) { started = false }
      return
    }
    val shouldCleanupImmediately: Boolean
    synchronized(lock) {
      if (started) {
        unregister = cleanup
        shouldCleanupImmediately = false
      } else {
        shouldCleanupImmediately = true
      }
    }
    if (shouldCleanupImmediately) {
      runCatching { cleanup() }
    }
  }

  fun stop() {
    val cleanup: (() -> Unit)?
    synchronized(lock) {
      if (!started) return
      started = false
      cleanup = unregister
      unregister = null
    }
    cleanup?.let { fn -> runCatching { fn() } }
  }

  private fun handleThermalStatus(status: Int) {
    val mapped = mapAndroidThermalStatus(status)
    val shouldEmit = synchronized(lock) {
      if (!started || mapped == lastEmittedState) {
        false
      } else {
        lastEmittedState = mapped
        true
      }
    }
    if (shouldEmit) {
      onThermalChanged(mapped)
    }
  }
}

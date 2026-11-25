package io.github.fatihmutluu.elv.media3

import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class ThermalMonitorTest {
  private class FakeThermalBackend(
    var status: Int = 0,
    var throwOnRead: Throwable? = null,
    var throwOnRegister: Throwable? = null,
  ) : ThermalBackend {
    var registerCount = 0
    var unregisterCount = 0
    var activeListener: ((Int) -> Unit)? = null

    override fun currentStatus(): Int {
      throwOnRead?.let { throw it }
      return status
    }

    override fun registerListener(listener: (Int) -> Unit): () -> Unit {
      throwOnRegister?.let { throw it }
      registerCount += 1
      activeListener = listener
      var unregistered = false
      return {
        if (!unregistered) {
          unregistered = true
          unregisterCount += 1
          if (activeListener === listener) activeListener = null
        }
      }
    }

    fun emit(nextStatus: Int) {
      status = nextStatus
      activeListener?.invoke(nextStatus)
    }
  }

  @Test
  fun `maps Android PowerManager thermal status integers to normalized thermal levels (#232)`() {
    assertEquals(THERMAL_STATE_NOMINAL, mapAndroidThermalStatus(-1))
    assertEquals(THERMAL_STATE_NOMINAL, mapAndroidThermalStatus(0))
    assertEquals(THERMAL_STATE_FAIR, mapAndroidThermalStatus(1))
    assertEquals(THERMAL_STATE_FAIR, mapAndroidThermalStatus(2))
    assertEquals(THERMAL_STATE_SERIOUS, mapAndroidThermalStatus(3))
    assertEquals(THERMAL_STATE_CRITICAL, mapAndroidThermalStatus(4))
    assertEquals(THERMAL_STATE_CRITICAL, mapAndroidThermalStatus(5))
    assertEquals(THERMAL_STATE_CRITICAL, mapAndroidThermalStatus(6))
    assertEquals(THERMAL_STATE_CRITICAL, mapAndroidThermalStatus(99))
  }

  @Test
  fun `stays inactive on API levels below Android 10 Q (#232)`() {
    val app = RuntimeEnvironment.getApplication()
    val backend = FakeThermalBackend(status = 4)
    val emitted = mutableListOf<String>()
    val monitor = ThermalMonitor(
      context = app,
      sdkInt = Build.VERSION_CODES.P,
      backendFactory = { backend },
      onThermalChanged = { emitted += it },
    )

    assertEquals(THERMAL_STATE_NOMINAL, monitor.currentThermalState())
    monitor.start()
    assertFalse("ThermalMonitor must stay inactive below API 29", monitor.isStartedForTest)
    assertEquals(0, backend.registerCount)
    monitor.stop()
    assertTrue(emitted.isEmpty())
  }

  @Test
  fun `registers listener on API 29+, deduplicates mapped levels, and unregisters cleanly (#232)`() {
    val app = RuntimeEnvironment.getApplication()
    val backend = FakeThermalBackend(status = 0)
    val emitted = mutableListOf<String>()
    val monitor = ThermalMonitor(
      context = app,
      sdkInt = Build.VERSION_CODES.Q,
      backendFactory = { backend },
      onThermalChanged = { emitted += it },
    )

    assertEquals(THERMAL_STATE_NOMINAL, monitor.currentThermalState())
    monitor.start()
    monitor.start() // idempotent
    assertTrue(monitor.isStartedForTest)
    assertEquals(1, backend.registerCount)

    // LIGHT (1) -> fair; MODERATE (2) -> still fair (deduplicated)
    backend.emit(1)
    backend.emit(2)
    // SEVERE (3) -> serious; CRITICAL (4) -> critical; EMERGENCY (5) -> still critical (deduplicated)
    backend.emit(3)
    backend.emit(4)
    backend.emit(5)
    // Cooldown back to NONE (0) -> nominal
    backend.emit(0)

    assertEquals(
      listOf(THERMAL_STATE_FAIR, THERMAL_STATE_SERIOUS, THERMAL_STATE_CRITICAL, THERMAL_STATE_NOMINAL),
      emitted,
    )

    val staleListener = backend.activeListener
    monitor.stop()
    monitor.stop() // idempotent
    assertFalse(monitor.isStartedForTest)
    assertEquals(1, backend.unregisterCount)

    // Late callback after stop must be ignored
    staleListener?.invoke(4)
    assertEquals(4, emitted.size)
  }

  @Test
  fun `handles SecurityException and UnsupportedOperationException from PowerManager safely (#232)`() {
    val app = RuntimeEnvironment.getApplication()
    val secBackend = FakeThermalBackend(
      throwOnRead = SecurityException("denied"),
      throwOnRegister = SecurityException("denied"),
    )
    val secMonitor = ThermalMonitor(
      context = app,
      sdkInt = Build.VERSION_CODES.Q,
      backendFactory = { secBackend },
      onThermalChanged = {},
    )
    assertEquals(THERMAL_STATE_NOMINAL, secMonitor.currentThermalState())
    secMonitor.start()
    secMonitor.stop()

    val unsupBackend = FakeThermalBackend(
      throwOnRead = UnsupportedOperationException("unsupported"),
      throwOnRegister = UnsupportedOperationException("unsupported"),
    )
    val unsupMonitor = ThermalMonitor(
      context = app,
      sdkInt = Build.VERSION_CODES.Q,
      backendFactory = { unsupBackend },
      onThermalChanged = {},
    )
    assertEquals(THERMAL_STATE_NOMINAL, unsupMonitor.currentThermalState())
    unsupMonitor.start()
    unsupMonitor.stop()
  }
}

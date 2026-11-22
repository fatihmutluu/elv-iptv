package io.github.fatihmutluu.elv.media3

import android.app.UiModeManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.media.AudioManager
import android.view.Display
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows

@RunWith(RobolectricTestRunner::class)
class StandbyMonitorTest {
  private class FakeTimer {
    data class Entry(val delayMs: Long, val action: Runnable)

    val scheduled = mutableListOf<Entry>()
    val cancelled = mutableListOf<Runnable>()

    fun schedule(delayMs: Long, action: Runnable) {
      scheduled += Entry(delayMs, action)
    }

    fun cancel(action: Runnable) {
      cancelled += action
      scheduled.removeAll { it.action === action }
    }

    fun fireAll() {
      val snapshot = scheduled.toList()
      scheduled.clear()
      snapshot.forEach { it.action.run() }
    }
  }

  @Test
  fun `debounces display standby by 6000 ms and emits wake on return (#143)`() {
    val timer = FakeTimer()
    val emitted = mutableListOf<Boolean>()
    val controller = StandbyDebounceController(
      debounceMs = STANDBY_DEBOUNCE_MS,
      schedule = timer::schedule,
      cancel = timer::cancel,
      onStandbyChanged = { emitted += it },
    )

    controller.onDisplayActive(true)
    controller.onDisplayActive(false)
    assertEquals("must not emit standby immediately before 6 s debounce", emptyList<Boolean>(), emitted)
    assertEquals(1, timer.scheduled.size)
    assertEquals(6_000L, timer.scheduled.single().delayMs)

    timer.fireAll()
    assertEquals(listOf(true), emitted)

    // Repeated standby signals while already in standby do not double-emit
    controller.onDisplayActive(false)
    assertEquals(listOf(true), emitted)
    assertTrue(timer.scheduled.isEmpty())

    // Display recovers -> immediately emits standby = false
    controller.onDisplayActive(true)
    assertEquals(listOf(true, false), emitted)
  }

  @Test
  fun `cancels pending standby timer when AFR display or HDMI sink recovers within 6 s (#143)`() {
    val timer = FakeTimer()
    val emitted = mutableListOf<Boolean>()
    val controller = StandbyDebounceController(
      debounceMs = STANDBY_DEBOUNCE_MS,
      schedule = timer::schedule,
      cancel = timer::cancel,
      onStandbyChanged = { emitted += it },
    )

    controller.onDisplayActive(true)
    controller.onHdmiPlugged(true)

    // Simulated 2 s AFR HDMI blanking
    controller.onHdmiPlugged(false)
    assertEquals(1, timer.scheduled.size)
    val pending = timer.scheduled.single().action

    controller.onHdmiPlugged(true)
    assertEquals("pending timer must be cancelled immediately on recovery", 1, timer.cancelled.size)
    assertTrue(timer.scheduled.isEmpty())
    // Even if a stale runnable executes later, controller ignores it
    pending.run()
    assertEquals("AFR recovery must never emit standby", emptyList<Boolean>(), emitted)
  }

  @Test
  fun `never emits standby if active display or HDMI sink was never previously observed (#143)`() {
    val timer = FakeTimer()
    val emitted = mutableListOf<Boolean>()
    val controller = StandbyDebounceController(
      debounceMs = STANDBY_DEBOUNCE_MS,
      schedule = timer::schedule,
      cancel = timer::cancel,
      onStandbyChanged = { emitted += it },
    )

    controller.onDisplayActive(false)
    controller.onHdmiPlugged(false)
    assertTrue("must not schedule standby without prior active signal", timer.scheduled.isEmpty())
    assertTrue(emitted.isEmpty())

    // Built-in TV speakers: display is ON, HDMI sticky broadcast reports 0 (unplugged) -> no false standby
    controller.onDisplayActive(true)
    controller.onHdmiPlugged(false)
    assertTrue("unplugged HDMI without prior plugged state must not trigger standby", timer.scheduled.isEmpty())
    assertTrue(emitted.isEmpty())
  }

  @Test
  fun `stop cancels pending standby timer and blocks late emissions (#143)`() {
    val timer = FakeTimer()
    val emitted = mutableListOf<Boolean>()
    val controller = StandbyDebounceController(
      debounceMs = STANDBY_DEBOUNCE_MS,
      schedule = timer::schedule,
      cancel = timer::cancel,
      onStandbyChanged = { emitted += it },
    )

    controller.onDisplayActive(true)
    controller.onDisplayActive(false)
    val pending = timer.scheduled.single().action

    controller.stop()
    assertEquals(1, timer.cancelled.size)
    pending.run()
    assertTrue("stopped controller must not emit standby", emitted.isEmpty())
  }

  @Test
  fun `classifies Display states into active, standby, and unknown (#143)`() {
    assertTrue(isDisplayActiveState(Display.STATE_ON))
    assertTrue(isDisplayStandbyState(Display.STATE_OFF))
    assertTrue(isDisplayStandbyState(Display.STATE_DOZE))
    assertTrue(isDisplayStandbyState(Display.STATE_DOZE_SUSPEND))
    assertTrue(isDisplayStandbyState(Display.STATE_ON_SUSPEND))
    assertFalse(isDisplayStandbyState(Display.STATE_ON))
    assertFalse(isDisplayStandbyState(Display.STATE_UNKNOWN))
    assertFalse(isDisplayActiveState(Display.STATE_UNKNOWN))
  }

  @Test
  fun `StandbyMonitor stays inactive on non-TV devices and cleans up on TV (#143)`() {
    val app = RuntimeEnvironment.getApplication()
    val emitted = mutableListOf<Boolean>()

    // Non-TV default Robolectric environment
    val phoneMonitor = StandbyMonitor(app, onStandbyChanged = { emitted += it })
    phoneMonitor.start()
    assertFalse("StandbyMonitor must not activate on phone/tablet", phoneMonitor.isStartedForTest)
    phoneMonitor.stop()

    // Enable Leanback TV feature
    Shadows.shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_LEANBACK, true)

    val tvMonitor = StandbyMonitor(app, debounceMs = 10L, onStandbyChanged = { emitted += it })
    tvMonitor.start()
    assertTrue("StandbyMonitor must activate on Android TV", tvMonitor.isStartedForTest)

    // Deliver HDMI plugged then unplugged broadcast
    tvMonitor.handleHdmiIntentForTest(
      Intent(AudioManager.ACTION_HDMI_AUDIO_PLUG).putExtra(AudioManager.EXTRA_AUDIO_PLUG_STATE, 1),
    )
    tvMonitor.handleHdmiIntentForTest(
      Intent(AudioManager.ACTION_HDMI_AUDIO_PLUG).putExtra(AudioManager.EXTRA_AUDIO_PLUG_STATE, 0),
    )
    tvMonitor.stop()
    assertFalse("stop must mark monitor stopped", tvMonitor.isStartedForTest)
    Shadows.shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(100))
    assertTrue("stopped monitor must cancel pending standby callback", emitted.isEmpty())
  }
}

package io.github.fatihmutluu.elv.remotekeys

import android.view.KeyEvent
import java.lang.ref.WeakReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class KeyForwardingTest {
  @After
  fun clearSink() {
    val probe: (Map<String, Any>) -> Unit = {}
    KeyForwarding.setSink(probe)
    KeyForwarding.clearSink(probe)
  }

  @Test
  fun `first down is forwarded`() {
    assertEquals("down", KeyForwarding.action(KeyEvent.ACTION_DOWN, 0, 0))
  }

  @Test
  fun `repeated down is dropped`() {
    assertNull(KeyForwarding.action(KeyEvent.ACTION_DOWN, 3, 0))
  }

  @Test
  fun `up is forwarded`() {
    assertEquals("up", KeyForwarding.action(KeyEvent.ACTION_UP, 0, 0))
  }

  @Test
  fun `canceled up is still forwarded`() {
    assertEquals("up", KeyForwarding.action(KeyEvent.ACTION_UP, 0, KeyEvent.FLAG_CANCELED))
  }

  @Test
  fun `multiple is dropped`() {
    assertNull(KeyForwarding.action(KeyEvent.ACTION_MULTIPLE, 0, 0))
  }

  @Test
  fun `fallback events are dropped for every action`() {
    assertNull(KeyForwarding.action(KeyEvent.ACTION_DOWN, 0, KeyEvent.FLAG_FALLBACK))
    assertNull(KeyForwarding.action(KeyEvent.ACTION_UP, 0, KeyEvent.FLAG_FALLBACK))
  }

  @Test
  fun `keys injected by a soft keyboard are dropped`() {
    assertNull(KeyForwarding.action(KeyEvent.ACTION_DOWN, 0, KeyEvent.FLAG_SOFT_KEYBOARD))
    assertNull(KeyForwarding.action(KeyEvent.ACTION_UP, 0, KeyEvent.FLAG_SOFT_KEYBOARD))
  }

  @Test
  fun `key payload carries the event time and the canceled flag`() {
    assertEquals(
      mapOf("action" to "down", "keyCode" to 20, "canceled" to false, "eventTime" to 123456.0),
      KeyForwarding.payload("down", 20, 0, 123456L),
    )
    assertEquals(
      mapOf("action" to "up", "keyCode" to 23, "canceled" to true, "eventTime" to 7.0),
      KeyForwarding.payload("up", 23, KeyEvent.FLAG_CANCELED, 7L),
    )
  }

  @Test
  fun `the after hook leaves no sink behind`() {
    val events = mutableListOf<Map<String, Any>>()
    KeyForwarding.setSink { events.add(it) }
    clearSink()
    KeyForwarding.emit(mapOf("action" to "blur"))
    assertEquals(emptyList<Map<String, Any>>(), events)
  }

  @Test
  fun `wrap is idempotent`() {
    val fake = FakeCallback()
    val first = KeyForwarding.wrap(fake)
    assertNotSame(fake, first)
    assertTrue(first is ForwardingWindowCallback)
    assertSame(first, KeyForwarding.wrap(first))
  }

  @Test
  fun `blur reaches the current sink and the replacement after a swap`() {
    val fake = FakeCallback()
    val wrapper = KeyForwarding.wrap(fake)
    val first = mutableListOf<Map<String, Any>>()
    val second = mutableListOf<Map<String, Any>>()
    val firstSink: (Map<String, Any>) -> Unit = { first.add(it) }
    val secondSink: (Map<String, Any>) -> Unit = { second.add(it) }

    KeyForwarding.setSink(firstSink)
    wrapper.onWindowFocusChanged(false)
    KeyForwarding.setSink(secondSink)
    wrapper.onWindowFocusChanged(false)
    KeyForwarding.clearSink(firstSink)
    wrapper.onWindowFocusChanged(false)
    KeyForwarding.clearSink(secondSink)
    wrapper.onWindowFocusChanged(false)

    assertEquals(listOf(mapOf("action" to "blur")), first)
    assertEquals(listOf(mapOf("action" to "blur"), mapOf("action" to "blur")), second)
    assertEquals(listOf(false, false, false, false), fake.focusChanges)
  }

  @Test
  fun `focus gain is delegated without an event and a throwing sink does not stop delegation`() {
    val fake = FakeCallback()
    val wrapper = KeyForwarding.wrap(fake)
    val events = mutableListOf<Map<String, Any>>()
    val sink: (Map<String, Any>) -> Unit = { events.add(it) }
    KeyForwarding.setSink(sink)
    wrapper.onWindowFocusChanged(true)
    assertEquals(emptyList<Map<String, Any>>(), events)

    val failing: (Map<String, Any>) -> Unit = { throw IllegalStateException("destroyed context") }
    KeyForwarding.setSink(failing)
    wrapper.onWindowFocusChanged(false)
    KeyForwarding.clearSink(failing)
    assertEquals(listOf(true, false), fake.focusChanges)
  }

  @Test
  fun `wrapWindow does not double-wrap when a third-party callback wraps our wrapper`() {
    val windowA = Any()
    val baseA = FakeCallback()
    val first = KeyForwarding.wrapWindow(windowA, baseA)
    assertTrue(first is ForwardingWindowCallback)

    // Simulate a third-party library wrapping window.callback after ElvRemoteKeysModule installed.
    val thirdParty = object : android.view.Window.Callback by first {
      override fun onWindowFocusChanged(hasFocus: Boolean) {
        first.onWindowFocusChanged(hasFocus)
      }
    }
    val second = KeyForwarding.wrapWindow(windowA, thirdParty)
    assertSame(thirdParty, second)

    val events = mutableListOf<Map<String, Any>>()
    KeyForwarding.setSink { events.add(it) }
    second.onWindowFocusChanged(false)
    assertEquals(listOf(mapOf("action" to "blur")), events)
    assertEquals(listOf(false), baseA.focusChanges)

    // A distinct window still receives its own wrapper.
    val windowB = Any()
    val baseB = FakeCallback()
    val otherWrapped = KeyForwarding.wrapWindow(windowB, baseB)
    assertNotSame(baseB, otherWrapped)
    assertTrue(otherWrapped is ForwardingWindowCallback)
  }

  @Test
  fun `emitBlur sends blur payload for background transitions and ignores absent sink`() {
    // Safe no-op when no sink is set.
    KeyForwarding.emitBlur()

    val events = mutableListOf<Map<String, Any>>()
    KeyForwarding.setSink { events.add(it) }
    KeyForwarding.emitBlur()
    assertEquals(listOf(mapOf("action" to "blur")), events)
  }

  @Test
  fun `wrapWindow allows garbage collection when callback strongly references windowKey`() {
    val weakWindow = wrapTransientWindow()
    for (attempt in 0 until 50) {
      if (weakWindow.get() == null) break
      System.gc()
      Thread.sleep(10)
    }
    assertNull(weakWindow.get())
  }

  private fun wrapTransientWindow(): WeakReference<Any> {
    val windowKey = Any()
    // Mirrors Android's Activity: implements Window.Callback and holds a strong field reference to its Window.
    val activityCallback = ActivityLikeCallback(windowKey)
    KeyForwarding.wrapWindow(windowKey, activityCallback)
    return WeakReference(windowKey)
  }

  private class ActivityLikeCallback(
    @Suppress("unused")
    val ownedWindow: Any,
  ) : android.view.Window.Callback by FakeCallback()
}

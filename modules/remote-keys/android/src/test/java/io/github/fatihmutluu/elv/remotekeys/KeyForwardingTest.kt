package io.github.fatihmutluu.elv.remotekeys

import android.view.KeyEvent
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
}

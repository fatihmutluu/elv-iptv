package io.github.fatihmutluu.elv.remotekeys

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class KeyForwardingTest {
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
  fun `wrap is idempotent`() {
    val first = KeyForwarding.wrap(FakeCallback()) {}
    val second = KeyForwarding.wrap(first) {}
    assertSame(first, second)
  }
}

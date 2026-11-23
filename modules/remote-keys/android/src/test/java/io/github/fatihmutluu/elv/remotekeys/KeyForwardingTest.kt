package io.github.fatihmutluu.elv.remotekeys

import android.view.KeyEvent
import java.lang.ref.WeakReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
  fun `wrapWindow re-wraps automatically when an SDK or DevSupport replaces window callback`() {
    val windowKey = Any()
    val originalBase = FakeCallback()
    val first = KeyForwarding.wrapWindow(windowKey, originalBase)
    assertTrue(first is ForwardingWindowCallback)

    // Simulate DevSupport or an SDK completely replacing window.callback without delegating to `first`.
    val replacement = FakeCallback()
    val rewrapped = KeyForwarding.wrapWindow(windowKey, replacement)
    assertNotSame(replacement, rewrapped)
    assertNotSame(first, rewrapped)
    assertTrue(rewrapped is ForwardingWindowCallback)

    val events = mutableListOf<Map<String, Any>>()
    KeyForwarding.setSink { events.add(it) }
    rewrapped.onWindowFocusChanged(false)
    assertEquals(listOf(mapOf("action" to "blur")), events)
    assertEquals(listOf(false), replacement.focusChanges)

    // Re-checking the freshly wrapped callback is idempotent.
    assertSame(rewrapped, KeyForwarding.wrapWindow(windowKey, rewrapped))
  }

  @Test
  fun `wrapWindow preserves WindowCallbackWrapper getWrapped chains and survives cyclic third-party delegates`() {
    val windowKey = Any()
    val base = FakeCallback()
    val first = KeyForwarding.wrapWindow(windowKey, base)

    val opaqueWrapper = WrappedGetterCallback(first)
    assertSame(opaqueWrapper, KeyForwarding.wrapWindow(windowKey, opaqueWrapper))

    // Cyclic replacement without `first` terminates safely and re-wraps.
    val cyclicA = CyclicCallback()
    val cyclicB = CyclicCallback()
    cyclicA.delegate = cyclicB
    cyclicB.delegate = cyclicA
    val rewrapped = KeyForwarding.wrapWindow(windowKey, cyclicA)
    assertNotSame(cyclicA, rewrapped)
    assertTrue(rewrapped is ForwardingWindowCallback)
  }

  @Test
  fun `modal and secondary window forwarding works independently and deduplicates modal views`() {
    val mainWindow = Any()
    val modalWindow = Any()
    val mainBase = FakeCallback()
    val modalBase = FakeCallback()
    var focusLossTriggered = 0

    val mainWrapped = KeyForwarding.wrapWindow(mainWindow, mainBase) { focusLossTriggered += 1 }
    val modalWrapped = KeyForwarding.wrapWindow(modalWindow, modalBase)

    val events = mutableListOf<Map<String, Any>>()
    KeyForwarding.setSink { events.add(it) }

    // Main window focus loss triggers the modal scan hook without breaking delegation.
    mainWrapped.onWindowFocusChanged(false)
    assertEquals(1, focusLossTriggered)
    assertEquals(listOf(false), mainBase.focusChanges)

    // Modal window forwards blur and raw key payloads independently.
    modalWrapped.onWindowFocusChanged(false)
    assertEquals(listOf(false), modalBase.focusChanges)
    assertTrue(KeyForwarding.forwardRawKey(KeyEvent.ACTION_DOWN, 0, 0, 23, 42L))
    assertFalse(KeyForwarding.forwardRawKey(KeyEvent.ACTION_DOWN, 2, 0, 23, 43L))
    assertEquals(
      listOf(
        mapOf("action" to "blur"),
        mapOf("action" to "blur"),
        mapOf("action" to "down", "keyCode" to 23, "canceled" to false, "eventTime" to 42.0),
      ),
      events,
    )

    // Modal view attachment is deduplicated per view and independent across distinct views.
    val modalViewA = Any()
    val modalViewB = Any()
    var attaches = 0
    assertTrue(KeyForwarding.installModalView(modalViewA) { attaches += 1 })
    assertFalse(KeyForwarding.installModalView(modalViewA) { attaches += 1 })
    assertTrue(KeyForwarding.installModalView(modalViewB) { attaches += 1 })
    assertEquals(2, attaches)
  }

  @Test
  fun `wrapDialogWindow deduplicates with installModalView so unhandled keys never emit twice`() {
    val dialogWindow = Any()
    val dialogDecorView = Any()
    val dialogBase = FakeCallback()

    val wrapped = KeyForwarding.wrapDialogWindow(dialogWindow, dialogBase, dialogDecorView)
    assertTrue(wrapped is ForwardingWindowCallback)
    assertTrue(KeyForwarding.isModalViewHandled(dialogDecorView))

    var fallbackAttachCount = 0
    var fallbackListener: (() -> Unit)? = null
    val attached = KeyForwarding.installModalViewCandidate(
      viewKey = dialogDecorView,
      tryWrapDialog = { false },
      attachUnhandledListener = {
        fallbackAttachCount += 1
        fallbackListener = { KeyForwarding.forwardRawKey(KeyEvent.ACTION_DOWN, 0, 0, 23, 99L) }
      },
    )
    assertFalse(attached)
    assertEquals(0, fallbackAttachCount)

    // Simulating an unhandled key reaching the dialog: only the window callback path emits.
    val events = mutableListOf<Map<String, Any>>()
    KeyForwarding.setSink { events.add(it) }
    KeyForwarding.forwardRawKey(KeyEvent.ACTION_DOWN, 0, 0, 23, 99L)
    fallbackListener?.invoke()
    assertEquals(
      listOf(mapOf("action" to "down", "keyCode" to 23, "canceled" to false, "eventTime" to 99.0)),
      events,
    )
  }

  @Test
  fun `installModalViewCandidate prefers dialog window wrapping over unhandled listener fallback`() {
    val dialogView = Any()
    var dialogWrapped = 0
    var fallbackAttached = 0

    assertTrue(
      KeyForwarding.installModalViewCandidate(
        viewKey = dialogView,
        tryWrapDialog = {
          dialogWrapped += 1
          true
        },
        attachUnhandledListener = { fallbackAttached += 1 },
      ),
    )
    assertEquals(1, dialogWrapped)
    assertEquals(0, fallbackAttached)
    assertTrue(KeyForwarding.isModalViewHandled(dialogView))

    // Second scan skips already-handled dialog view.
    assertFalse(
      KeyForwarding.installModalViewCandidate(
        viewKey = dialogView,
        tryWrapDialog = {
          dialogWrapped += 1
          true
        },
        attachUnhandledListener = { fallbackAttached += 1 },
      ),
    )
    assertEquals(1, dialogWrapped)
    assertEquals(0, fallbackAttached)

    // When no dialog window is accessible, falls back to unhandled listener once.
    val plainModalView = Any()
    assertTrue(
      KeyForwarding.installModalViewCandidate(
        viewKey = plainModalView,
        tryWrapDialog = { false },
        attachUnhandledListener = { fallbackAttached += 1 },
      ),
    )
    assertFalse(
      KeyForwarding.installModalViewCandidate(
        viewKey = plainModalView,
        tryWrapDialog = { false },
        attachUnhandledListener = { fallbackAttached += 1 },
      ),
    )
    assertEquals(1, fallbackAttached)
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
  fun `forwards TV media, captions, audio track, and programmable color keys on down and up while filtering repeats (#133)`() {
    val tvKeyCodes = listOf(
      KeyEvent.KEYCODE_MEDIA_REWIND to 89,
      KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to 90,
      KeyEvent.KEYCODE_CAPTIONS to 175,
      KeyEvent.KEYCODE_PROG_RED to 183,
      KeyEvent.KEYCODE_PROG_GREEN to 184,
      KeyEvent.KEYCODE_PROG_YELLOW to 185,
      KeyEvent.KEYCODE_PROG_BLUE to 186,
      KeyEvent.KEYCODE_MEDIA_AUDIO_TRACK to 222,
    )

    val events = mutableListOf<Map<String, Any>>()
    KeyForwarding.setSink { events.add(it) }

    for ((index, pair) in tvKeyCodes.withIndex()) {
      val (keyCode, expectedCode) = pair
      assertEquals(expectedCode, keyCode)
      val baseTime = 1_000L + index * 10L
      assertTrue(KeyForwarding.forwardRawKey(KeyEvent.ACTION_DOWN, 0, 0, keyCode, baseTime))
      assertFalse(KeyForwarding.forwardRawKey(KeyEvent.ACTION_DOWN, 1, 0, keyCode, baseTime + 1))
      assertTrue(KeyForwarding.forwardRawKey(KeyEvent.ACTION_UP, 0, 0, keyCode, baseTime + 2))
      assertTrue(KeyForwarding.forwardRawKey(KeyEvent.ACTION_UP, 0, KeyEvent.FLAG_CANCELED, keyCode, baseTime + 3))
    }

    assertEquals(tvKeyCodes.size * 3, events.size)
    for ((index, pair) in tvKeyCodes.withIndex()) {
      val (keyCode, _) = pair
      val baseTime = (1_000L + index * 10L).toDouble()
      val offset = index * 3
      assertEquals(
        mapOf("action" to "down", "keyCode" to keyCode, "canceled" to false, "eventTime" to baseTime),
        events[offset],
      )
      assertEquals(
        mapOf("action" to "up", "keyCode" to keyCode, "canceled" to false, "eventTime" to baseTime + 2.0),
        events[offset + 1],
      )
      assertEquals(
        mapOf("action" to "up", "keyCode" to keyCode, "canceled" to true, "eventTime" to baseTime + 3.0),
        events[offset + 2],
      )
    }
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

  /** Mirrors AndroidX WindowCallbackWrapper exposing getWrapped() over an opaque field type. */
  private class WrappedGetterCallback(
    private val hidden: Any,
  ) : android.view.Window.Callback by FakeCallback() {
    @Suppress("unused")
    fun getWrapped(): android.view.Window.Callback = hidden as android.view.Window.Callback
  }

  private class CyclicCallback : android.view.Window.Callback by FakeCallback() {
    var delegate: android.view.Window.Callback? = null
  }
}

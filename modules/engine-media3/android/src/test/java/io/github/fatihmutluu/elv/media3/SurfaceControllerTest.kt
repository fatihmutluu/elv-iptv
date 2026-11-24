package io.github.fatihmutluu.elv.media3

import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import androidx.annotation.OptIn
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.SubtitleView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.shadows.ShadowLog

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class SurfaceControllerTest {
  @Test
  fun `ignores released Surface on attach, gates stale VideoSize across zaps and warns on multi-sink bind (#84, #279, #331)`() {
    ShadowLog.clear()
    val controller = SurfaceController()
    val events = mutableListOf<String>()

    val tex = SurfaceTexture(0)
    val deadSurface = Surface(tex)
    deadSurface.release()
    tex.release()

    controller.offerSurface(deadSurface)
    assertFalse(controller.attachPendingSurface(deadSurface, player = null) { events += it })
    assertTrue(events.isEmpty())

    // Valid surface attaches ("created"), then invalidates before attachToNewPlayer -> emits "destroyed" once!
    val liveTex = SurfaceTexture(1)
    val liveSurface = Surface(liveTex)
    controller.offerSurface(liveSurface)
    assertTrue(controller.attachPendingSurface(liveSurface, player = null) { events += it })
    assertEquals(listOf("created"), events)
    assertFalse(controller.hasInvalidAttachedSurface())

    liveSurface.release()
    liveTex.release()
    assertTrue(controller.hasInvalidAttachedSurface())
    val dummyPlayer = androidx.media3.exoplayer.ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
    try {
      controller.attachToNewPlayer(dummyPlayer) { events += it }
      assertEquals(listOf("created", "destroyed"), events)
      controller.detachNow(liveSurface, dummyPlayer) { events += it }
      assertEquals("detachNow after attachToNewPlayer drop must not double-emit destroyed", listOf("created", "destroyed"), events)
    } finally {
      dummyPlayer.release()
    }

    // Media 1 decodes 1280x720
    controller.onLoad()
    controller.onVideoSizeChanged(VideoSize(1280, 720, 1f))

    // Media 2 starts (zap): awaitingVideoSize blocks Media 1's size from leaking to a newly bound sink!
    controller.onLoad()
    val reportedSizes = mutableListOf<Pair<Int, Int>>()
    val sink1 = object : ViewSink {
      override fun onShutter(media: Long, framed: Boolean) = Unit
      override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) {
        reportedSizes += width to height
      }
      override fun onScreenOn(on: Boolean) = Unit
    }
    controller.bindView(sink1)
    assertTrue("stale VideoSize from prior media must not leak on bindView mid-zap", reportedSizes.isEmpty())

    controller.onVideoSizeChanged(VideoSize(1920, 1080, 1f))
    assertEquals(listOf(1920 to 1080), reportedSizes)

    // Binding a second sink while sink1 is active logs a warning
    val sink2 = object : ViewSink {
      override fun onShutter(media: Long, framed: Boolean) = Unit
      override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) {
        reportedSizes += width to height
      }
      override fun onScreenOn(on: Boolean) = Unit
    }
    controller.bindView(sink2)
    val warnings = ShadowLog.getLogsForTag("ElvMedia3").map { it.msg }
    assertTrue("$warnings", warnings.any { it.contains("ViewSink") })
  }

  @Test
  fun `Media3SurfaceView orders surfaceView then shutterView then subtitleView and ignores invalid Surface on recycle (#279)`() {
    val context = RuntimeEnvironment.getApplication()
    val appContext = createTestAppContext()
    val engine = Media3Engine(context)
    val events = mutableListOf<Map<String, Any?>>()
    engine.eventObserverForTest = { events += it }
    try {
      val view = Media3SurfaceView(context, appContext)
      assertEquals(4, view.childCount)
      assertTrue("child 0 must be SurfaceView", view.getChildAt(0) is SurfaceView)
      assertTrue("child 1 must be shutter View (below SubtitleView!)", view.getChildAt(1) !is SubtitleView && view.getChildAt(1) is View)
      assertTrue("child 2 must be primary SubtitleView", view.getChildAt(2) is SubtitleView)
      assertTrue("child 3 must be secondary SubtitleView", view.getChildAt(3) is SubtitleView)
      assertFalse("secondary SubtitleView must not be focusable", view.secondarySubtitleView.isFocusable)

      view.bind(engine)
      val tex = SurfaceTexture(0)
      val deadSurface = Surface(tex)
      deadSurface.release()
      tex.release()

      val holder = (view.getChildAt(0) as SurfaceView).holder
      view.onSurfaceCreatedForTest(holder, deadSurface)
      Thread.sleep(50)
      assertTrue("invalid surface must never emit surface created", events.none { it["type"] == "surface" })
      view.bind(null)
    } finally {
      engine.dispose()
    }
  }

  @Test
  fun `attachToNewPlayer drops surface whose UI offer was cleared even while isValid is still true, and caps detach timeout at 250 ms (#424)`() {
    assertEquals(250L, DETACH_TIMEOUT_MS)

    val controller = SurfaceController()
    val events = mutableListOf<String>()
    val tex = SurfaceTexture(2)
    val surface = Surface(tex)
    val realPlayer = androidx.media3.exoplayer.ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
    var boundSurface: Surface? = null
    val trackingPlayer = object : androidx.media3.exoplayer.ExoPlayer by realPlayer {
      override fun setVideoSurface(s: Surface?) {
        boundSurface = s
      }
    }
    try {
      controller.offerSurface(surface)
      assertTrue(controller.attachPendingSurface(surface, player = null) { events += it })
      assertEquals(listOf("created"), events)
      assertTrue(surface.isValid)

      // UI thread enters surfaceDestroyed -> clears offered before playback thread runs detachNow
      controller.clearOfferedIfSame(surface)
      controller.attachToNewPlayer(trackingPlayer) { events += it }

      assertEquals("stale surface must not be bound to rebuilt player", null, boundSurface)
      assertEquals(listOf("created", "destroyed"), events)

      // Later detachNow must not double-emit destroyed
      controller.detachNow(surface, trackingPlayer) { events += it }
      assertEquals(listOf("created", "destroyed"), events)
    } finally {
      realPlayer.release()
      surface.release()
      tex.release()
    }
  }

  @Test
  fun `setSurfaceRecreationToken replaces child 0 SurfaceView, keeps z-order, and ignores retired callbacks (#144)`() {
    val context = RuntimeEnvironment.getApplication()
    val appContext = createTestAppContext()
    val engine = Media3Engine(context)
    val events = java.util.concurrent.CopyOnWriteArrayList<Map<String, Any?>>()
    engine.eventObserverForTest = { events += it }
    val tex1 = SurfaceTexture(10)
    val surface1 = Surface(tex1)
    val tex2 = SurfaceTexture(11)
    val surface2 = Surface(tex2)
    try {
      val view = Media3SurfaceView(context, appContext)
      view.measure(
        View.MeasureSpec.makeMeasureSpec(1280, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(720, View.MeasureSpec.EXACTLY),
      )
      view.layout(0, 0, 1280, 720)
      view.bind(engine)

      val originalSurfaceView = view.getChildAt(0) as SurfaceView
      val shutterView = view.getChildAt(1)
      val subtitleView = view.getChildAt(2) as SubtitleView

      // Initial token 0 must NOT recreate SurfaceView
      view.setSurfaceRecreationToken(0)
      assertSame("initial token 0 must keep original SurfaceView", originalSurfaceView, view.getChildAt(0))

      // Simulate active surface on original SurfaceView
      val oldHolder = originalSurfaceView.holder
      view.onSurfaceCreatedForTest(oldHolder, surface1)
      waitForSurfaceEvents(events, expectedCount = 1)
      assertEquals(listOf("created"), surfaceChanges(events))

      // Incrementing token swaps child 0 to a brand-new SurfaceView while keeping shutter (1) & subtitleView (2)
      view.setSurfaceRecreationToken(1)
      val replacedSurfaceView = view.getChildAt(0) as SurfaceView
      assertNotSame("token change must create a fresh SurfaceView", originalSurfaceView, replacedSurfaceView)
      assertSame("child 1 shutter must stay intact", shutterView, view.getChildAt(1))
      assertSame("child 2 SubtitleView must stay intact", subtitleView, view.getChildAt(2))
      assertFalse("new SurfaceView must not be focusable", replacedSurfaceView.isFocusable)
      assertEquals(1280, replacedSurfaceView.width)
      assertEquals(720, replacedSurfaceView.height)
      assertEquals("old surface must be detached on recreation", listOf("created", "destroyed"), surfaceChanges(events))

      // Repeating same token 1 must be a no-op
      view.setSurfaceRecreationToken(1)
      assertSame("unchanged token must not recreate SurfaceView", replacedSurfaceView, view.getChildAt(0))

      // Attach new surface on replaced SurfaceView
      val newHolder = replacedSurfaceView.holder
      view.onSurfaceCreatedForTest(newHolder, surface2)
      waitForSurfaceEvents(events, expectedCount = 3)
      assertEquals(listOf("created", "destroyed", "created"), surfaceChanges(events))

      // Late callbacks from retired SurfaceView #1 must be strictly ignored
      view.surfaceDestroyed(oldHolder)
      view.onSurfaceCreatedForTest(oldHolder, surface1)
      Thread.sleep(50)
      assertEquals(
        "late retired SurfaceView callbacks must not detach active surface",
        listOf("created", "destroyed", "created"),
        surfaceChanges(events),
      )
      view.bind(null)
    } finally {
      engine.dispose()
      surface1.release()
      tex1.release()
      surface2.release()
      tex2.release()
    }
  }

  @Test
  fun `setUseTextureView switches child 0 to TextureView with clean Surface release and retired-listener guard (#262)`() {
    val context = RuntimeEnvironment.getApplication()
    val appContext = createTestAppContext()
    val engine = Media3Engine(context)
    val events = java.util.concurrent.CopyOnWriteArrayList<Map<String, Any?>>()
    engine.eventObserverForTest = { events += it }
    val st1 = SurfaceTexture(20)
    val st2 = SurfaceTexture(21)
    try {
      val view = Media3SurfaceView(context, appContext)
      view.measure(
        View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY),
        View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
      )
      view.layout(0, 0, 1920, 1080)
      view.bind(engine)

      val shutterView = view.getChildAt(1)
      val subtitleView = view.getChildAt(2) as SubtitleView

      // Default must remain SurfaceView
      assertTrue(view.getChildAt(0) is SurfaceView)

      // Opt into TextureView mode
      view.setUseTextureView(true)
      val tv1 = view.getChildAt(0) as TextureView
      assertFalse("TextureView must not be focusable", tv1.isFocusable)
      assertSame("child 1 shutter must stay intact", shutterView, view.getChildAt(1))
      assertSame("child 2 SubtitleView must stay intact", subtitleView, view.getChildAt(2))
      assertEquals(1920, tv1.width)
      assertEquals(1080, tv1.height)

      val listener1 = tv1.surfaceTextureListener
      assertNotNull("TextureView must have SurfaceTextureListener installed", listener1)
      listener1!!.onSurfaceTextureAvailable(st1, 1920, 1080)
      waitForSurfaceEvents(events, expectedCount = 1)
      assertEquals(listOf("created"), surfaceChanges(events))

      val createdSurface1 = view.activeTextureSurfaceForTest
      assertNotNull(createdSurface1)
      assertTrue(createdSurface1!!.isValid)

      // Recreating via token in TextureView mode creates a fresh TextureView, detaches and releases old Surface
      view.setSurfaceRecreationToken(1)
      val tv2 = view.getChildAt(0) as TextureView
      assertNotSame(tv1, tv2)
      assertFalse("old TextureView Surface must be released on swap", createdSurface1.isValid)
      assertEquals(listOf("created", "destroyed"), surfaceChanges(events))

      val listener2 = tv2.surfaceTextureListener!!
      listener2.onSurfaceTextureAvailable(st2, 1920, 1080)
      waitForSurfaceEvents(events, expectedCount = 3)
      assertEquals(listOf("created", "destroyed", "created"), surfaceChanges(events))
      val createdSurface2 = view.activeTextureSurfaceForTest!!
      assertTrue(createdSurface2.isValid)

      // Late destroy callback from retired TextureView #1 returns true (no SurfaceTexture leak) without detaching tv2
      assertTrue(listener1.onSurfaceTextureDestroyed(st1))
      assertTrue("retired listener must not release active tv2 Surface", createdSurface2.isValid)
      assertEquals(listOf("created", "destroyed", "created"), surfaceChanges(events))

      // Active TextureView destroy detaches, releases Surface, and returns true
      assertTrue(listener2.onSurfaceTextureDestroyed(st2))
      assertFalse("onSurfaceTextureDestroyed must release active TextureView Surface", createdSurface2.isValid)
      assertEquals(listOf("created", "destroyed", "created", "destroyed"), surfaceChanges(events))

      // Toggling back to false restores SurfaceView at child 0
      view.setUseTextureView(false)
      assertTrue("disabling TextureView must restore SurfaceView at child 0", view.getChildAt(0) is SurfaceView)
      assertSame(shutterView, view.getChildAt(1))
      assertSame(subtitleView, view.getChildAt(2))
      view.bind(null)
    } finally {
      engine.dispose()
      st1.release()
      st2.release()
    }
  }

  private fun surfaceChanges(events: List<Map<String, Any?>>): List<Any?> =
    events.filter { it["type"] == "surface" }.map { it["change"] }

  private fun waitForSurfaceEvents(events: List<Map<String, Any?>>, expectedCount: Int) {
    val deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(3)
    while (surfaceChanges(events).size < expectedCount && System.nanoTime() < deadline) {
      Thread.sleep(10)
    }
  }

  private fun createTestAppContext(): expo.modules.kotlin.AppContext {
    val unsafeClass = Class.forName("sun.misc.Unsafe")
    val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    val allocate = unsafeClass.getMethod("allocateInstance", Class::class.java)
    return allocate.invoke(unsafe, expo.modules.kotlin.AppContext::class.java) as expo.modules.kotlin.AppContext
  }
}

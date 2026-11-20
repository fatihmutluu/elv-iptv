package io.github.fatihmutluu.elv.media3

import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import androidx.annotation.OptIn
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.SubtitleView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
      assertEquals(3, view.childCount)
      assertTrue("child 0 must be SurfaceView", view.getChildAt(0) is SurfaceView)
      assertTrue("child 1 must be shutter View (below SubtitleView!)", view.getChildAt(1) !is SubtitleView && view.getChildAt(1) is View)
      assertTrue("child 2 must be SubtitleView (topmost so audio-only subtitles are visible)", view.getChildAt(2) is SubtitleView)

      view.bind(engine)
      val tex = SurfaceTexture(0)
      val deadSurface = Surface(tex)
      deadSurface.release()
      tex.release()

      val fakeHolder = object : SurfaceHolder by (view.getChildAt(0) as SurfaceView).holder {
        override fun getSurface(): Surface = deadSurface
      }
      view.surfaceCreated(fakeHolder)
      Thread.sleep(50)
      assertTrue("invalid surface must never emit surface created", events.none { it["type"] == "surface" })
      view.bind(null)
    } finally {
      engine.dispose()
    }
  }

  private fun createTestAppContext(): expo.modules.kotlin.AppContext {
    val unsafeClass = Class.forName("sun.misc.Unsafe")
    val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    val allocate = unsafeClass.getMethod("allocateInstance", Class::class.java)
    return allocate.invoke(unsafe, expo.modules.kotlin.AppContext::class.java) as expo.modules.kotlin.AppContext
  }
}

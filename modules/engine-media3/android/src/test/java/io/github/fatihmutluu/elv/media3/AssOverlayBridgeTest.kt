package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.view.SurfaceView
import android.view.View
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.extractor.DefaultExtractorsFactory
import androidx.media3.extractor.ExtractorsFactory
import androidx.media3.ui.SubtitleView
import io.github.peerless2012.ass.media.type.AssRenderType
import java.util.concurrent.atomic.AtomicInteger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class AssOverlayBridgeTest {
  private class FakeAssHandle(
    private val failAttach: Boolean = false,
    private val failView: Boolean = false,
  ) : AssOverlayHandle {
    val attachCount = AtomicInteger(0)
    val zapCount = AtomicInteger(0)
    val releaseCount = AtomicInteger(0)
    val viewCreateCount = AtomicInteger(0)

    override fun wrapRenderersFactory(base: RenderersFactory): RenderersFactory = base

    override fun wrapExtractorsFactory(base: ExtractorsFactory): ExtractorsFactory = base

    override fun attachPlayer(player: ExoPlayer): Boolean {
      attachCount.incrementAndGet()
      if (failAttach) throw UnsatisfiedLinkError("simulated native libass failure")
      return true
    }

    override fun createOverlayView(context: Context): View? {
      viewCreateCount.incrementAndGet()
      if (failView) throw RuntimeException("simulated GL init error")
      return View(context)
    }

    override fun clearForZap() {
      zapCount.incrementAndGet()
    }

    override fun release() {
      releaseCount.incrementAndGet()
    }
  }

  @Test
  fun `falls back cleanly without crashing on UnsatisfiedLinkError, NoClassDefFoundError, or GL init failure (#223)`() {
    val context = RuntimeEnvironment.getApplication()
    val baseRenderers = DefaultRenderersFactory(context)
    val baseExtractors = DefaultExtractorsFactory()

    // 1) Real defaultCreateAssOverlayHandle on JVM Robolectric catches UnsatisfiedLinkError cleanly
    val realBridge = AssOverlayBridge()
    realBridge.beginPlayerSession()
    assertSame(baseRenderers, realBridge.wrapRenderersFactory(baseRenderers))
    assertSame(baseExtractors, realBridge.wrapExtractorsFactory(baseExtractors))
    realBridge.clearForZap()
    realBridge.release()
    realBridge.release()

    // 2) Explicit UnsatisfiedLinkError from handleFactory degrades cleanly
    val linkFailBridge = AssOverlayBridge(handleFactory = { throw UnsatisfiedLinkError("libass.so missing") })
    assertNull(linkFailBridge.beginPlayerSession())
    assertFalse(linkFailBridge.isActive)
    assertSame(baseRenderers, linkFailBridge.wrapRenderersFactory(baseRenderers))

    // 3) Explicit NoClassDefFoundError degrades cleanly
    val classFailBridge = AssOverlayBridge(handleFactory = { throw NoClassDefFoundError("AssHandler") })
    assertNull(classFailBridge.beginPlayerSession())
    assertFalse(classFailBridge.isActive)

    // 4) attachPlayer failure tears down and falls back cleanly
    val badAttachHandle = FakeAssHandle(failAttach = true)
    val attachFailBridge = AssOverlayBridge(handleFactory = { badAttachHandle })
    val player = ExoPlayer.Builder(context).build()
    try {
      assertNotNull(attachFailBridge.beginPlayerSession())
      assertFalse(attachFailBridge.attachPlayer(player))
      assertFalse("failed attach must clear activeHandle", attachFailBridge.isActive)
      assertEquals(1, badAttachHandle.releaseCount.get())
    } finally {
      player.release()
    }
  }

  @Test
  fun `lifecycle attach, 50 simulated zaps, and repeated release are strictly idempotent with zero leaked handles (#223)`() {
    val context = RuntimeEnvironment.getApplication()
    val createdHandles = mutableListOf<FakeAssHandle>()
    val bridge = AssOverlayBridge(
      renderType = AssRenderType.OVERLAY_OPEN_GL,
      handleFactory = { type ->
        assertEquals(AssRenderType.OVERLAY_OPEN_GL, type)
        FakeAssHandle().also { createdHandles += it }
      },
    )
    val player = ExoPlayer.Builder(context).build()
    try {
      // Simulate 50 channel zaps + periodic player rebuilds
      repeat(50) { idx ->
        if (idx % 10 == 0) {
          val h = bridge.beginPlayerSession()
          assertNotNull(h)
          assertTrue(bridge.attachPlayer(player))
        }
        bridge.clearForZap()
      }
      assertEquals(5, createdHandles.size)
      // All prior 4 handles were released exactly once when replaced
      for (i in 0 until 4) {
        assertEquals("replaced handle $i must be released once", 1, createdHandles[i].releaseCount.get())
      }
      assertEquals(0, createdHandles.last().releaseCount.get())

      // Repeated release() is strictly idempotent
      repeat(10) { bridge.release() }
      assertNull(bridge.activeHandle)
      assertFalse(bridge.isActive)
      assertEquals(1, createdHandles.last().releaseCount.get())
    } finally {
      player.release()
    }
  }

  @Test
  fun `Media3SurfaceView mounts ASS overlay strictly above video and below shutterView and detaches cleanly (#223)`() {
    val context = RuntimeEnvironment.getApplication()
    val appContext = createTestAppContext()
    val view = Media3SurfaceView(context, appContext)
    view.measure(
      View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
    )
    view.layout(0, 0, 1920, 1080)

    val handle1 = FakeAssHandle()
    view.setAssOverlayHandle(handle1)
    val mounted1 = view.assOverlayViewForTest
    assertNotNull("ASS overlay view must mount when handle is active", mounted1)
    assertFalse("ASS overlay view must never steal TV D-pad focus", mounted1!!.isFocusable)
    assertEquals(5, view.childCount)
    assertTrue(view.getChildAt(0) is SurfaceView)
    assertSame("ASS overlay must sit at index 1 above video and below shutter", mounted1, view.getChildAt(1))
    assertTrue("child 2 must be shutterView above ASS overlay", view.getChildAt(2) !is SubtitleView)
    assertSame(view.subtitleView, view.getChildAt(3))
    assertSame(view.secondarySubtitleView, view.getChildAt(4))
    assertEquals(1920, mounted1.width)
    assertEquals(1080, mounted1.height)

    // Swapping to a new handle removes the old overlay view cleanly (zero leaked views)
    val handle2 = FakeAssHandle()
    view.setAssOverlayHandle(handle2)
    val mounted2 = view.assOverlayViewForTest
    assertNotNull(mounted2)
    assertEquals(5, view.childCount)
    assertSame(mounted2, view.getChildAt(1))
    assertEquals(-1, view.indexOfChild(mounted1))

    // Detaching (null) removes ASS overlay view and restores 4 children
    view.setAssOverlayHandle(null)
    assertNull(view.assOverlayViewForTest)
    assertEquals(4, view.childCount)
    assertEquals(-1, view.indexOfChild(mounted2))

    // Failing GL view creation degrades cleanly without throwing or leaking
    view.setAssOverlayHandle(FakeAssHandle(failView = true))
    assertNull(view.assOverlayViewForTest)
    assertEquals(4, view.childCount)
  }

  private fun createTestAppContext(): expo.modules.kotlin.AppContext {
    val unsafeClass = Class.forName("sun.misc.Unsafe")
    val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    val allocate = unsafeClass.getMethod("allocateInstance", Class::class.java)
    return allocate.invoke(unsafe, expo.modules.kotlin.AppContext::class.java) as expo.modules.kotlin.AppContext
  }
}

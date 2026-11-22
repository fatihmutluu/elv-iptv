package io.github.fatihmutluu.elv.media3

import android.os.Handler
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class Media3EngineDecoderModeTest {
  @Test
  fun `rebuilds ExoPlayer when VideoDecoderMode changes and preserves decoderMode across recreate (#411)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    try {
      val handler = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }.get(engine) as Handler
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val modeField = Media3Engine::class.java.getDeclaredField("playerDecoderMode").apply { isAccessible = true }
      fun snapshot(): Triple<ExoPlayer?, VideoDecoderMode?, VideoDecoderMode?> {
        var out: Triple<ExoPlayer?, VideoDecoderMode?, VideoDecoderMode?> = Triple(null, null, null)
        val latch = CountDownLatch(1)
        handler.post {
          val p = playerField.get(engine) as ExoPlayer?
          val rMode = p?.let { player ->
            (0 until player.rendererCount).map { player.getRenderer(it) }.filterIsInstance<PolicyVideoRenderer>().single().decoderModeForTest
          }
          out = Triple(p, modeField.get(engine) as VideoDecoderMode?, rMode)
          latch.countDown()
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return out
      }

      engine.load(
        1,
        LoadRequest(
          url = "http://127.0.0.1:9/live/1.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
          decoderMode = VideoDecoderMode.AUTO,
        ),
      )
      val (autoPlayer, autoMode, autoRendererMode) = snapshot()
      assertNotNull(autoPlayer)
      assertEquals(VideoDecoderMode.AUTO, autoMode)
      assertEquals(VideoDecoderMode.AUTO, autoRendererMode)

      engine.load(
        2,
        LoadRequest(
          url = "http://127.0.0.1:9/live/1.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
          decoderMode = VideoDecoderMode.SOFTWARE,
        ),
      )
      val (swPlayer, swMode, swRendererMode) = snapshot()
      assertNotSame("AUTO -> SOFTWARE must rebuild ExoPlayer", autoPlayer, swPlayer)
      assertEquals(VideoDecoderMode.SOFTWARE, swMode)
      assertEquals(VideoDecoderMode.SOFTWARE, swRendererMode)

      engine.load(
        3,
        LoadRequest(
          url = "http://127.0.0.1:9/live/1.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
          decoderMode = VideoDecoderMode.HARDWARE,
        ),
      )
      val (hwPlayer, hwMode, hwRendererMode) = snapshot()
      assertNotSame("SOFTWARE -> HARDWARE must rebuild ExoPlayer", swPlayer, hwPlayer)
      assertEquals(VideoDecoderMode.HARDWARE, hwMode)
      assertEquals(VideoDecoderMode.HARDWARE, hwRendererMode)

      engine.recreate(4)
      val (recreatedPlayer, recreatedMode, recreatedRendererMode) = snapshot()
      assertNotSame("recreate must build a fresh ExoPlayer", hwPlayer, recreatedPlayer)
      assertEquals(VideoDecoderMode.HARDWARE, recreatedMode)
      assertEquals(VideoDecoderMode.HARDWARE, recreatedRendererMode)

      engine.load(
        5,
        LoadRequest(
          url = "http://127.0.0.1:9/live/2.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
          decoderMode = VideoDecoderMode.AUTO,
        ),
      )
      val (backToAutoPlayer, backToAutoMode, backToAutoRendererMode) = snapshot()
      assertNotSame("HARDWARE -> AUTO must rebuild ExoPlayer", recreatedPlayer, backToAutoPlayer)
      assertEquals(VideoDecoderMode.AUTO, backToAutoMode)
      assertEquals(VideoDecoderMode.AUTO, backToAutoRendererMode)
    } finally {
      engine.dispose()
    }
  }
}

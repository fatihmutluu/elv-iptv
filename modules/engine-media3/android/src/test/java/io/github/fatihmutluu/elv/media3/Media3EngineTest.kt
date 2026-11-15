package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DefaultRenderersFactory
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class Media3EngineTest {
  @Test
  fun `enables extension renderers as fallback by default and prefers them for softwareAudio (C3)`() {
    assertEquals(
      DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON,
      extensionRendererModeFor(softwareAudio = false),
    )
    assertEquals(
      DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER,
      extensionRendererModeFor(softwareAudio = true),
    )
  }

  @Test
  fun `configures FfmpegLibrary topological shared library order before building renderers (#69)`() {
    assertEquals(
      listOf("avutil", "swresample", "avcodec", "ffmpegJNI"),
      FfmpegAudio.LIBRARIES.toList(),
    )
    FfmpegAudio.ensureConfigured()
    FfmpegAudio.ensureConfigured()
  }

  @Test
  fun `builds MediaCodecAudioRenderer then FfmpegAudioRenderer by default and FfmpegAudioRenderer first when softwareAudio is true (#69)`() {
    val app = RuntimeEnvironment.getApplication()
    assertEquals(
      listOf(
        "androidx.media3.exoplayer.audio.MediaCodecAudioRenderer",
        "androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer",
      ),
      audioRendererClassNamesFor(app, softwareAudio = false),
    )
    assertEquals(
      listOf(
        "androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer",
        "androidx.media3.exoplayer.audio.MediaCodecAudioRenderer",
      ),
      audioRendererClassNamesFor(app, softwareAudio = true),
    )
  }

  @Test
  fun `dispose aborts an open silent socket immediately, clears screenOn and shuts down closer (C2)`() {
    val connected = CountDownLatch(1)
    val socketClosed = CountDownLatch(1)
    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server ->
      val peer = thread(isDaemon = true) {
        server.accept().use { client ->
          client.soTimeout = 10_000
          val input = client.getInputStream()
          val head = StringBuilder()
          while (!head.endsWith("\r\n\r\n")) {
            val b = input.read()
            if (b < 0) break
            head.append(b.toChar())
          }
          client.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\n\r\n".toByteArray())
          client.getOutputStream().flush()
          connected.countDown()
          // Block until client aborts/closes socket
          try {
            while (input.read() >= 0) {
              // wait for EOF / reset
            }
          } catch (_: Exception) {
          } finally {
            socketClosed.countDown()
          }
        }
      }

      val lastScreenOn = AtomicReference<Boolean?>(null)
      val engine = Media3Engine(RuntimeEnvironment.getApplication())
      engine.bindView(object : ViewSink {
        override fun onShutter(media: Long, framed: Boolean) = Unit
        override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) = Unit
        override fun onScreenOn(on: Boolean) {
          lastScreenOn.set(on)
        }
      })
      engine.load(
        1,
        LoadRequest(
          url = "http://127.0.0.1:${server.localPort}/live/demo/demo/1001.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
        ),
      )
      assertTrue("engine did not connect to test server", connected.await(5, TimeUnit.SECONDS))
      engine.cueScreen(ScreenCue.PLAYING, played = true)
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
      while (lastScreenOn.get() != true && System.nanoTime() < deadline) Thread.sleep(10)
      assertEquals(true, lastScreenOn.get())

      engine.dispose()
      assertTrue(
        "dispose must abort the open socket promptly (< 1,500 ms) via beginGeneration()",
        socketClosed.await(1_500, TimeUnit.MILLISECONDS),
      )
      val closeDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
      while (lastScreenOn.get() != false && System.nanoTime() < closeDeadline) Thread.sleep(10)
      assertEquals("dispose must clear keepScreenOn", false, lastScreenOn.get())
      assertFalse("dispose must supersede generation 1", engine.gate.tryOpen(1))
      peer.join(2_000)

      val closerField = Media3Engine::class.java.getDeclaredField("closer").apply { isAccessible = true }
      val closer = closerField.get(engine) as java.util.concurrent.ExecutorService
      val shutdownDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
      while (!closer.isShutdown && System.nanoTime() < shutdownDeadline) Thread.sleep(10)
      assertTrue("dispose must shut down closer executor", closer.isShutdown)
    }
  }

  @Test
  fun `recreate aborts an open silent socket before releasing ExoPlayer (C2)`() {
    val connected = CountDownLatch(1)
    val socketClosed = CountDownLatch(1)
    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server ->
      val peer = thread(isDaemon = true) {
        server.accept().use { client ->
          client.soTimeout = 10_000
          val input = client.getInputStream()
          val head = StringBuilder()
          while (!head.endsWith("\r\n\r\n")) {
            val b = input.read()
            if (b < 0) break
            head.append(b.toChar())
          }
          client.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\n\r\n".toByteArray())
          client.getOutputStream().flush()
          connected.countDown()
          try {
            while (input.read() >= 0) {}
          } catch (_: Exception) {
          } finally {
            socketClosed.countDown()
          }
        }
      }

      val engine = Media3Engine(RuntimeEnvironment.getApplication())
      try {
        engine.load(
          1,
          LoadRequest(
            url = "http://127.0.0.1:${server.localPort}/live/demo/demo/1001.ts",
            headers = emptyMap(),
            live = true,
            startMs = null,
            softwareAudio = false,
          ),
        )
        assertTrue("engine did not connect", connected.await(5, TimeUnit.SECONDS))
        engine.recreate(2)
        assertTrue(
          "recreate must abort the open socket promptly via beginGeneration()",
          socketClosed.await(1_500, TimeUnit.MILLISECONDS),
        )
        val genDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
        while (engine.gate.tryOpen(1).also { if (it) engine.gate.closed(1) } && System.nanoTime() < genDeadline) {
          Thread.sleep(10)
        }
        assertFalse("recreate must supersede generation 1 before releasing ExoPlayer", engine.gate.tryOpen(1))
      } finally {
        engine.dispose()
      }
      peer.join(2_000)
    }
  }
}

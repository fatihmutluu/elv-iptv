package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
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
  fun `configures FfmpegLibrary topological shared library order before building renderers (#69)`() {
    assertEquals(
      listOf("avutil", "swresample", "avcodec", "ffmpegJNI"),
      FfmpegAudio.LIBRARIES.toList(),
    )
    FfmpegAudio.ensureConfigured()
    FfmpegAudio.ensureConfigured()
  }

  @Test
  fun `blocks concurrent ensureConfigured callers until setLibraries finishes (#69)`() {
    FfmpegAudio.resetForTest()
    try {
      val entered = CountDownLatch(1)
      val release = CountDownLatch(1)
      val finishedSetup = AtomicBoolean(false)
      val invocations = AtomicInteger(0)
      val callerSawFinished = AtomicBoolean(false)

      val t1 = thread {
        FfmpegAudio.ensureConfiguredWith {
          invocations.incrementAndGet()
          entered.countDown()
          assertTrue(release.await(5, TimeUnit.SECONDS))
          finishedSetup.set(true)
        }
      }
      assertTrue(entered.await(5, TimeUnit.SECONDS))

      val t2 = thread {
        FfmpegAudio.ensureConfiguredWith {
          invocations.incrementAndGet()
        }
        callerSawFinished.set(finishedSetup.get())
      }

      Thread.sleep(100)
      release.countDown()
      t1.join(5_000)
      t2.join(5_000)

      assertEquals(1, invocations.get())
      assertTrue("concurrent caller returned before setLibraries finished", callerSawFinished.get())
    } finally {
      FfmpegAudio.resetForTest()
      FfmpegAudio.ensureConfigured()
    }
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

  @Test
  fun `rebuilds ExoPlayer on prepare when previous media reached STATE_ENDED while preserving Surface (#127)`() {
    val app = RuntimeEnvironment.getApplication()
    val engine = Media3Engine(app)
    val events = java.util.concurrent.CopyOnWriteArrayList<Map<String, Any?>>()
    engine.eventObserverForTest = { events += it }
    val tex = android.graphics.SurfaceTexture(0)
    val surface = android.view.Surface(tex)
    try {
      engine.attachSurface(surface)
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler

      var initialPlayer: androidx.media3.exoplayer.ExoPlayer? = null
      val step1 = CountDownLatch(1)
      handler.post {
        initialPlayer = playerField.get(engine) as androidx.media3.exoplayer.ExoPlayer?
        // Force a real PlaybackException / STATE_IDLE-with-error or ended wrapper? Even simpler:
        // setMediaItem with an invalid scheme and prepare so playerError becomes non-null, OR swap a wrapper in STATE_ENDED!
        val real = initialPlayer!!
        playerField.set(
          engine,
          object : androidx.media3.exoplayer.ExoPlayer by real {
            override fun getPlaybackState(): Int = androidx.media3.common.Player.STATE_ENDED
          },
        )
        step1.countDown()
      }
      assertTrue(step1.await(5, TimeUnit.SECONDS))

      engine.load(
        2,
        LoadRequest(
          url = "http://127.0.0.1:9/live/demo/demo/1002.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
        ),
      )

      var rebuiltPlayer: androidx.media3.exoplayer.ExoPlayer? = null
      val step2 = CountDownLatch(1)
      handler.post {
        rebuiltPlayer = playerField.get(engine) as androidx.media3.exoplayer.ExoPlayer?
        step2.countDown()
      }
      assertTrue(step2.await(5, TimeUnit.SECONDS))
      org.junit.Assert.assertNotNull(rebuiltPlayer)
      org.junit.Assert.assertNotSame("STATE_ENDED player must be rebuilt on next prepare", initialPlayer, rebuiltPlayer)
      assertEquals(
        "rebuilding player must keep surfaceCreated == 1 without destroying surface",
        listOf("created"),
        events.filter { it["type"] == "surface" }.map { it["change"] },
      )
    } finally {
      engine.dispose()
      surface.release()
      tex.release()
    }
  }

  @Test
  fun `back-to-back loads coalesce via CommandFence without emitting stale events or opening the replaced URL`() {
    val firstHit = AtomicBoolean(false)
    val secondHit = CountDownLatch(1)
    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server1 ->
      ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server2 ->
        server1.soTimeout = 1_500
        val peer1 = thread(isDaemon = true) {
          runCatching {
            server1.accept().use {
              firstHit.set(true)
            }
          }
        }
        val peer2 = thread(isDaemon = true) {
          runCatching {
            server2.accept().use { client ->
              secondHit.countDown()
              client.getOutputStream().write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".toByteArray())
              client.getOutputStream().flush()
            }
          }
        }

        val engine = Media3Engine(RuntimeEnvironment.getApplication())
        val events = java.util.concurrent.CopyOnWriteArrayList<Map<String, Any?>>()
        engine.eventObserverForTest = { events += it }
        try {
          val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
          val handler = handlerField.get(engine) as android.os.Handler
          val hold = CountDownLatch(1)
          val entered = CountDownLatch(1)
          handler.post {
            entered.countDown()
            hold.await(5, TimeUnit.SECONDS)
          }
          assertTrue(entered.await(5, TimeUnit.SECONDS))

          engine.load(
            1,
            LoadRequest(
              url = "http://127.0.0.1:${server1.localPort}/live/demo/demo/1001.ts",
              headers = emptyMap(),
              live = true,
              startMs = null,
              softwareAudio = false,
            ),
          )
          engine.load(
            2,
            LoadRequest(
              url = "http://127.0.0.1:${server2.localPort}/live/demo/demo/1002.ts",
              headers = emptyMap(),
              live = true,
              startMs = null,
              softwareAudio = false,
            ),
          )
          hold.countDown()

          assertTrue("second load must connect to server2", secondHit.await(5, TimeUnit.SECONDS))
          val done = CountDownLatch(1)
          handler.post { done.countDown() }
          assertTrue(done.await(5, TimeUnit.SECONDS))

          assertFalse("superseded first load must not open a socket", firstHit.get())
          assertTrue(
            "no event for replaced attempt 1 may be emitted: $events",
            events.none { it["attempt"] == 1 },
          )
          assertTrue(
            "newer attempt 2 must emit opening",
            events.any { it["attempt"] == 2 && it["type"] == "state" && it["state"] == "opening" },
          )
        } finally {
          engine.dispose()
          server1.close()
          server2.close()
          peer1.join(2_000)
          peer2.join(2_000)
        }
      }
    }
  }
}

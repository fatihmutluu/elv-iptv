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

  @Test
  fun `rebuilds ExoPlayer when switching between Live and VOD while preserving Surface (#422)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    val tex = android.graphics.SurfaceTexture(0)
    val surface = android.view.Surface(tex)
    try {
      engine.attachSurface(surface)
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler

      fun currentPlayer(): androidx.media3.exoplayer.ExoPlayer? {
        var found: androidx.media3.exoplayer.ExoPlayer? = null
        val latch = CountDownLatch(1)
        handler.post {
          found = playerField.get(engine) as androidx.media3.exoplayer.ExoPlayer?
          latch.countDown()
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return found
      }

      engine.load(1, LoadRequest("http://127.0.0.1:9/live/demo/demo/1.ts", emptyMap(), live = true, startMs = null, softwareAudio = false))
      val livePlayer1 = currentPlayer()
      org.junit.Assert.assertNotNull(livePlayer1)

      engine.load(2, LoadRequest("http://127.0.0.1:9/movie/demo/demo/1.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      val vodPlayer = currentPlayer()
      org.junit.Assert.assertNotNull(vodPlayer)
      org.junit.Assert.assertNotSame("switching Live -> VOD must rebuild ExoPlayer with VOD LoadControl", livePlayer1, vodPlayer)

      engine.load(3, LoadRequest("http://127.0.0.1:9/live/demo/demo/2.ts", emptyMap(), live = true, startMs = null, softwareAudio = false))
      val livePlayer2 = currentPlayer()
      org.junit.Assert.assertNotNull(livePlayer2)
      org.junit.Assert.assertNotSame("switching VOD -> Live must rebuild ExoPlayer with Live LoadControl", vodPlayer, livePlayer2)
    } finally {
      engine.dispose()
      surface.release()
      tex.release()
    }
  }

  @Test
  fun `handleAudioFocusDenied and playAsHls advance ConnectionGate generation (#423)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    try {
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val generationField = Media3Engine::class.java.getDeclaredField("generation").apply { isAccessible = true }
      val handleFocusMethod = Media3Engine::class.java.getDeclaredMethod("handleAudioFocusDenied").apply { isAccessible = true }
      val playAsHlsMethod = Media3Engine::class.java.getDeclaredMethod("playAsHls").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler

      engine.load(1, LoadRequest("http://127.0.0.1:9/live/demo/demo/1001.ts", emptyMap(), live = true, startMs = null, softwareAudio = false))

      var genAfterLoad = 0L
      var genAfterFocus = 0L
      var genAfterHls = 0L

      val step1 = CountDownLatch(1)
      handler.post {
        genAfterLoad = generationField.getLong(engine)
        val handled = handleFocusMethod.invoke(engine) as Boolean
        assertTrue(handled)
        genAfterFocus = generationField.getLong(engine)
        step1.countDown()
      }
      assertTrue(step1.await(5, TimeUnit.SECONDS))
      assertTrue("handleAudioFocusDenied must advance generation ($genAfterLoad -> $genAfterFocus)", genAfterFocus > genAfterLoad)
      assertFalse("old generation must be superseded in ConnectionGate", engine.gate.tryOpen(genAfterLoad))

      val step2 = CountDownLatch(1)
      handler.post {
        playAsHlsMethod.invoke(engine)
        handler.post {
          genAfterHls = generationField.getLong(engine)
          step2.countDown()
        }
      }
      assertTrue(step2.await(5, TimeUnit.SECONDS))
      assertTrue("playAsHls must advance generation ($genAfterFocus -> $genAfterHls)", genAfterHls > genAfterFocus)
      assertFalse("pre-HLS generation must be superseded in ConnectionGate", engine.gate.tryOpen(genAfterFocus))
    } finally {
      engine.dispose()
    }
  }

  @Test
  fun `detachSurface short-circuits immediately without blocking after dispose (#424)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    val tex = android.graphics.SurfaceTexture(0)
    val surface = android.view.Surface(tex)
    val hold = CountDownLatch(1)
    try {
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler
      val blocked = CountDownLatch(1)
      handler.post {
        blocked.countDown()
        hold.await(5, TimeUnit.SECONDS)
      }
      assertTrue(blocked.await(5, TimeUnit.SECONDS))

      engine.dispose()
      val startNs = System.nanoTime()
      val detached = engine.detachSurface(surface, timeoutMs = 3_000L)
      val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - startNs)
      assertTrue("disposed engine must return true immediately from detachSurface", detached)
      assertTrue("detachSurface on disposed engine must not wait on blocked looper (took $elapsedMs ms)", elapsedMs < 200L)
    } finally {
      hold.countDown()
      surface.release()
      tex.release()
    }
  }

  @Test
  fun `audio decoder failure escalates once to softwareAudio with new generation and resets on load (#436)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    val events = java.util.concurrent.CopyOnWriteArrayList<Map<String, Any?>>()
    engine.eventObserverForTest = { events += it }
    try {
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val reporterField = Media3Engine::class.java.getDeclaredField("reporter").apply { isAccessible = true }
      val fenceField = Media3Engine::class.java.getDeclaredField("fence").apply { isAccessible = true }
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val swField = Media3Engine::class.java.getDeclaredField("playerSoftwareAudio").apply { isAccessible = true }
      val genField = Media3Engine::class.java.getDeclaredField("generation").apply { isAccessible = true }
      val fallbackField = Media3Engine::class.java.getDeclaredField("audioFallbackAttempted").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler
      val reporter = reporterField.get(engine) as EventReporter
      val fence = fenceField.get(engine) as PrepareFence

      fun waitForFenceOpen() {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
        while (System.nanoTime() < deadline) {
          var open = false
          val check = CountDownLatch(1)
          handler.post {
            val current = playerField.get(engine) as androidx.media3.exoplayer.ExoPlayer?
            open = current != null && fence.acceptsPlayer(current)
            check.countDown()
          }
          assertTrue(check.await(2, TimeUnit.SECONDS))
          if (open) return
          Thread.sleep(10)
        }
        org.junit.Assert.fail("PrepareFence did not open within 5 s")
      }

      engine.load(1, LoadRequest("http://127.0.0.1:9/movie/demo/demo/1.mp4", emptyMap(), live = false, startMs = 45_000L, softwareAudio = false))
      waitForFenceOpen()

      var genBefore = 0L
      var genAfter = 0L
      var swAfterFirst = false
      val step1 = CountDownLatch(1)
      handler.post {
        genBefore = genField.getLong(engine)
        events.clear()
        val err = androidx.media3.common.PlaybackException(
          "audio init failed",
          null,
          androidx.media3.common.PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED,
        )
        reporter.onPlayerError(err)
        genAfter = genField.getLong(engine)
        swAfterFirst = swField.getBoolean(engine)
        step1.countDown()
      }
      assertTrue(step1.await(5, TimeUnit.SECONDS))
      assertTrue("audio failure must escalate playerSoftwareAudio to true", swAfterFirst)
      assertTrue("audio escalation must advance generation", genAfter > genBefore)
      assertTrue("handled first audio failure must not emit error event: $events", events.none { it["type"] == "error" })

      waitForFenceOpen()

      // Second audio failure on same load must NOT re-escalate; emits decoder error
      val step2 = CountDownLatch(1)
      handler.post {
        events.clear()
        val err = androidx.media3.common.PlaybackException(
          "audio write failed",
          null,
          androidx.media3.common.PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED,
        )
        reporter.onPlayerError(err)
        step2.countDown()
      }
      assertTrue(step2.await(5, TimeUnit.SECONDS))
      assertEquals(
        "decoder",
        (events.first { it["type"] == "error" }["error"] as Map<*, *>)["code"],
      )

      // Fresh load resets audioFallbackAttempted
      engine.load(2, LoadRequest("http://127.0.0.1:9/movie/demo/demo/2.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      var resetAfterLoad = true
      val step3 = CountDownLatch(1)
      handler.post {
        resetAfterLoad = fallbackField.getBoolean(engine)
        step3.countDown()
      }
      assertTrue(step3.await(5, TimeUnit.SECONDS))
      assertFalse("fresh load must reset audioFallbackAttempted", resetAfterLoad)
    } finally {
      engine.dispose()
    }
  }

  @Test
  fun `early seek on non-seekable VOD does not poison lastVodPositionMs and closer uses 4 daemon threads (#437)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    try {
      val closerField = Media3Engine::class.java.getDeclaredField("closer").apply { isAccessible = true }
      val closer = closerField.get(engine) as java.util.concurrent.ThreadPoolExecutor
      assertEquals(4, closer.corePoolSize)
      assertEquals(4, closer.maximumPoolSize)
      assertTrue(closer.allowsCoreThreadTimeOut())

      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val lastVodField = Media3Engine::class.java.getDeclaredField("lastVodPositionMs").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler

      engine.load(1, LoadRequest("http://127.0.0.1:9/movie/demo/demo/1.mp4", emptyMap(), live = false, startMs = 12_000L, softwareAudio = false))

      val setup = CountDownLatch(1)
      handler.post {
        val real = playerField.get(engine) as androidx.media3.exoplayer.ExoPlayer
        playerField.set(
          engine,
          object : androidx.media3.exoplayer.ExoPlayer by real {
            override fun isCurrentMediaItemSeekable(): Boolean = false
          },
        )
        setup.countDown()
      }
      assertTrue(setup.await(5, TimeUnit.SECONDS))

      engine.seek(1, 999_000L)
      var storedVodPos: Long? = null
      val verify = CountDownLatch(1)
      handler.post {
        storedVodPos = lastVodField.get(engine) as Long?
        verify.countDown()
      }
      assertTrue(verify.await(5, TimeUnit.SECONDS))
      assertEquals("non-seekable early seek must not poison lastVodPositionMs", 12_000L, storedVodPos)
    } finally {
      engine.dispose()
    }
  }

  @Test
  fun `rebuilds ExoPlayer when StreamKind or BufferPreset changes (#147)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    try {
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler

      fun currentPlayer(): androidx.media3.exoplayer.ExoPlayer? {
        var found: androidx.media3.exoplayer.ExoPlayer? = null
        val latch = CountDownLatch(1)
        handler.post {
          found = playerField.get(engine) as androidx.media3.exoplayer.ExoPlayer?
          latch.countDown()
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return found
      }

      // Raw TS live (AUTO)
      engine.load(
        1,
        LoadRequest(
          url = "http://127.0.0.1:9/live/demo/demo/1.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
          bufferPreset = BufferPreset.AUTO,
        ),
      )
      val rawTsPlayer = currentPlayer()
      org.junit.Assert.assertNotNull(rawTsPlayer)

      // HLS live (AUTO) -> StreamKind changes RAW_TS_LIVE -> HLS_LIVE -> must rebuild
      engine.load(
        2,
        LoadRequest(
          url = "http://127.0.0.1:9/live/demo/demo/1.m3u8",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
          bufferPreset = BufferPreset.AUTO,
        ),
      )
      val hlsLivePlayer = currentPlayer()
      org.junit.Assert.assertNotSame("RAW_TS_LIVE -> HLS_LIVE must rebuild ExoPlayer", rawTsPlayer, hlsLivePlayer)

      // HLS live (LARGE) -> BufferPreset changes AUTO -> LARGE -> must rebuild
      engine.load(
        3,
        LoadRequest(
          url = "http://127.0.0.1:9/live/demo/demo/2.m3u8",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
          bufferPreset = BufferPreset.LARGE,
        ),
      )
      val largePresetPlayer = currentPlayer()
      org.junit.Assert.assertNotSame("BufferPreset change must rebuild ExoPlayer", hlsLivePlayer, largePresetPlayer)
    } finally {
      engine.dispose()
    }
  }

  @Test
  fun `enables isScrubbingModeEnabled only on VOD and resets unconditionally on stop, load, retry, and recreate (#222)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    try {
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler

      fun readScrubbing(): Boolean {
        var value = false
        val latch = CountDownLatch(1)
        handler.post {
          val current = playerField.get(engine) as androidx.media3.exoplayer.ExoPlayer?
          value = current?.isScrubbingModeEnabled == true
          latch.countDown()
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return value
      }

      // Live stream ignores scrubbing mode
      engine.load(1, LoadRequest("http://127.0.0.1:9/live/demo/demo/1.ts", emptyMap(), live = true, startMs = null, softwareAudio = false))
      engine.setScrubbing(1, true)
      assertFalse("live stream must never enable scrubbing mode", readScrubbing())

      // VOD enables scrubbing mode
      engine.load(2, LoadRequest("http://127.0.0.1:9/movie/demo/demo/1.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      engine.setScrubbing(2, true)
      assertTrue("VOD must enable ExoPlayer scrubbing mode", readScrubbing())

      // retry resets scrubbing mode unconditionally
      engine.retry(3)
      assertFalse("retry must reset scrubbing mode to false", readScrubbing())

      // Re-enable then stop resets scrubbing mode unconditionally
      engine.setScrubbing(3, true)
      assertTrue(readScrubbing())
      engine.stop(4)
      assertFalse("stop must reset scrubbing mode to false", readScrubbing())

      // Re-enable on new VOD load then recreate resets scrubbing mode unconditionally
      engine.load(5, LoadRequest("http://127.0.0.1:9/movie/demo/demo/2.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      engine.setScrubbing(5, true)
      assertTrue(readScrubbing())
      engine.recreate(6)
      assertFalse("recreate must reset scrubbing mode to false", readScrubbing())
    } finally {
      engine.dispose()
    }
  }

  @Test
  fun `sanitizes subtitle mojibake cues before forwarding to ViewSink and exposes supportsHardwareHevc4k (#150, #184, #260)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    val receivedCues = java.util.concurrent.CopyOnWriteArrayList<List<androidx.media3.common.text.Cue>>()
    try {
      engine.bindView(object : ViewSink {
        override fun onShutter(media: Long, framed: Boolean) = Unit
        override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) = Unit
        override fun onScreenOn(on: Boolean) = Unit
        override fun onCues(cues: List<androidx.media3.common.text.Cue>) {
          receivedCues += cues
        }
      })

      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val picturesField = Media3Engine::class.java.getDeclaredField("pictures").apply { isAccessible = true }
      val fenceField = Media3Engine::class.java.getDeclaredField("fence").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler
      val pictures = picturesField.get(engine) as androidx.media3.common.Player.Listener
      val fence = fenceField.get(engine) as PrepareFence

      engine.load(1, LoadRequest("http://127.0.0.1:9/movie/demo/demo/1.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      engine.setAudioBoostDb(1, 6.0)

      val step = CountDownLatch(1)
      handler.post {
        fence.begin(99L, reused = false)
        fence.passed(99L)
        val mojibakeCue = androidx.media3.common.text.Cue.Builder().setText("Ã‡Ã¶p").build()
        pictures.onCues(androidx.media3.common.text.CueGroup(listOf(mojibakeCue), 0L))
        step.countDown()
      }
      assertTrue(step.await(5, TimeUnit.SECONDS))

      val nonEmpty = receivedCues.lastOrNull { it.isNotEmpty() }
      org.junit.Assert.assertNotNull("sanitized cue must be delivered to ViewSink", nonEmpty)
      assertEquals("Çöp", nonEmpty!!.single().text.toString())
      assertEquals(engine.codecPolicy.supportsHardwareHevc4k, engine.supportsHardwareHevc4k)
    } finally {
      engine.dispose()
    }
  }
}

package io.github.fatihmutluu.elv.media3

import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.FlagSet
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class VodCacheEngineTest {
  private val mib = 1024L * 1024L
  private val gib = 1024L * mib

  private class ScriptedVodPlayer(private val real: ExoPlayer) : ExoPlayer by real {
    var state = Player.STATE_READY
    var playing = true
    var wantPlay = true
    var scriptedDuration = 300_000L
    var scriptedPosition = 40_000L
    var scriptedBufferedPosition = 115_000L

    override fun getPlaybackState(): Int = state
    override fun isPlaying(): Boolean = playing
    override fun getPlayWhenReady(): Boolean = wantPlay
    override fun getDuration(): Long = scriptedDuration
    override fun getCurrentPosition(): Long = scriptedPosition
    override fun getBufferedPosition(): Long = scriptedBufferedPosition
  }

  private fun eventsFlag(vararg flags: Int): Player.Events =
    Player.Events(FlagSet.Builder().addAll(*flags).build())

  @Test
  fun `PlayerFactory applies VodBufferBudget strictly to VOD and ignores it on Live streams`() {
    val app = RuntimeEnvironment.getApplication()
    val profile = DeviceMemoryProfile(isLowRamDevice = false, totalMemBytes = 8 * gib, lowRam = false)
    val factory = PlayerFactory(app, Looper.getMainLooper(), profile::loadControl, CodecPolicy())
    val vodBudget = computeVodBufferBudget(
      streamKind = StreamKind.VOD,
      preset = BufferPreset.LARGE,
      isLowRamDevice = false,
      totalMemBytes = 8 * gib,
      freeDiskBytes = 20 * gib,
    )

    val vodPlayer = factory.build(
      softwareAudio = false,
      live = false,
      streamKind = StreamKind.VOD,
      bufferPreset = BufferPreset.LARGE,
      vodBudget = vodBudget,
    )
    try {
      val appliedVod = factory.lastLoadControlValuesForTest
      assertNotNull(appliedVod)
      assertEquals(vodBudget.forwardTargetMs, appliedVod!!.maxBufferMs)
      assertEquals(vodBudget.backTargetMs, appliedVod.backBufferMs)
      assertTrue(appliedVod.retainBackBufferFromKeyframe)
    } finally {
      vodPlayer.release()
    }

    val livePlayer = factory.build(
      softwareAudio = false,
      live = true,
      streamKind = StreamKind.HLS_LIVE,
      bufferPreset = BufferPreset.LARGE,
      vodBudget = vodBudget,
    )
    try {
      val appliedLive = factory.lastLoadControlValuesForTest
      assertNotNull(appliedLive)
      assertEquals(0, appliedLive!!.backBufferMs)
      assertFalse(appliedLive.retainBackBufferFromKeyframe)
      assertEquals(60_000, appliedLive.maxBufferMs)
    } finally {
      livePlayer.release()
    }
  }

  @Test
  fun `EventReporter emits VOD bufferHealth with ahead, behind, diskCacheBytes, throttled and omits it on live`() {
    val events = mutableListOf<Map<String, Any?>>()
    val httpErrors = mutableListOf<Pair<Boolean, Int>>()
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val player = ScriptedVodPlayer(real)
      var diskBytes = 12L * mib
      var throttled = false
      val reporter = EventReporter(
        handler = Handler(Looper.getMainLooper()),
        fence = PrepareFence(),
        send = { events += it },
        onHlsDetected = {},
        onBehindLiveWindow = {},
        onAudioFocusDenied = { false },
        onVideoCodecFailed = {},
        onFirstFrame = {},
        onCue = { _, _ -> },
        vodBufferHealthProvider = { diskBytes to throttled },
        onHttpError = { isLive, status -> httpErrors += isLive to status },
      )

      // 1. VOD starts at 0s and advances contiguously to 40s, bufferedPosition 115s, backBuffer 20s -> ahead=75s, behind=20s
      player.scriptedPosition = 0L
      player.scriptedBufferedPosition = 60_000L
      reporter.begin(player, live = false, prepareSerial = 1L, reused = false, vodBackBufferMs = 20_000L)
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      player.scriptedPosition = 40_000L
      player.scriptedBufferedPosition = 115_000L
      events.clear()
      reporter.onPositionDiscontinuity(
        Player.PositionInfo(null, 0, null, null, 0, 0L, 0L, C.INDEX_UNSET, C.INDEX_UNSET),
        Player.PositionInfo(null, 0, null, null, 0, 40_000L, 40_000L, C.INDEX_UNSET, C.INDEX_UNSET),
        Player.DISCONTINUITY_REASON_SEEK,
      )
      val vodAnchor = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      val health = vodAnchor["bufferHealth"] as Map<*, *>
      assertEquals(75_000.0, health["bufferedAheadMs"])
      assertEquals(20_000.0, health["bufferedBehindMs"])
      assertEquals((12L * mib).toDouble(), health["diskCacheBytes"])
      assertFalse(health.containsKey("throttled"))

      // 2. Uncached backward seek outside retained [20s, 115s] window to 5s resets bufferedBehindMs to 0 + throttled
      player.scriptedPosition = 5_000L
      player.scriptedBufferedPosition = 3_000L
      diskBytes = 0L
      throttled = true
      events.clear()
      reporter.onPositionDiscontinuity(
        Player.PositionInfo(null, 0, null, null, 0, 40_000L, 40_000L, C.INDEX_UNSET, C.INDEX_UNSET),
        Player.PositionInfo(null, 0, null, null, 0, 5_000L, 5_000L, C.INDEX_UNSET, C.INDEX_UNSET),
        Player.DISCONTINUITY_REASON_SEEK,
      )
      val seekAnchor = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      val seekHealth = seekAnchor["bufferHealth"] as Map<*, *>
      assertEquals(0.0, seekHealth["bufferedAheadMs"])
      assertEquals(0.0, seekHealth["bufferedBehindMs"])
      assertFalse(seekHealth.containsKey("diskCacheBytes"))
      assertEquals(true, seekHealth["throttled"])

      // 3. HTTP 429 error notifies onHttpError(live = false, status = 429)
      val err429 = HttpDataSource.InvalidResponseCodeException(
        429,
        "Too Many Requests",
        null,
        emptyMap(),
        DataSpec(android.net.Uri.parse("http://127.0.0.1:9/movie/1.mp4")),
        ByteArray(0),
      )
      reporter.onPlayerError(PlaybackException("rate limited", err429, PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS))
      assertEquals(listOf(false to 429), httpErrors)

      // 4. Live stream MUST omit VOD bufferHealth completely
      reporter.begin(player, live = true, prepareSerial = 2L, reused = false, vodBackBufferMs = 20_000L)
      events.clear()
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      val liveAnchor = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertFalse("live clock anchor must omit VOD bufferHealth", liveAnchor.containsKey("bufferHealth"))
      reporter.end()
    } finally {
      real.release()
    }
  }

  @Test
  fun `Media3Engine purges VOD orphans on init, opens disk cache for VOD only, tears down on stop and recreate, and tracks 429 backoff per URL`() {
    val app = RuntimeEnvironment.getApplication()
    VodEphemeralCache.resetStartupPurgeForTest()
    val vodRoot = File(app.cacheDir, VOD_CACHE_SUBDIR).apply { mkdirs() }
    val staleOrphan = File(vodRoot, "s-stale-before-init").apply { mkdirs() }
    assertTrue(staleOrphan.exists())

    val engine = Media3Engine(app)
    try {
      assertFalse("Media3Engine init must purge stale VOD cache orphans", staleOrphan.exists())

      val handler = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }.get(engine) as Handler
      val vodCacheField = Media3Engine::class.java.getDeclaredField("vodCache").apply { isAccessible = true }
      val reporterField = Media3Engine::class.java.getDeclaredField("reporter").apply { isAccessible = true }
      val fenceField = Media3Engine::class.java.getDeclaredField("fence").apply { isAccessible = true }
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val vodController = vodCacheField.get(engine) as VodCacheController
      val reporter = reporterField.get(engine) as EventReporter
      val fence = fenceField.get(engine) as PrepareFence

      fun flush(): VodEphemeralCache? {
        var session: VodEphemeralCache? = null
        val latch = CountDownLatch(1)
        handler.post {
          session = vodController.activeSessionForTest
          latch.countDown()
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return session
      }

      // 1. Live stream NEVER opens a VOD ephemeral cache
      engine.load(1, LoadRequest("http://127.0.0.1:9/live/demo/demo/1.ts", emptyMap(), live = true, startMs = null, softwareAudio = false))
      assertNull("live load must never open VOD cache", flush())

      // 2. VOD load opens an ephemeral cache session (assuming host disk has >= 512 MiB free)
      val freeSpace = VodEphemeralCache.usableSpaceBytes(app.cacheDir)
      engine.load(2, LoadRequest("http://127.0.0.1:9/movie/demo/demo/1.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      val vodSession1 = flush()
      if (freeSpace >= VOD_MIN_FREE_DISK_BYTES) {
        assertNotNull("VOD load on host with >= 512 MiB free must open ephemeral cache", vodSession1)
      }

      // 3. HTTP 429 during VOD increments throttle backoff; switching URL resets it to 0
      val throttleStep = CountDownLatch(1)
      var backoffAfter429 = -1
      var fenceAccepted = false
      handler.post {
        val current = playerField.get(engine) as ExoPlayer
        val activeSerial = current.currentMediaItem?.mediaId?.toLongOrNull() ?: 2L
        fence.passed(activeSerial)
        fenceAccepted = fence.acceptsPlayer(current)
        if (fenceAccepted) {
          val err429 = HttpDataSource.InvalidResponseCodeException(
            429,
            "Too Many Requests",
            null,
            emptyMap(),
            DataSpec(android.net.Uri.parse("http://127.0.0.1:9/movie/demo/demo/1.mp4")),
            ByteArray(0),
          )
          reporter.onPlayerError(PlaybackException("throttled", err429, PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS))
        }
        backoffAfter429 = vodController.throttleBackoffLevelForTest
        throttleStep.countDown()
      }
      assertTrue(throttleStep.await(5, TimeUnit.SECONDS))
      assertTrue("PrepareFence must accept active VOD player for serial", fenceAccepted)
      assertEquals(1, backoffAfter429)

      // 4. recreate tears down active VOD cache session
      engine.recreate(3)
      assertNull("recreate must tear down active VOD cache session", flush())

      // 5. Loading a DIFFERENT VOD URL resets throttle backoff to 0
      engine.load(4, LoadRequest("http://127.0.0.1:9/movie/demo/demo/2.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      flush()
      var backoffAfterNewUrl = -1
      val checkReset = CountDownLatch(1)
      handler.post {
        backoffAfterNewUrl = vodController.throttleBackoffLevelForTest
        checkReset.countDown()
      }
      assertTrue(checkReset.await(5, TimeUnit.SECONDS))
      assertEquals("new VOD URL must reset throttle backoff to 0", 0, backoffAfterNewUrl)

      // 6. stop tears down active VOD cache session cleanly
      engine.stop(5)
      assertNull("stop must tear down active VOD cache session", flush())
    } finally {
      engine.dispose()
    }
  }

  @Test
  fun `Media3Engine stops, clears, or releases ExoPlayer BEFORE tearing down VOD cache on stop, recreate, load, and dispose`() {
    val app = RuntimeEnvironment.getApplication()
    val freeSpace = VodEphemeralCache.usableSpaceBytes(app.cacheDir)
    if (freeSpace < VOD_MIN_FREE_DISK_BYTES) return

    val engine = Media3Engine(app)
    val handler = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }.get(engine) as Handler
    val vodController = Media3Engine::class.java.getDeclaredField("vodCache").apply { isAccessible = true }.get(engine) as VodCacheController
    val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }

    fun flush(): VodEphemeralCache? {
      var session: VodEphemeralCache? = null
      val latch = CountDownLatch(1)
      handler.post {
        session = vodController.activeSessionForTest
        latch.countDown()
      }
      assertTrue(latch.await(5, TimeUnit.SECONDS))
      return session
    }

    fun wrapActivePlayer(onStop: () -> Unit = {}, onClear: () -> Unit = {}, onRelease: () -> Unit = {}) {
      val latch = CountDownLatch(1)
      handler.post {
        val real = playerField.get(engine) as ExoPlayer
        playerField.set(
          engine,
          object : ExoPlayer by real {
            override fun stop() {
              onStop()
              real.stop()
            }

            override fun clearMediaItems() {
              onClear()
              real.clearMediaItems()
            }

            override fun release() {
              onRelease()
              real.release()
            }
          },
        )
        latch.countDown()
      }
      assertTrue(latch.await(5, TimeUnit.SECONDS))
    }

    var disposed = false
    try {
      // 1. stop(): player.stop() and player.clearMediaItems() must execute while VOD cache session is STILL active
      engine.load(1, LoadRequest("http://127.0.0.1:9/movie/demo/demo/order-1.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      assertNotNull(flush())
      var stopSawActiveSession = false
      var clearSawActiveSession = false
      wrapActivePlayer(
        onStop = { stopSawActiveSession = vodController.activeSessionForTest != null },
        onClear = { clearSawActiveSession = vodController.activeSessionForTest != null },
      )
      engine.stop(2)
      assertNull("stop must tear down VOD cache after stopping player", flush())
      assertTrue("player.stop() must run BEFORE vodCache.tearDown()", stopSawActiveSession)
      assertTrue("player.clearMediaItems() must run BEFORE vodCache.tearDown()", clearSawActiveSession)

      // 2. recreate(): old player.release() must execute while VOD cache session is STILL active
      engine.load(3, LoadRequest("http://127.0.0.1:9/movie/demo/demo/order-2.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      assertNotNull(flush())
      var releaseSawActiveSession = false
      wrapActivePlayer(onRelease = { releaseSawActiveSession = vodController.activeSessionForTest != null })
      engine.recreate(4)
      assertNull("recreate must tear down VOD cache after replacing player", flush())
      assertTrue("old player.release() must run BEFORE vodCache.tearDown() in recreate()", releaseSawActiveSession)

      // 3. load() with disallowed URL: player.stop() & clearMediaItems() must run BEFORE vodCache.tearDown()
      engine.load(5, LoadRequest("http://127.0.0.1:9/movie/demo/demo/order-3.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      assertNotNull(flush())
      var rejectStopSawActive = false
      var rejectClearSawActive = false
      wrapActivePlayer(
        onStop = { rejectStopSawActive = vodController.activeSessionForTest != null },
        onClear = { rejectClearSawActive = vodController.activeSessionForTest != null },
      )
      engine.load(6, LoadRequest("file:///etc/passwd", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      assertNull("disallowed URL load must tear down VOD cache after stopping player", flush())
      assertTrue("rejectDisallowedUrl must stop player BEFORE vodCache.tearDown()", rejectStopSawActive)
      assertTrue("rejectDisallowedUrl must clearMediaItems BEFORE vodCache.tearDown()", rejectClearSawActive)

      // 4. load() VOD -> VOD reuse: existing.stop() must run BEFORE old VOD session is torn down
      engine.load(7, LoadRequest("http://127.0.0.1:9/movie/demo/demo/order-4.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      val prevSession = flush()
      assertNotNull(prevSession)
      var prepareStopSawPrevSession = false
      wrapActivePlayer(onStop = { prepareStopSawPrevSession = vodController.activeSessionForTest === prevSession })
      engine.load(8, LoadRequest("http://127.0.0.1:9/movie/demo/demo/order-5.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      val nextSession = flush()
      assertNotNull(nextSession)
      assertTrue("prepare() reuse must stop player BEFORE tearing down previous VOD cache", prepareStopSawPrevSession)

      // 5. dispose(): releasePlayer() must execute while VOD cache session is STILL active
      var disposeReleaseSawActive = false
      val disposeDone = CountDownLatch(1)
      wrapActivePlayer(
        onRelease = {
          disposeReleaseSawActive = vodController.activeSessionForTest != null
          disposeDone.countDown()
        },
      )
      engine.dispose()
      disposed = true
      assertTrue(disposeDone.await(5, TimeUnit.SECONDS))
      assertTrue("dispose() must releasePlayer() BEFORE vodCache.tearDown()", disposeReleaseSawActive)
    } finally {
      if (!disposed) engine.dispose()
    }
  }
}

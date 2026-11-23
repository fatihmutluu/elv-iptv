package io.github.fatihmutluu.elv.media3

import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class MediaSessionControllerTest {
  @Before
  fun setUp() {
    ElvPlaybackSessionService.resetForTest()
  }

  @After
  fun tearDown() {
    ElvPlaybackSessionService.resetForTest()
  }

  @Test
  fun `parseMediaMetadataArgs and buildSessionMediaMetadata sanitize artwork and populate fields (#412)`() {
    assertNull(parseMediaMetadataArgs(null))
    assertNull(parseMediaMetadataArgs(mapOf("title" to "   ")))

    val payload = parseMediaMetadataArgs(
      mapOf(
        "title" to "Channel One",
        "subtitle" to "Evening News",
        "artworkUrl" to "https://u:p@cdn.example.com/ch1.png?token=secret&size=256",
        "kind" to "live",
        "canStepTrack" to true,
      ),
    )
    assertNotNull(payload)
    assertEquals("Channel One", payload!!.title)
    assertEquals("Evening News", payload.subtitle)
    assertTrue(payload.isLive)
    assertTrue(payload.canStepTrack)

    val metadata = buildSessionMediaMetadata(payload)
    assertEquals("Channel One", metadata.title?.toString())
    assertEquals("Evening News", metadata.subtitle?.toString())
    assertEquals("Evening News", metadata.artist?.toString())
    assertEquals("https://cdn.example.com/ch1.png?size=256", metadata.artworkUri?.toString())

    assertEquals(MediaMetadata.EMPTY, buildSessionMediaMetadata(null))
  }

  @Test
  fun `MediaSessionController manages session lifecycle on playback looper, swaps rebuilt players, and routes remote actions (#412, #132)`() {
    val context = RuntimeEnvironment.getApplication()
    val thread = HandlerThread("ElvMedia3SessionTest").apply { start() }
    val handler = Handler(thread.looper)
    val startCount = AtomicInteger(0)
    val stopCount = AtomicInteger(0)
    val remoteActions = CopyOnWriteArrayList<String>()
    val taskRemovedStops = AtomicInteger(0)
    val remoteStops = AtomicInteger(0)

    val bridge = object : PlaybackServiceBridge {
      override fun start(context: Context) {
        startCount.incrementAndGet()
      }

      override fun stop(context: Context) {
        stopCount.incrementAndGet()
      }
    }

    val controller = MediaSessionController(
      context = context,
      onRemoteMediaAction = { remoteActions += it },
      onTaskRemovedStop = { taskRemovedStops.incrementAndGet() },
      onRemoteStop = { remoteStops.incrementAndGet() },
      serviceBridge = bridge,
    )

    var player1: ExoPlayer? = null
    var player2: ExoPlayer? = null
    try {
      fun onLooper(block: () -> Unit) {
        val latch = CountDownLatch(1)
        var error: Throwable? = null
        handler.post {
          try {
            block()
          } catch (t: Throwable) {
            error = t
          } finally {
            latch.countDown()
          }
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        error?.let { throw it }
      }

      onLooper {
        player1 = ExoPlayer.Builder(context).setLooper(thread.looper).build()
        controller.onPlayerChanged(player1!!)
        // Session is not created before playback becomes active
        assertNull(controller.activeSessionForTest)
        assertEquals(0, startCount.get())

        controller.setMediaMetadata(
          MediaSessionMetadataPayload(
            title = "Live Sports",
            subtitle = "Finals",
            artworkUrl = "https://cdn.example.com/sports.png?pass=123",
            isLive = true,
            canStepTrack = true,
          ),
        )
        controller.onPlaybackActive()

        val session = controller.activeSessionForTest
        assertNotNull(session)
        assertSame(session, ElvPlaybackSessionService.activeSession())
        assertEquals(1, startCount.get())

        val fp = controller.activeForwardingPlayerForTest!!
        assertEquals("Live Sports", fp.mediaMetadata.title?.toString())
        assertEquals("Finals", fp.mediaMetadata.artist?.toString())
        assertEquals("https://cdn.example.com/sports.png", fp.mediaMetadata.artworkUri?.toString())
        assertTrue(fp.availableCommands.contains(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM))
        assertTrue(fp.availableCommands.contains(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM))
        assertTrue(fp.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT))
        assertTrue(fp.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS))
        assertTrue(fp.hasNextMediaItem())
        assertTrue(fp.hasPreviousMediaItem())

        fp.seekToNext()
        fp.seekToNextMediaItem()
        fp.seekToPrevious()
        fp.seekToPreviousMediaItem()
        fp.stop()
        assertEquals(listOf("next", "next", "previous", "previous"), remoteActions.toList())
        assertEquals(1, remoteStops.get())

        // Seamless player rebuild keeps the same MediaSession without restarting service
        player2 = ExoPlayer.Builder(context).setLooper(thread.looper).build()
        controller.onPlayerChanged(player2!!)
        assertSame(session, controller.activeSessionForTest)
        assertSame(controller.activeForwardingPlayerForTest, session!!.player)
        assertEquals(1, startCount.get())
        assertEquals(0, stopCount.get())

        // Stop stops service, unregisters and releases session immediately, while preserving metadata for resume
        controller.onPlaybackStopped()
        assertNull(controller.activeSessionForTest)
        assertNull(ElvPlaybackSessionService.activeSession())
        assertEquals(1, stopCount.get())
        assertEquals("Live Sports", controller.activeForwardingPlayerForTest?.mediaMetadata?.title?.toString())
        assertTrue(controller.activeForwardingPlayerForTest?.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT) == true)

        // Resuming playback recreates MediaSession with preserved metadata and canStepTrack
        controller.onPlaybackActive()
        val resumedSession = controller.activeSessionForTest
        assertNotNull(resumedSession)
        assertEquals(2, startCount.get())
        val resumedFp = controller.activeForwardingPlayerForTest!!
        assertEquals("Live Sports", resumedFp.mediaMetadata.title?.toString())
        assertEquals("Finals", resumedFp.mediaMetadata.artist?.toString())
        assertEquals("https://cdn.example.com/sports.png", resumedFp.mediaMetadata.artworkUri?.toString())
        assertTrue(resumedFp.isCommandAvailable(Player.COMMAND_SEEK_TO_NEXT))
        assertTrue(resumedFp.isCommandAvailable(Player.COMMAND_SEEK_TO_PREVIOUS))

        // Explicit setMediaMetadata(null) wipes metadata and disables track stepping
        controller.setMediaMetadata(null)
        assertEquals(MediaMetadata.EMPTY, resumedFp.mediaMetadata)
        assertFalse(resumedFp.hasNextMediaItem())
        assertFalse(resumedFp.hasPreviousMediaItem())
      }
    } finally {
      val cleanup = CountDownLatch(1)
      handler.post {
        controller.dispose()
        player2?.release()
        player1?.release()
        thread.quitSafely()
        cleanup.countDown()
      }
      assertTrue(cleanup.await(5, TimeUnit.SECONDS))
    }
  }

  @Test
  fun `ElvPlaybackSessionService attaches active session on onStartCommand, removes on stop, and stops itself when idle (#412)`() {
    val context = RuntimeEnvironment.getApplication()
    val thread = HandlerThread("ElvServiceSessionTest").apply { start() }
    val handler = Handler(thread.looper)
    val startCount = AtomicInteger(0)
    val stopCount = AtomicInteger(0)

    val bridge = object : PlaybackServiceBridge {
      override fun start(context: Context) {
        startCount.incrementAndGet()
      }

      override fun stop(context: Context) {
        stopCount.incrementAndGet()
      }
    }

    val controller = MediaSessionController(
      context = context,
      onRemoteMediaAction = {},
      onTaskRemovedStop = {},
      onRemoteStop = {},
      serviceBridge = bridge,
    )

    var player: ExoPlayer? = null
    try {
      fun onLooper(block: () -> Unit) {
        val latch = CountDownLatch(1)
        var error: Throwable? = null
        handler.post {
          try {
            block()
          } catch (t: Throwable) {
            error = t
          } finally {
            latch.countDown()
          }
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        error?.let { throw it }
      }

      // Idle service with no active session stops itself cleanly and returns START_NOT_STICKY
      val idleController = Robolectric.buildService(ElvPlaybackSessionService::class.java).create()
      val idleService = idleController.get()
      val idleResult = idleService.onStartCommand(Intent(context, ElvPlaybackSessionService::class.java), 0, 1)
      assertEquals(Service.START_NOT_STICKY, idleResult)
      assertTrue(Shadows.shadowOf(idleService).isStoppedBySelf)
      assertTrue(idleService.sessions.isEmpty())
      idleController.destroy()

      // Active session registered before service starts -> attached on onCreate/onStartCommand
      var activeSession: androidx.media3.session.MediaSession? = null
      onLooper {
        player = ExoPlayer.Builder(context).setLooper(thread.looper).build()
        controller.onPlayerChanged(player!!)
        controller.onPlaybackActive()
        activeSession = controller.activeSessionForTest
      }
      assertNotNull(activeSession)

      val liveController = Robolectric.buildService(ElvPlaybackSessionService::class.java).create()
      val liveService = liveController.get()
      liveService.onStartCommand(Intent(context, ElvPlaybackSessionService::class.java), 0, 2)
      Shadows.shadowOf(Looper.getMainLooper()).idle()
      assertTrue(liveService.sessions.contains(activeSession))
      assertFalse(Shadows.shadowOf(liveService).isStoppedBySelf)

      // Stopping playback removes the session from ElvPlaybackSessionService before release
      onLooper {
        controller.onPlaybackStopped()
      }
      Shadows.shadowOf(Looper.getMainLooper()).idle()
      assertFalse(liveService.sessions.contains(activeSession))
      assertTrue(liveService.sessions.isEmpty())

      // Re-activating playback while service is already live attaches the new session via main looper
      var resumedSession: androidx.media3.session.MediaSession? = null
      onLooper {
        controller.onPlaybackActive()
        resumedSession = controller.activeSessionForTest
      }
      Shadows.shadowOf(Looper.getMainLooper()).idle()
      assertNotNull(resumedSession)
      assertTrue(liveService.sessions.contains(resumedSession))

      onLooper {
        controller.onPlaybackStopped()
      }
      Shadows.shadowOf(Looper.getMainLooper()).idle()
      assertTrue(liveService.sessions.isEmpty())
      liveController.destroy()
    } finally {
      val cleanup = CountDownLatch(1)
      handler.post {
        controller.dispose()
        player?.release()
        thread.quitSafely()
        cleanup.countDown()
      }
      assertTrue(cleanup.await(5, TimeUnit.SECONDS))
    }
  }

  @Test
  fun `ElvPlaybackSessionService onTaskRemoved stops playback unless background audio is enabled and playing (#412)`() {
    assertFalse(ElvPlaybackSessionService.shouldKeepAliveOnTaskRemoved(backgroundEnabled = false, isPlaying = false))
    assertFalse(ElvPlaybackSessionService.shouldKeepAliveOnTaskRemoved(backgroundEnabled = false, isPlaying = true))
    assertFalse(ElvPlaybackSessionService.shouldKeepAliveOnTaskRemoved(backgroundEnabled = true, isPlaying = false))
    assertTrue(ElvPlaybackSessionService.shouldKeepAliveOnTaskRemoved(backgroundEnabled = true, isPlaying = true))

    val context = RuntimeEnvironment.getApplication()
    val thread = HandlerThread("ElvTaskRemovedTest").apply { start() }
    val handler = Handler(thread.looper)
    val stopRequests = AtomicInteger(0)
    var player: ExoPlayer? = null
    var session: androidx.media3.session.MediaSession? = null

    try {
      val ready = CountDownLatch(1)
      handler.post {
        player = ExoPlayer.Builder(context).setLooper(thread.looper).build()
        session = androidx.media3.session.MediaSession.Builder(context, player!!)
          .setId("elv-task-removed-test")
          .build()
        ElvPlaybackSessionService.registerSession(session!!) { stopRequests.incrementAndGet() }
        ready.countDown()
      }
      assertTrue(ready.await(5, TimeUnit.SECONDS))

      val service = Robolectric.buildService(ElvPlaybackSessionService::class.java).create().get()

      // Background audio enabled + actively playing -> keeps service alive without calling stop callback
      ElvPlaybackSessionService.setBackgroundAudioEnabled(true)
      ElvPlaybackSessionService.setSessionActivelyPlaying(true)
      service.onTaskRemoved(null)
      assertEquals(0, stopRequests.get())

      // Background audio enabled + NOT playing -> stops playback
      ElvPlaybackSessionService.setSessionActivelyPlaying(false)
      service.onTaskRemoved(null)
      assertEquals(1, stopRequests.get())

      // Background audio disabled + playing -> stops playback
      ElvPlaybackSessionService.setBackgroundAudioEnabled(false)
      ElvPlaybackSessionService.setSessionActivelyPlaying(true)
      service.onTaskRemoved(null)
      assertEquals(2, stopRequests.get())
    } finally {
      val cleanup = CountDownLatch(1)
      handler.post {
        session?.let {
          ElvPlaybackSessionService.unregisterSession(it)
          it.release()
        }
        player?.release()
        thread.quitSafely()
        cleanup.countDown()
      }
      assertTrue(cleanup.await(5, TimeUnit.SECONDS))
    }
  }
}

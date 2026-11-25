package io.github.fatihmutluu.elv.media3

import android.os.Handler
import androidx.annotation.OptIn
import androidx.media3.common.AudioAttributes
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
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
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class Media3EngineMultiViewTest {
  @Before
  fun setUp() {
    ElvPlaybackSessionService.resetForTest()
  }

  @After
  fun tearDown() {
    ElvPlaybackSessionService.resetForTest()
  }

  @Test
  fun `configureMultiView transfers AudioAttributes focus and MediaSession on active promotion and demotion (#34)`() {
    val app = RuntimeEnvironment.getApplication()
    val engine = Media3Engine(
      context = app,
      options = MultiViewEngineOptions(handleAudioFocus = false, multiViewTileCount = 2),
    )
    try {
      val handler = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }.get(engine) as Handler
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val focusField = Media3Engine::class.java.getDeclaredField("playerHandleAudioFocus").apply { isAccessible = true }
      val sessionField = Media3Engine::class.java.getDeclaredField("mediaSessionController").apply { isAccessible = true }
      val sessionController = sessionField.get(engine) as MediaSessionController

      fun <T> onPlaybackThread(block: () -> T): T {
        var result: T? = null
        var failure: Throwable? = null
        val latch = CountDownLatch(1)
        handler.post {
          try {
            result = block()
          } catch (t: Throwable) {
            failure = t
          } finally {
            latch.countDown()
          }
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        failure?.let { throw it }
        @Suppress("UNCHECKED_CAST")
        return result as T
      }

      engine.load(
        1,
        LoadRequest(
          url = "http://127.0.0.1:9/live/demo/demo/1001.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
        ),
      )

      val recordedFocusCalls = CopyOnWriteArrayList<Pair<AudioAttributes, Boolean>>()
      onPlaybackThread {
        val real = playerField.get(engine) as ExoPlayer
        assertEquals(0f, real.volume, 0.0001f)
        assertFalse(focusField.getBoolean(engine))
        assertNull(sessionController.activeForwardingPlayerForTest)
        assertNull(sessionController.activeSessionForTest)
        playerField.set(
          engine,
          object : ExoPlayer by real {
            override fun setAudioAttributes(audioAttributes: AudioAttributes, handleAudioFocus: Boolean) {
              recordedFocusCalls += (audioAttributes to handleAudioFocus)
              real.setAudioAttributes(audioAttributes, handleAudioFocus)
            }
          },
        )
      }

      // Promote muted secondary tile while playing
      engine.configureMultiView(handleAudioFocus = true, tileCount = 2)
      onPlaybackThread {
        val current = playerField.get(engine) as ExoPlayer
        assertEquals(1f, current.volume, 0.0001f)
        assertTrue(focusField.getBoolean(engine))
        assertEquals(listOf(STREAM_AUDIO_ATTRIBUTES to true), recordedFocusCalls.toList())
        assertNotNull(sessionController.activeForwardingPlayerForTest)
        assertNotNull(sessionController.activeSessionForTest)
        assertSame(sessionController.activeSessionForTest, ElvPlaybackSessionService.activeSession())
      }

      // Demote active tile back to muted secondary
      engine.configureMultiView(handleAudioFocus = false, tileCount = 2)
      onPlaybackThread {
        val current = playerField.get(engine) as ExoPlayer
        assertEquals(0f, current.volume, 0.0001f)
        assertFalse(focusField.getBoolean(engine))
        assertEquals(
          listOf(STREAM_AUDIO_ATTRIBUTES to true, STREAM_AUDIO_ATTRIBUTES to false),
          recordedFocusCalls.toList(),
        )
        assertNull(sessionController.activeForwardingPlayerForTest)
        assertNull(sessionController.activeSessionForTest)
        assertNull(ElvPlaybackSessionService.activeSession())
      }
    } finally {
      engine.dispose()
    }
  }

  @Test
  fun `demoting old primary after promoting new primary preserves new primary MediaSession (#34)`() {
    val app = RuntimeEnvironment.getApplication()
    val tile1 = Media3Engine(
      context = app,
      options = MultiViewEngineOptions(handleAudioFocus = true, multiViewTileCount = 2),
    )
    val tile2 = Media3Engine(
      context = app,
      options = MultiViewEngineOptions(handleAudioFocus = false, multiViewTileCount = 2),
    )
    try {
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val sessionField = Media3Engine::class.java.getDeclaredField("mediaSessionController").apply { isAccessible = true }
      val h1 = handlerField.get(tile1) as Handler
      val h2 = handlerField.get(tile2) as Handler
      val sc1 = sessionField.get(tile1) as MediaSessionController
      val sc2 = sessionField.get(tile2) as MediaSessionController

      fun flush(handler: Handler) {
        val latch = CountDownLatch(1)
        handler.post { latch.countDown() }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
      }

      tile1.load(1, LoadRequest("http://127.0.0.1:9/live/demo/demo/1.ts", emptyMap(), live = true, startMs = null, softwareAudio = false))
      tile2.load(1, LoadRequest("http://127.0.0.1:9/live/demo/demo/2.ts", emptyMap(), live = true, startMs = null, softwareAudio = false))
      flush(h1); flush(h2)

      assertNotNull(sc1.activeSessionForTest)
      assertNull(sc2.activeSessionForTest)
      assertSame(sc1.activeSessionForTest, ElvPlaybackSessionService.activeSession())

      // Promote tile2 first, then demote tile1
      tile2.configureMultiView(handleAudioFocus = true, tileCount = 2)
      flush(h2)
      val tile2Session = sc2.activeSessionForTest
      assertNotNull(tile2Session)
      assertSame(tile2Session, ElvPlaybackSessionService.activeSession())

      tile1.configureMultiView(handleAudioFocus = false, tileCount = 2)
      flush(h1)
      assertNull(sc1.activeSessionForTest)
      assertNull(sc1.activeForwardingPlayerForTest)
      assertSame(
        "demoting old primary must not clear newly promoted tile2 session",
        tile2Session,
        ElvPlaybackSessionService.activeSession(),
      )
    } finally {
      tile1.dispose()
      tile2.dispose()
    }
  }

  @Test
  fun `applyMultiViewAudioFocus disables audio focus and falls back cleanly on SecurityException (#34)`() {
    val app = RuntimeEnvironment.getApplication()
    val engine = Media3Engine(
      context = app,
      options = MultiViewEngineOptions(handleAudioFocus = false, multiViewTileCount = 2),
    )
    try {
      val handler = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }.get(engine) as Handler
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val factoryField = Media3Engine::class.java.getDeclaredField("playerFactory").apply { isAccessible = true }
      val factory = factoryField.get(engine) as PlayerFactory

      val calls = CopyOnWriteArrayList<Boolean>()
      val latch = CountDownLatch(1)
      var failure: Throwable? = null
      handler.post {
        try {
          val real = playerField.get(engine) as ExoPlayer
          val throwingSpy = object : ExoPlayer by real {
            override fun setAudioAttributes(audioAttributes: AudioAttributes, handleAudioFocus: Boolean) {
              calls += handleAudioFocus
              if (handleAudioFocus) throw SecurityException("TAKE_AUDIO_FOCUS denied")
              real.setAudioAttributes(audioAttributes, false)
            }
          }
          val granted = applyMultiViewAudioFocus(throwingSpy, desiredFocus = true, factory = factory)
          assertFalse(granted)
          assertFalse(factory.audioFocusAllowed)
          assertEquals(listOf(true, false), calls.toList())
        } catch (t: Throwable) {
          failure = t
        } finally {
          latch.countDown()
        }
      }
      assertTrue(latch.await(5, TimeUnit.SECONDS))
      failure?.let { throw it }
    } finally {
      engine.dispose()
    }
  }
}

package io.github.fatihmutluu.elv.media3

import android.os.Handler
import androidx.annotation.OptIn
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class PlaybackSpeedPolicyTest {
  @Test
  fun `clamps speed to 0_25 through 4_0 and falls back to 1_0 for non-finite values (#264)`() {
    assertEquals(0.25f, PlaybackSpeedPolicy.clampSpeed(0.0), 0.0001f)
    assertEquals(0.25f, PlaybackSpeedPolicy.clampSpeed(-2.0), 0.0001f)
    assertEquals(0.25f, PlaybackSpeedPolicy.clampSpeed(0.25), 0.0001f)
    assertEquals(1.5f, PlaybackSpeedPolicy.clampSpeed(1.5), 0.0001f)
    assertEquals(4.0f, PlaybackSpeedPolicy.clampSpeed(4.0), 0.0001f)
    assertEquals(4.0f, PlaybackSpeedPolicy.clampSpeed(12.5), 0.0001f)
    assertEquals(1.0f, PlaybackSpeedPolicy.clampSpeed(Double.NaN), 0.0001f)
    assertEquals(1.0f, PlaybackSpeedPolicy.clampSpeed(Double.POSITIVE_INFINITY), 0.0001f)
    assertEquals(1.0f, PlaybackSpeedPolicy.clampSpeed(Double.NEGATIVE_INFINITY), 0.0001f)
  }

  @Test
  fun `computes PlaybackParameters with pitch 1_0 when locked and pitch equal to speed when unlocked (#264)`() {
    assertEquals(PlaybackParameters(1.5f, 1.0f), PlaybackSpeedPolicy.parameters(1.5, pitchLock = true))
    assertEquals(PlaybackParameters(1.5f, 1.5f), PlaybackSpeedPolicy.parameters(1.5, pitchLock = false))
    assertEquals(PlaybackParameters(0.5f, 1.0f), PlaybackSpeedPolicy.parameters(0.5, pitchLock = true))
    assertEquals(PlaybackParameters(0.5f, 0.5f), PlaybackSpeedPolicy.parameters(0.5, pitchLock = false))
    assertEquals(PlaybackParameters(4.0f, 4.0f), PlaybackSpeedPolicy.parameters(9.0, pitchLock = false))
    assertEquals(PlaybackParameters(1.0f, 1.0f), PlaybackSpeedPolicy.parameters(Double.NaN, pitchLock = false))
  }

  @Test
  fun `Media3Engine applies VOD speed and pitch-lock, ignores live speed, survives rebuilds, and resets speed on load and stop (#264)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    try {
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
      val handler = handlerField.get(engine) as Handler

      fun readPlaybackParameters(): PlaybackParameters {
        var params = PlaybackParameters.DEFAULT
        val latch = CountDownLatch(1)
        handler.post {
          val current = playerField.get(engine) as ExoPlayer?
          assertNotNull(current)
          params = current!!.playbackParameters
          latch.countDown()
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return params
      }

      // Live stream ignores setSpeed
      engine.load(
        1,
        LoadRequest(
          url = "http://127.0.0.1:9/live/demo/demo/1.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
        ),
      )
      engine.setSpeed(1, 2.0)
      assertEquals(PlaybackParameters.DEFAULT, readPlaybackParameters())

      // VOD applies speed with pitch-lock enabled by default (pitch = 1.0f)
      engine.load(
        2,
        LoadRequest(
          url = "http://127.0.0.1:9/movie/demo/demo/1.mp4",
          headers = emptyMap(),
          live = false,
          startMs = 0L,
          softwareAudio = false,
        ),
      )
      engine.setSpeed(2, 1.75)
      assertEquals(PlaybackParameters(1.75f, 1.0f), readPlaybackParameters())

      // Disabling pitch-lock immediately updates active VOD PlaybackParameters (pitch = speed)
      engine.setPitchLock(false)
      assertEquals(PlaybackParameters(1.75f, 1.75f), readPlaybackParameters())

      // Re-applying across player rebuild (recreate) preserves both speed and pitchLock
      engine.recreate(3)
      assertEquals(PlaybackParameters(1.75f, 1.75f), readPlaybackParameters())

      // New load resets speed to 1.0f while keeping user's pitchLock preference (false)
      engine.load(
        4,
        LoadRequest(
          url = "http://127.0.0.1:9/movie/demo/demo/2.mp4",
          headers = emptyMap(),
          live = false,
          startMs = 0L,
          softwareAudio = false,
        ),
      )
      assertEquals(PlaybackParameters(1.0f, 1.0f), readPlaybackParameters())
      engine.setSpeed(4, 1.25)
      assertEquals(PlaybackParameters(1.25f, 1.25f), readPlaybackParameters())

      // Stop resets speed back to 1.0f while keeping user's pitchLock preference
      engine.stop(5)
      assertEquals(PlaybackParameters.DEFAULT, readPlaybackParameters())
      engine.load(
        6,
        LoadRequest(
          url = "http://127.0.0.1:9/movie/demo/demo/3.mp4",
          headers = emptyMap(),
          live = false,
          startMs = 0L,
          softwareAudio = false,
        ),
      )
      engine.setSpeed(6, 2.0)
      assertEquals(PlaybackParameters(2.0f, 2.0f), readPlaybackParameters())
    } finally {
      engine.dispose()
    }
  }
}

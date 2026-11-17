package io.github.fatihmutluu.elv.media3

import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.annotation.OptIn
import androidx.media3.common.FlagSet
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.video.MediaCodecVideoDecoderException
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class EventReporterTest {
  @Test
  fun `maps MediaCodecVideoDecoderException with released surface to surface-lost and valid surface to decoder (I6)`() {
    val events = mutableListOf<Map<String, Any?>>()
    val handler = Handler(Looper.getMainLooper())
    val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication())
      .setLooper(Looper.getMainLooper())
      .build()
    try {
      val reporter = EventReporter(
        handler = handler,
        send = { events += it },
        onHlsDetected = {},
        onFirstFrame = {},
        onCue = { _, _ -> },
      )
      reporter.begin(player, live = true, manifestLoaded = AtomicBoolean(false))
      events.clear()

      val deadTex = SurfaceTexture(0)
      val deadSurface = Surface(deadTex)
      deadSurface.release()
      deadTex.release()
      val surfaceCause = MediaCodecVideoDecoderException(IllegalStateException("dead surface"), null, deadSurface)
      val surfaceErr = PlaybackException(
        "video decode failed",
        surfaceCause,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
      )
      reporter.onPlayerError(surfaceErr)
      val reportedSurfaceError = events.last()["error"] as Map<*, *>
      assertEquals("surface-lost", reportedSurfaceError["code"])

      val validCause = MediaCodecVideoDecoderException(IllegalStateException("corrupt slice"), null, null)
      val validErr = PlaybackException(
        "video decode failed",
        validCause,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
      )
      reporter.onPlayerError(validErr)
      val reportedDecoderError = events.last()["error"] as Map<*, *>
      assertEquals("decoder", reportedDecoderError["code"])
    } finally {
      player.release()
    }
  }

  /** A real player whose playback state and playing flag the test sets. */
  private class ScriptedPlayer(private val real: ExoPlayer) : ExoPlayer by real {
    var state = Player.STATE_BUFFERING
    var playing = false

    override fun getPlaybackState(): Int = state

    override fun isPlaying(): Boolean = playing

    override fun getPlayWhenReady(): Boolean = true
  }

  private fun endedEvents(live: Boolean, playFirst: Boolean): List<Map<String, Any?>> {
    val events = mutableListOf<Map<String, Any?>>()
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val player = ScriptedPlayer(real)
      val reporter = EventReporter(
        handler = Handler(Looper.getMainLooper()),
        send = { events += it },
        onHlsDetected = {},
        onFirstFrame = {},
        onCue = { _, _ -> },
      )
      reporter.begin(player, live = live, manifestLoaded = AtomicBoolean(false))
      val changed = Player.Events(FlagSet.Builder().add(Player.EVENT_PLAYBACK_STATE_CHANGED).build())
      if (playFirst) {
        player.state = Player.STATE_READY
        player.playing = true
        reporter.onEvents(player, changed)
        player.playing = false
      }
      events.clear()
      player.state = Player.STATE_ENDED
      reporter.onEvents(player, changed)
      reporter.end()
    } finally {
      real.release()
    }
    return events.filter { it["type"] == "state" || it["type"] == "error" }
  }

  @Test
  fun `a VOD that ends before it played is a network error, a played VOD ends`() {
    val unplayed = endedEvents(live = false, playFirst = false)
    assertEquals(1, unplayed.size)
    assertEquals("error", unplayed[0]["type"])
    val error = unplayed[0]["error"] as Map<*, *>
    assertEquals("network", error["code"])
    assertEquals("empty media ended before playback", error["detail"])

    val played = endedEvents(live = false, playFirst = true)
    assertEquals(listOf(mapOf("type" to "state", "state" to "ended")), played)

    val live = endedEvents(live = true, playFirst = true)
    assertEquals("network", (live.single()["error"] as Map<*, *>)["code"])
  }
}

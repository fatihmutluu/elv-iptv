package io.github.fatihmutluu.elv.media3

import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.annotation.OptIn
import androidx.media3.common.PlaybackException
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
}

package io.github.fatihmutluu.elv.media3

import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.view.Surface
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.FlagSet
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecRenderer
import androidx.media3.exoplayer.video.MediaCodecVideoDecoderException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class EventReporterTest {
  private class ScriptedPlayer(private val real: ExoPlayer) : ExoPlayer by real {
    var state = Player.STATE_BUFFERING
    var playing = false
    var wantPlay = true
    var suppressionReason = Player.PLAYBACK_SUPPRESSION_REASON_NONE
    var scriptedDuration = C.TIME_UNSET
    var scriptedPosition = 0L
    var scriptedTracks: Tracks = Tracks.EMPTY

    override fun getPlaybackState(): Int = state
    override fun isPlaying(): Boolean = playing
    override fun getPlayWhenReady(): Boolean = wantPlay
    override fun getPlaybackSuppressionReason(): Int = suppressionReason
    override fun getDuration(): Long = scriptedDuration
    override fun getCurrentPosition(): Long = scriptedPosition
    override fun getCurrentTracks(): Tracks = scriptedTracks
  }

  private fun eventsFlag(vararg flags: Int): Player.Events =
    Player.Events(FlagSet.Builder().addAll(*flags).build())

  @Test
  fun `maps released surface to surface-lost, records failed video codec on valid surface, and ignores SupersededMediaException (#109)`() {
    val events = mutableListOf<Map<String, Any?>>()
    val failedCodecs = mutableListOf<String>()
    var invalidAttachedSurface = false
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val reporter = EventReporter(
        handler = Handler(Looper.getMainLooper()),
        fence = PrepareFence(),
        hasInvalidAttachedSurface = { invalidAttachedSurface },
        send = { events += it },
        onHlsDetected = {},
        onBehindLiveWindow = {},
        onAudioFocusDenied = { false },
        onVideoCodecFailed = { failedCodecs += it.name },
        onFirstFrame = {},
        onCue = { _, _ -> },
      )
      reporter.begin(real, live = true, prepareSerial = 1L, reused = false)
      events.clear()

      // SupersededMediaException must be silently ignored
      val superseded = PlaybackException(
        "superseded",
        SupersededMediaException(),
        PlaybackException.ERROR_CODE_IO_UNSPECIFIED,
      )
      reporter.onPlayerError(superseded)
      assertTrue("SupersededMediaException must never emit an engine error", events.isEmpty())

      val hwInfo = MediaCodecInfo.newInstance(
        "c2.goldfish.hevc.decoder",
        MimeTypes.VIDEO_H265,
        MimeTypes.VIDEO_H265,
        null,
        true,
        false,
        true,
        false,
        false,
      )
      val deadTex = SurfaceTexture(0)
      val deadSurface = Surface(deadTex)
      deadSurface.release()
      deadTex.release()
      val surfaceErr = PlaybackException(
        "video decode failed",
        MediaCodecVideoDecoderException(IllegalStateException("dead surface"), hwInfo, deadSurface),
        PlaybackException.ERROR_CODE_DECODING_FAILED,
      )
      reporter.onPlayerError(surfaceErr)
      assertEquals("surface-lost", (events.last()["error"] as Map<*, *>)["code"])
      assertTrue("surface-lost must not blame the hardware codec", failedCodecs.isEmpty())

      val validErr = PlaybackException(
        "video decode failed",
        MediaCodecVideoDecoderException(IllegalStateException("corrupt slice"), hwInfo, null),
        PlaybackException.ERROR_CODE_DECODING_FAILED,
      )
      reporter.onPlayerError(validErr)
      assertEquals("decoder", (events.last()["error"] as Map<*, *>)["code"])
      assertEquals(listOf("c2.goldfish.hevc.decoder"), failedCodecs)

      // DecoderInitializationException (4001) on video also checks attached surface validity and records failed codec
      failedCodecs.clear()
      val hevcFmt = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H265).setWidth(3840).setHeight(2160).build()
      val initCause = MediaCodecRenderer.DecoderInitializationException(
        hevcFmt,
        IllegalArgumentException("configure failed"),
        false,
        hwInfo,
      )
      val initErr = PlaybackException("decoder init failed", initCause, PlaybackException.ERROR_CODE_DECODER_INIT_FAILED)

      invalidAttachedSurface = true
      reporter.onPlayerError(initErr)
      assertEquals("surface-lost", (events.last()["error"] as Map<*, *>)["code"])
      assertTrue("init failure on invalid surface must not blame hardware codec", failedCodecs.isEmpty())

      invalidAttachedSurface = false
      reporter.onPlayerError(initErr)
      assertEquals("decoder", (events.last()["error"] as Map<*, *>)["code"])
      assertEquals(listOf("c2.goldfish.hevc.decoder"), failedCodecs)
    } finally {
      real.release()
    }
  }

  @Test
  fun `distinguishes unplayed empty VOD, played VOD, live EOF and valid VOD resumed at EOF`() {
    fun runEof(live: Boolean, playFirst: Boolean, durationMs: Long = C.TIME_UNSET, positionMs: Long = 0L): List<Map<String, Any?>> {
      val events = mutableListOf<Map<String, Any?>>()
      val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
      try {
        val player = ScriptedPlayer(real).apply {
          scriptedDuration = durationMs
          scriptedPosition = positionMs
        }
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
        )
        reporter.begin(player, live = live, prepareSerial = 1L, reused = false)
        val changed = eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED)
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

    val emptyUnplayed = runEof(live = false, playFirst = false)
    assertEquals("network", (emptyUnplayed.single()["error"] as Map<*, *>)["code"])

    val playedVod = runEof(live = false, playFirst = true)
    assertEquals(listOf(mapOf("type" to "state", "state" to "ended")), playedVod)

    val resumedAtEof = runEof(live = false, playFirst = false, durationMs = 120_000L, positionMs = 120_000L)
    assertEquals(listOf(mapOf("type" to "state", "state" to "ended")), resumedAtEof)

    val liveEnded = runEof(live = true, playFirst = true)
    assertEquals("network", (liveEnded.single()["error"] as Map<*, *>)["code"])
  }

  @Test
  fun `transient audio-focus suppression emits paused without stalling, and audio-only streams emit firstFrame keeping shutter`() {
    val events = mutableListOf<Map<String, Any?>>()
    var shutterLifted = false
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val player = ScriptedPlayer(real)
      val audioFmt = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).build()
      player.scriptedTracks = Tracks(
        listOf(Tracks.Group(TrackGroup("a", audioFmt), false, intArrayOf(C.FORMAT_HANDLED), booleanArrayOf(true)))
      )
      val reporter = EventReporter(
        handler = Handler(Looper.getMainLooper()),
        fence = PrepareFence(),
        send = { events += it },
        onHlsDetected = {},
        onBehindLiveWindow = {},
        onAudioFocusDenied = { false },
        onVideoCodecFailed = {},
        onFirstFrame = { shutterLifted = true },
        onCue = { _, _ -> },
      )
      reporter.begin(player, live = true, prepareSerial = 1L, reused = false)
      events.clear()

      // Audio-only stream starts playing -> emits firstFrame once without lifting video shutter!
      player.state = Player.STATE_READY
      player.playing = true
      reporter.onEvents(player, eventsFlag(Player.EVENT_IS_PLAYING_CHANGED, Player.EVENT_TRACKS_CHANGED))
      assertEquals(1, events.count { it["type"] == "firstFrame" })
      assertFalse("audio-only stream must keep shutterView covering surfaceView", shutterLifted)

      // Transient audio-focus loss suppresses playback while playWhenReady stays true -> emits paused, no stall!
      events.clear()
      player.playing = false
      player.state = Player.STATE_BUFFERING
      player.suppressionReason = Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS
      reporter.onEvents(
        player,
        eventsFlag(Player.EVENT_PLAYBACK_SUPPRESSION_REASON_CHANGED, Player.EVENT_PLAYBACK_STATE_CHANGED),
      )
      assertEquals(listOf("paused"), events.filter { it["type"] == "state" }.map { it["state"] })
      assertTrue(events.none { it["type"] == "stall" })
      reporter.end()
    } finally {
      real.release()
    }
  }

  @Test
  fun `recovers BEHIND_LIVE_WINDOW in-place up to 2 times per prepare before escalating (#235)`() {
    val events = mutableListOf<Map<String, Any?>>()
    var recoveries = 0
    var focusDenied = 0
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val player = ScriptedPlayer(real)
      val reporter = EventReporter(
        handler = Handler(Looper.getMainLooper()),
        fence = PrepareFence(),
        send = { events += it },
        onHlsDetected = {},
        onBehindLiveWindow = { recoveries += 1 },
        onAudioFocusDenied = {
          focusDenied += 1
          true
        },
        onVideoCodecFailed = {},
        onFirstFrame = {},
        onCue = { _, _ -> },
      )
      reporter.begin(player, live = true, prepareSerial = 1L, reused = false)
      events.clear()

      val behindErr = PlaybackException(
        "behind live window",
        null,
        PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW,
      )
      reporter.onPlayerError(behindErr)
      reporter.onPlayerError(behindErr)
      assertEquals(2, recoveries)
      assertTrue(events.isEmpty())

      // 3rd consecutive BEHIND_LIVE_WINDOW without reaching playing escalates as network error
      reporter.onPlayerError(behindErr)
      assertEquals(2, recoveries)
      assertEquals("network", (events.single()["error"] as Map<*, *>)["code"])

      // SecurityException invokes onAudioFocusDenied instead of emitting error when handled
      events.clear()
      val secErr = PlaybackException(
        "audio focus security exception",
        SecurityException("TAKE_AUDIO_FOCUS"),
        PlaybackException.ERROR_CODE_UNSPECIFIED,
      )
      reporter.onPlayerError(secErr)
      assertEquals(1, focusDenied)
      assertTrue(events.isEmpty())
    } finally {
      real.release()
    }
  }
}

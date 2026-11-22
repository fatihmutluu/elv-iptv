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
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.DecoderCounters
import androidx.media3.exoplayer.ExoPlaybackException
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.audio.AudioSink
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
    var scriptedVideoCounters: DecoderCounters? = null

    override fun getPlaybackState(): Int = state
    override fun isPlaying(): Boolean = playing
    override fun getPlayWhenReady(): Boolean = wantPlay
    override fun getPlaybackSuppressionReason(): Int = suppressionReason
    override fun getDuration(): Long = scriptedDuration
    override fun getCurrentPosition(): Long = scriptedPosition
    override fun getCurrentTracks(): Tracks = scriptedTracks
    override fun getVideoDecoderCounters(): DecoderCounters? = scriptedVideoCounters
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
  fun `transient audio-focus suppression holds state with zero clock rate without emitting paused or stall, while explicit pause and other suppression emit paused (#436)`() {
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

      // Transient audio-focus loss suppresses playback while playWhenReady stays true -> holds state, rate=0, no stall!
      events.clear()
      player.playing = false
      player.state = Player.STATE_BUFFERING
      player.suppressionReason = Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS
      reporter.onEvents(
        player,
        eventsFlag(Player.EVENT_PLAYBACK_SUPPRESSION_REASON_CHANGED, Player.EVENT_PLAYBACK_STATE_CHANGED),
      )
      assertTrue(
        "transient audio-focus suppression must not emit paused/buffering state: $events",
        events.none { it["type"] == "state" },
      )
      assertTrue(events.none { it["type"] == "stall" })
      val pausedClock = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertEquals(0.0, pausedClock["rate"])

      // Non-transient suppression reason while playWhenReady == true still emits paused
      events.clear()
      player.state = Player.STATE_READY
      player.suppressionReason = Player.PLAYBACK_SUPPRESSION_REASON_UNSUITABLE_AUDIO_OUTPUT
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_SUPPRESSION_REASON_CHANGED))
      assertEquals(listOf("paused"), events.filter { it["type"] == "state" }.map { it["state"] })

      // Resume playing, then explicit !playWhenReady during transient suppression still emits paused
      events.clear()
      player.suppressionReason = Player.PLAYBACK_SUPPRESSION_REASON_NONE
      player.playing = true
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_SUPPRESSION_REASON_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      events.clear()
      player.playing = false
      player.wantPlay = false
      player.suppressionReason = Player.PLAYBACK_SUPPRESSION_REASON_TRANSIENT_AUDIO_FOCUS_LOSS
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAY_WHEN_READY_CHANGED))
      assertEquals(listOf("paused"), events.filter { it["type"] == "state" }.map { it["state"] })
      reporter.end()
    } finally {
      real.release()
    }
  }

  @Test
  fun `detects audio decoder and AudioSink failures and delegates once to onAudioCodecFailed (#436)`() {
    val events = mutableListOf<Map<String, Any?>>()
    var audioFailures = 0
    var handleAudioFailure = true
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val reporter = EventReporter(
        handler = Handler(Looper.getMainLooper()),
        fence = PrepareFence(),
        send = { events += it },
        onHlsDetected = {},
        onBehindLiveWindow = {},
        onAudioFocusDenied = { false },
        onVideoCodecFailed = {},
        onAudioCodecFailed = {
          audioFailures += 1
          handleAudioFailure
        },
        onFirstFrame = {},
        onCue = { _, _ -> },
      )
      reporter.begin(real, live = false, prepareSerial = 1L, reused = false)
      events.clear()

      val audioFmt = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AC3).setChannelCount(6).setSampleRate(48_000).build()

      // 1. Audio DecoderInitializationException
      val audioInit = MediaCodecRenderer.DecoderInitializationException(audioFmt, IllegalStateException("no ac3"), false, -49_999)
      reporter.onPlayerError(PlaybackException("audio init", audioInit, PlaybackException.ERROR_CODE_DECODER_INIT_FAILED))
      assertEquals(1, audioFailures)
      assertTrue("handled audio failure must suppress error emission", events.isEmpty())

      // 2. AudioSink.InitializationException
      val sinkInit = AudioSink.InitializationException("sink init", 0, audioFmt, false, null)
      reporter.onPlayerError(PlaybackException("sink init", sinkInit, PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED))
      assertEquals(2, audioFailures)
      assertTrue(events.isEmpty())

      // 3. AudioSink.WriteException
      val sinkWrite = AudioSink.WriteException(-1, audioFmt, false)
      reporter.onPlayerError(PlaybackException("sink write", sinkWrite, PlaybackException.ERROR_CODE_AUDIO_TRACK_WRITE_FAILED))
      assertEquals(3, audioFailures)
      assertTrue(events.isEmpty())

      // 4. Non-video ERROR_CODE_DECODING_FAILED without video exception
      reporter.onPlayerError(PlaybackException("audio decode", IllegalStateException("bad frame"), PlaybackException.ERROR_CODE_DECODING_FAILED))
      assertEquals(4, audioFailures)
      assertTrue(events.isEmpty())

      // 5. Video decoder failure and non-audio ExoPlaybackException must NOT invoke onAudioCodecFailed
      val hwInfo = MediaCodecInfo.newInstance("c2.vid", MimeTypes.VIDEO_H265, MimeTypes.VIDEO_H265, null, true, false, true, false, false)
      val vidErr = PlaybackException(
        "video decode",
        MediaCodecVideoDecoderException(IllegalStateException("bad slice"), hwInfo, null),
        PlaybackException.ERROR_CODE_DECODING_FAILED,
      )
      reporter.onPlayerError(vidErr)
      assertEquals(4, audioFailures)
      assertEquals("decoder", (events.last()["error"] as Map<*, *>)["code"])

      events.clear()
      val textFmt = Format.Builder().setSampleMimeType(MimeTypes.TEXT_VTT).build()
      val textExoErr = ExoPlaybackException.createForRenderer(
        IllegalStateException("malformed cue"),
        "TextRenderer",
        2,
        textFmt,
        C.FORMAT_HANDLED,
        false,
        PlaybackException.ERROR_CODE_DECODING_FAILED,
      )
      reporter.onPlayerError(textExoErr)
      assertEquals(4, audioFailures)
      assertEquals("decoder", (events.single()["error"] as Map<*, *>)["code"])

      // 6. When onAudioCodecFailed returns false, audio failure emits decoder error normally
      events.clear()
      handleAudioFailure = false
      reporter.onPlayerError(PlaybackException("sink init 2", sinkInit, PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED))
      assertEquals(5, audioFailures)
      assertEquals("decoder", (events.single()["error"] as Map<*, *>)["code"])
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

  @Test
  fun `reports transfer progress during opening and stall, video frame telemetry on clock, and DV fallback (#189, #314, #321)`() {
    val events = mutableListOf<Map<String, Any?>>()
    var dvFailures = 0
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val player = ScriptedPlayer(real)
      val videoFmt = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H265).setWidth(1920).setHeight(1080).build()
      val audioFmt = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).build()
      player.scriptedTracks = Tracks(
        listOf(
          Tracks.Group(TrackGroup("v", videoFmt), false, intArrayOf(C.FORMAT_HANDLED), booleanArrayOf(true)),
          Tracks.Group(TrackGroup("a", audioFmt), false, intArrayOf(C.FORMAT_HANDLED), booleanArrayOf(true)),
        )
      )
      val reporter = EventReporter(
        handler = Handler(Looper.getMainLooper()),
        fence = PrepareFence(),
        send = { events += it },
        onHlsDetected = {},
        onBehindLiveWindow = {},
        onAudioFocusDenied = { false },
        onVideoCodecFailed = {},
        onDolbyVisionFailed = { dvFailures += 1 },
        onFirstFrame = {},
        onCue = { _, _ -> },
      )
      reporter.begin(player, live = false, prepareSerial = 1L, reused = false)
      events.clear()

      // Opening emits transfer progress
      assertTrue(reporter.isWaitingForMedia)
      reporter.onTransferProgress(bytesReceived = 65_536L, atMs = 1_200L)
      assertEquals(
        listOf(mapOf("type" to "progress", "bytesReceived" to 65_536.0, "atMs" to 1_200.0)),
        events,
      )

      // Playing with null videoDecoderCounters reports hasVideoTrack=true, decodedVideoFrames=0.0
      events.clear()
      player.state = Player.STATE_READY
      player.playing = true
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      assertFalse(reporter.isWaitingForMedia)
      val zeroClock = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertEquals(true, zeroClock["hasVideoTrack"])
      assertEquals(0.0, zeroClock["decodedVideoFrames"])

      // Steady playing suppresses transfer progress
      events.clear()
      reporter.onTransferProgress(bytesReceived = 131_072L, atMs = 2_000L)
      assertTrue(events.isEmpty())

      // Populated DecoderCounters reports renderedOutputBufferCount
      player.scriptedVideoCounters = DecoderCounters().apply { renderedOutputBufferCount = 42 }
      player.playing = false
      player.state = Player.STATE_BUFFERING
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      val activeClock = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertEquals(true, activeClock["hasVideoTrack"])
      assertEquals(42.0, activeClock["decodedVideoFrames"])
      assertTrue(reporter.isWaitingForMedia)

      // Mid-stream stall allows transfer progress again
      events.clear()
      reporter.onTransferProgress(bytesReceived = 262_144L, atMs = 3_000L)
      assertEquals(1, events.count { it["type"] == "progress" })

      // Dolby Vision DecoderInitializationException invokes onDolbyVisionFailed even without codecInfo
      val dvFmt = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_DOLBY_VISION).setCodecs("dvhe.07.06").build()
      val dvCause = MediaCodecRenderer.DecoderInitializationException(
        dvFmt,
        IllegalStateException("no DV7"),
        false,
        -49_999,
      )
      reporter.onPlayerError(PlaybackException("dv init failed", dvCause, PlaybackException.ERROR_CODE_DECODER_INIT_FAILED))
      assertEquals(1, dvFailures)
      reporter.end()
    } finally {
      real.release()
    }
  }

  @Test
  fun `emits isLiveTs on clock anchors strictly for live MPEG-TS streams (#141)`() {
    val events = mutableListOf<Map<String, Any?>>()
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val player = ScriptedPlayer(real).apply {
        state = Player.STATE_READY
        playing = true
        scriptedPosition = 10_000L
        scriptedDuration = 30_000L
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

      // Live MPEG-TS emits isLiveTs = true
      reporter.begin(player, live = true, prepareSerial = 1L, reused = false, isLiveTs = true)
      events.clear()
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      val tsClock = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertEquals(true, tsClock["isLiveTs"])
      assertEquals(30_000.0, tsClock["liveEdgeMs"])

      // Live HLS omits isLiveTs
      reporter.begin(player, live = true, prepareSerial = 2L, reused = false, isLiveTs = false)
      events.clear()
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      val hlsClock = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertFalse(hlsClock.containsKey("isLiveTs"))

      // VOD omits isLiveTs even if isLiveTs=true is accidentally passed
      reporter.begin(player, live = false, prepareSerial = 3L, reused = false, isLiveTs = true)
      events.clear()
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      val vodClock = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertFalse(vodClock.containsKey("isLiveTs"))
      reporter.end()
    } finally {
      real.release()
    }
  }

  @Test
  fun `emits deduplicated mediaInfo on tracks and video size changes and resets between prepares (#58)`() {
    val events = mutableListOf<Map<String, Any?>>()
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val player = ScriptedPlayer(real)
      val hdrColor = androidx.media3.common.ColorInfo.Builder()
        .setColorTransfer(C.COLOR_TRANSFER_ST2084)
        .build()
      val videoFmt = Format.Builder()
        .setSampleMimeType(MimeTypes.VIDEO_H265)
        .setWidth(1920)
        .setHeight(1080)
        .setFrameRate(50f)
        .setColorInfo(hdrColor)
        .build()
      player.scriptedTracks = Tracks(
        listOf(
          Tracks.Group(TrackGroup("v", videoFmt), false, intArrayOf(C.FORMAT_HANDLED), booleanArrayOf(true)),
        )
      )
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
      reporter.begin(player, live = true, prepareSerial = 1L, reused = false)
      events.clear()

      reporter.onTracksChanged(player.scriptedTracks)
      reporter.onTracksChanged(player.scriptedTracks)
      assertEquals(1, events.count { it["type"] == "mediaInfo" })
      assertEquals(
        mapOf("width" to 1920, "height" to 1080, "fps" to 50.0, "codec" to "hevc", "hdr" to "hdr10"),
        events.single()["info"],
      )

      // Video size change emits updated dimensions once and deduplicates repeat calls
      reporter.onVideoSizeChanged(VideoSize(3840, 2160))
      reporter.onVideoSizeChanged(VideoSize(3840, 2160))
      assertEquals(2, events.count { it["type"] == "mediaInfo" })
      assertEquals(
        mapOf("width" to 3840, "height" to 2160, "fps" to 50.0, "codec" to "hevc", "hdr" to "hdr10"),
        events.last()["info"],
      )
      reporter.end()
    } finally {
      real.release()
    }
  }
}

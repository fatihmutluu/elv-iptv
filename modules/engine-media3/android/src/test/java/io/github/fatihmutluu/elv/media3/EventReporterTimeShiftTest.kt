package io.github.fatihmutluu.elv.media3

import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.FlagSet
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import java.time.Duration
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class EventReporterTimeShiftTest {
  private class ScriptedLivePlayer(private val real: ExoPlayer) : ExoPlayer by real {
    var state = Player.STATE_READY
    var playing = true
    var wantPlay = true
    var scriptedDuration = C.TIME_UNSET
    var scriptedPosition = 0L
    var scriptedSeekable: Boolean? = null
    var scriptedTimeline: Timeline? = null

    override fun getPlaybackState(): Int = state
    override fun isPlaying(): Boolean = playing
    override fun getPlayWhenReady(): Boolean = wantPlay
    override fun getDuration(): Long = scriptedDuration
    override fun getCurrentPosition(): Long = scriptedPosition
    override fun isCurrentMediaItemSeekable(): Boolean = scriptedSeekable ?: real.isCurrentMediaItemSeekable
    override fun getCurrentTimeline(): Timeline = scriptedTimeline ?: real.currentTimeline
    override fun getCurrentMediaItemIndex(): Int = if (scriptedTimeline != null) 0 else real.currentMediaItemIndex
  }

  private fun eventsFlag(vararg flags: Int): Player.Events =
    Player.Events(FlagSet.Builder().addAll(*flags).build())

  private fun newReporter(events: MutableList<Map<String, Any?>>): EventReporter = EventReporter(
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

  private fun liveTimeline(durationUsProvider: () -> Long): Timeline = object : Timeline() {
    override fun getWindowCount(): Int = 1
    override fun getWindow(windowIndex: Int, window: Window, defaultPositionProjectionUs: Long): Window =
      window.set(
        "live",
        MediaItem.EMPTY,
        null,
        C.TIME_UNSET,
        C.TIME_UNSET,
        C.TIME_UNSET,
        true,
        true,
        MediaItem.LiveConfiguration.UNSET,
        0L,
        durationUsProvider(),
        0,
        0,
        0L,
      )
    override fun getPeriodCount(): Int = 1
    override fun getPeriod(periodIndex: Int, period: Period, setIds: Boolean): Period =
      period.set("p", "p", 0, durationUsProvider(), 0L)
    override fun getIndexOfPeriod(uid: Any): Int = 0
    override fun getUidOfPeriod(periodIndex: Int): Any = "p"
  }

  @Test
  fun `emits liveSeekableStartMs, liveEdgeMs, and timeShiftSupported from Timeline Window (#28)`() {
    val events = mutableListOf<Map<String, Any?>>()
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val player = ScriptedLivePlayer(real).apply {
        scriptedPosition = 45_000L
        scriptedDuration = 60_000L
        scriptedSeekable = true
        scriptedTimeline = liveTimeline { 60_000_000L }
      }
      val reporter = newReporter(events)
      reporter.begin(player, live = true, prepareSerial = 1L, reused = false)
      events.clear()
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      val seekableClock = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertEquals(0.0, seekableClock["liveSeekableStartMs"])
      assertEquals(60_000.0, seekableClock["liveEdgeMs"])
      assertEquals(true, seekableClock["timeShiftSupported"])

      player.scriptedSeekable = false
      reporter.begin(player, live = true, prepareSerial = 2L, reused = false)
      events.clear()
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      val nonSeekableClock = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertFalse(nonSeekableClock.containsKey("liveSeekableStartMs"))
      assertEquals(false, nonSeekableClock["timeShiftSupported"])
      reporter.end()
    } finally {
      real.release()
    }
  }

  @Test
  fun `keeps 1s clock tick alive while paused on live time-shift stream and stops on idle, ended, error, or end (#28)`() {
    val events = mutableListOf<Map<String, Any?>>()
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      var liveWindowDurationUs = 60_000_000L
      val player = ScriptedLivePlayer(real).apply {
        scriptedPosition = 60_000L
        scriptedDuration = 60_000L
        scriptedSeekable = true
        scriptedTimeline = liveTimeline { liveWindowDurationUs }
      }
      val reporter = newReporter(events)
      reporter.begin(player, live = true, prepareSerial = 1L, reused = false)
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))

      events.clear()
      player.playing = false
      player.wantPlay = false
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAY_WHEN_READY_CHANGED, Player.EVENT_IS_PLAYING_CHANGED))
      assertEquals(1, events.count { it["type"] == "clock" })

      events.clear()
      liveWindowDurationUs = 61_000_000L
      player.scriptedDuration = 61_000L
      Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
      val tick1 = events.single { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertEquals(0.0, tick1["rate"])
      assertEquals(60_000.0, tick1["positionMs"])
      assertEquals(61_000.0, tick1["liveEdgeMs"])
      assertEquals(true, tick1["timeShiftSupported"])

      events.clear()
      player.state = Player.STATE_ENDED
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED))
      events.clear()
      liveWindowDurationUs = 65_000_000L
      Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
      assertTrue("tick must stop once stream ends", events.none { it["type"] == "clock" })

      var ringWindow: RingBufferTimeShiftWindow? = RingBufferTimeShiftWindow(0L, 5_000L, 5_000L)
      player.state = Player.STATE_READY
      player.playing = false
      player.wantPlay = false
      player.scriptedSeekable = false
      player.scriptedTimeline = Timeline.EMPTY
      player.scriptedPosition = 5_000L
      player.scriptedDuration = C.TIME_UNSET
      reporter.begin(
        player,
        live = true,
        prepareSerial = 2L,
        reused = false,
        isLiveTs = true,
        ringWindowProvider = { ringWindow },
      )
      events.clear()
      reporter.onEvents(player, eventsFlag(Player.EVENT_PLAYBACK_STATE_CHANGED, Player.EVENT_PLAY_WHEN_READY_CHANGED))
      val pausedRingClock = events.first { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertEquals(true, pausedRingClock["isLiveTs"])
      assertEquals(true, pausedRingClock["timeShiftSupported"])
      assertEquals(0.0, pausedRingClock["liveSeekableStartMs"])
      assertEquals(5_000.0, pausedRingClock["liveEdgeMs"])

      events.clear()
      ringWindow = RingBufferTimeShiftWindow(0L, 6_000L, 6_000L)
      Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(1))
      val pausedRingTick = events.single { it["type"] == "clock" }["anchor"] as Map<*, *>
      assertEquals(6_000.0, pausedRingTick["liveEdgeMs"])

      reporter.end()
      events.clear()
      Shadows.shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(2))
      assertTrue(events.isEmpty())
    } finally {
      real.release()
    }
  }
}

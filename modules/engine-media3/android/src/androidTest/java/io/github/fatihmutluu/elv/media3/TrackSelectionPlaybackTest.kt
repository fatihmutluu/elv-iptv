package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.SubtitleView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Verifies live and VOD multi-audio and embedded subtitle track enumeration, in-place switching without resetting VOD
 * position, cue delivery to `SubtitleView`, and immediate cue clearing on `Subtitles Off` against the local simulator's
 * `h264-2audio-subs-720p25` corpus (`1010.m3u8` WebVTT and `200011.mkv` SRT).
 */
@OptIn(UnstableApi::class)
@RunWith(AndroidJUnit4::class)
class TrackSelectionPlaybackTest {
  private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
  private val simHost: String =
    InstrumentationRegistry.getArguments().getString("simHost") ?: "10.0.2.2:7880"
  private val simAccount: String =
    InstrumentationRegistry.getArguments().getString("simAccount") ?: "corpus"

  @Test
  fun switchesVodMkvAudioWithoutResettingPositionAndTogglesSrtSubtitlesOff() {
    val events = CopyOnWriteArrayList<Map<String, Any?>>()
    val latestCues = AtomicReference<List<Cue>>(emptyList())
    val main = Handler(Looper.getMainLooper())
    val subtitleViewRef = AtomicReference<SubtitleView>()
    val createdView = CountDownLatch(1)
    main.post {
      subtitleViewRef.set(SubtitleView(context))
      createdView.countDown()
    }
    assertTrue(createdView.await(5, TimeUnit.SECONDS))

    val engine = Media3Engine(context)
    engine.eventObserverForTest = { events += it }
    engine.bindView(object : ViewSink {
      override fun onShutter(media: Long, framed: Boolean) = Unit
      override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) = Unit
      override fun onScreenOn(on: Boolean) = Unit
      override fun onCues(cues: List<Cue>) {
        latestCues.set(cues)
        main.post { subtitleViewRef.get()?.setCues(cues) }
      }
    })

    try {
      engine.load(
        1,
        LoadRequest(
          url = "http://${simHost}/movie/${simAccount}/${simAccount}/200011.mkv",
          headers = emptyMap(),
          live = false,
          startMs = 2_000L,
          softwareAudio = false,
        ),
      )

      val initialTracks = awaitTracks(events) { tracks ->
        val audio = tracks["audio"] as? List<*>
        val subs = tracks["subtitles"] as? List<*>
        (audio?.size ?: 0) >= 2 && (subs?.size ?: 0) >= 2
      }
      assertNotNull("expected 2 audio and 2 subtitle tracks on 200011.mkv", initialTracks)
      awaitState(events, "playing")

      @Suppress("UNCHECKED_CAST")
      val audioTracks = initialTracks!!["audio"] as List<Map<String, Any?>>
      @Suppress("UNCHECKED_CAST")
      val subtitleTracks = initialTracks["subtitles"] as List<Map<String, Any?>>
      val englishAudioId = audioTracks.first { it["language"] == "en" }["id"] as String
      val turkishSubId = subtitleTracks.first { it["language"] == "tr" }["id"] as String

      // Switch audio to English and verify VOD position stays >= 1,500 ms (never restarts from 0)
      engine.selectAudioTrack(2, englishAudioId)
      val switchedAudio = awaitTracks(events) { it["selectedAudioId"] == englishAudioId }
      assertNotNull("expected selectedAudioId=$englishAudioId", switchedAudio)

      val anchorAfterSwitch = awaitClockPositionMs(events, minAttempt = 2)
      assertTrue("expected VOD position >= 1500ms after audio switch, got $anchorAfterSwitch", anchorAfterSwitch >= 1_500.0)

      // Enable Turkish SRT subtitles and wait for non-empty cues
      engine.selectSubtitleTrack(3, turkishSubId)
      val switchedSub = awaitTracks(events) { it["selectedSubtitleId"] == turkishSubId }
      assertNotNull("expected selectedSubtitleId=$turkishSubId", switchedSub)

      val cueDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
      while (latestCues.get().isEmpty() && System.nanoTime() < cueDeadline) {
        Thread.sleep(100)
      }
      assertTrue("expected non-empty SRT cues on 200011.mkv", latestCues.get().isNotEmpty())

      // Turn subtitles Off (null): selectedSubtitleId becomes null and cues clear immediately
      engine.selectSubtitleTrack(4, null)
      val subOff = awaitTracks(events, minAttempt = 4) { it["selectedSubtitleId"] == null }
      assertNotNull("expected selectedSubtitleId=null after Off", subOff)
      assertNull(subOff!!["selectedSubtitleId"])
      assertTrue("expected cues cleared after Off", latestCues.get().isEmpty())
    } finally {
      engine.dispose()
    }
  }

  @Test
  fun enumeratesLiveTsMultiAudioAndHlsWebVttSubtitles() {
    val tsEvents = CopyOnWriteArrayList<Map<String, Any?>>()
    val tsEngine = Media3Engine(context)
    tsEngine.eventObserverForTest = { tsEvents += it }
    try {
      tsEngine.load(
        1,
        LoadRequest(
          url = "http://${simHost}/live/${simAccount}/${simAccount}/1010.ts",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
        ),
      )
      val tsTracks = awaitTracks(tsEvents) { snapshot ->
        val audio = snapshot["audio"] as? List<*>
        (audio?.size ?: 0) >= 2
      }
      assertNotNull("expected 2 live MPEG-TS audio tracks on 1010.ts", tsTracks)
      @Suppress("UNCHECKED_CAST")
      val tsAudio = tsTracks!!["audio"] as List<Map<String, Any?>>
      assertEquals(setOf("tr", "en"), tsAudio.mapNotNull { it["language"] as? String }.toSet())
    } finally {
      tsEngine.dispose()
    }

    val hlsEvents = CopyOnWriteArrayList<Map<String, Any?>>()
    val hlsCues = AtomicReference<List<Cue>>(emptyList())
    val hlsEngine = Media3Engine(context)
    hlsEngine.eventObserverForTest = { hlsEvents += it }
    hlsEngine.bindView(object : ViewSink {
      override fun onShutter(media: Long, framed: Boolean) = Unit
      override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) = Unit
      override fun onScreenOn(on: Boolean) = Unit
      override fun onCues(cues: List<Cue>) {
        hlsCues.set(cues)
      }
    })
    try {
      hlsEngine.load(
        1,
        LoadRequest(
          url = "http://${simHost}/live/${simAccount}/${simAccount}/1010.m3u8",
          headers = emptyMap(),
          live = true,
          startMs = null,
          softwareAudio = false,
        ),
      )
      val tracks = awaitTracks(hlsEvents) { snapshot ->
        val audio = snapshot["audio"] as? List<*>
        val subs = snapshot["subtitles"] as? List<*>
        (audio?.size ?: 0) >= 1 && (subs?.size ?: 0) >= 2
      }
      assertNotNull("expected audio and 2 WebVTT subtitle tracks on 1010.m3u8", tracks)
      @Suppress("UNCHECKED_CAST")
      val subs = tracks!!["subtitles"] as List<Map<String, Any?>>
      assertEquals(setOf("tr", "en"), subs.mapNotNull { it["language"] as? String }.toSet())

      val englishSubId = subs.first { it["language"] == "en" }["id"] as String
      hlsEngine.selectSubtitleTrack(2, englishSubId)
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15)
      while (hlsCues.get().isEmpty() && System.nanoTime() < deadline) {
        Thread.sleep(100)
      }
      assertTrue("expected non-empty WebVTT cues on 1010.m3u8", hlsCues.get().isNotEmpty())
      hlsEngine.selectSubtitleTrack(3, null)
      val clearedDeadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5)
      while (hlsCues.get().isNotEmpty() && System.nanoTime() < clearedDeadline) {
        Thread.sleep(50)
      }
      assertTrue("expected WebVTT cues cleared on Off", hlsCues.get().isEmpty())
    } finally {
      hlsEngine.dispose()
    }
  }

  @Suppress("UNCHECKED_CAST")
  private fun awaitTracks(
    events: List<Map<String, Any?>>,
    minAttempt: Int = 1,
    predicate: (Map<String, Any?>) -> Boolean,
  ): Map<String, Any?>? {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25)
    while (System.nanoTime() < deadline) {
      val error = events.firstOrNull { it["type"] == "error" }
      if (error != null) throw AssertionError("unexpected playback error: $error")
      val match = events
        .asReversed()
        .firstOrNull {
          it["type"] == "tracks" &&
            (it["attempt"] as? Int ?: 0) >= minAttempt &&
            predicate(it["tracks"] as Map<String, Any?>)
        }
      if (match != null) return match["tracks"] as Map<String, Any?>
      Thread.sleep(100)
    }
    return null
  }

  private fun awaitState(events: List<Map<String, Any?>>, target: String) {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(25)
    while (System.nanoTime() < deadline) {
      val error = events.firstOrNull { it["type"] == "error" }
      if (error != null) throw AssertionError("unexpected playback error: $error")
      if (events.any { it["type"] == "state" && it["state"] == target }) return
      Thread.sleep(100)
    }
    throw AssertionError("timed out waiting for state=$target; events=$events")
  }

  @Suppress("UNCHECKED_CAST")
  private fun awaitClockPositionMs(events: List<Map<String, Any?>>, minAttempt: Int): Double {
    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
    while (System.nanoTime() < deadline) {
      val clock = events.asReversed().firstOrNull {
        it["type"] == "clock" && (it["attempt"] as? Int ?: 0) >= minAttempt
      }
      if (clock != null) {
        val anchor = clock["anchor"] as Map<String, Any?>
        return anchor["positionMs"] as Double
      }
      Thread.sleep(100)
    }
    throw AssertionError("timed out waiting for clock anchor on attempt >= $minAttempt")
  }
}

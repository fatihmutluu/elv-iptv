package io.github.fatihmutluu.elv.media3

import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RendererCapabilities
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
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
class DualSubtitlesTest {
  private fun group(
    id: String,
    formats: List<Format>,
    selectedIndex: Int = -1,
    supported: IntArray = IntArray(formats.size) { C.FORMAT_HANDLED },
  ): Tracks.Group {
    val selected = BooleanArray(formats.size) { it == selectedIndex }
    return Tracks.Group(TrackGroup(id, *formats.toTypedArray()), false, supported, selected)
  }

  private val videoGroup = group(
    "v",
    listOf(Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setWidth(1920).setHeight(1080).build()),
    selectedIndex = 0,
  )

  private val textGroup = group(
    "s",
    listOf(
      Format.Builder()
        .setId("sub-tr")
        .setSampleMimeType(MimeTypes.APPLICATION_SUBRIP)
        .setLanguage("tur")
        .setLabel("Turkish")
        .build(),
      Format.Builder()
        .setId("sub-en")
        .setSampleMimeType(MimeTypes.TEXT_VTT)
        .setLanguage("eng")
        .setLabel("English")
        .build(),
      Format.Builder()
        .setId("ext:de-1")
        .setSampleMimeType(MimeTypes.APPLICATION_SUBRIP)
        .setLanguage("deu")
        .setLabel("German External")
        .build(),
    ),
    selectedIndex = 0,
  )

  @Test
  fun `enforces primary != secondary collision guard, reports selectedSecondarySubtitleId and external flag (#402)`() {
    val emitted = mutableListOf<Map<String, Any?>>()
    var primaryCleared = 0
    var secondaryCleared = 0
    var lastSecondaryTarget: TrackChoice? = null
    val bridge = TrackSelectorBridge(
      onTracks = { emitted += it },
      onClearCues = { primaryCleared += 1 },
      onClearSecondaryCues = { secondaryCleared += 1 },
      onSecondaryTargetChanged = { target, _ -> lastSecondaryTarget = target },
    )
    val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
    try {
      val tracks = Tracks(listOf(videoGroup, textGroup))
      bridge.onTracksChanged(player, tracks)
      assertEquals("1:0", emitted.last()["selectedSubtitleId"])
      assertNull(emitted.last()["selectedSecondarySubtitleId"])

      // External track keeps stable ext:de-1 ID and external=true flag
      @Suppress("UNCHECKED_CAST")
      val subs = emitted.last()["subtitles"] as List<Map<String, Any>>
      val extEntry = subs.first { it["id"] == "ext:de-1" }
      assertEquals(true, extEntry["external"])

      // Selecting secondary equal to primary ("1:0") is rejected/cleared!
      bridge.selectSecondarySubtitleTrack(player, "1:0")
      assertNull("secondary equal to primary must be rejected", bridge.selectedSecondarySubtitleId)
      assertNull(lastSecondaryTarget)
      assertEquals(1, secondaryCleared)

      // Selecting distinct secondary ("1:1") succeeds and emits selectedSecondarySubtitleId
      bridge.selectSecondarySubtitleTrack(player, "1:1")
      assertEquals("1:1", bridge.selectedSecondarySubtitleId)
      assertEquals("1:1", lastSecondaryTarget?.id)
      assertEquals("1:1", emitted.last()["selectedSecondarySubtitleId"])

      // Switching primary to equal active secondary ("1:1") clears secondary automatically!
      bridge.selectSubtitleTrack(player, "1:1")
      assertNull("selecting primary equal to secondary must clear secondary", bridge.selectedSecondarySubtitleId)
      assertNull(lastSecondaryTarget)
      assertNull(emitted.last()["selectedSecondarySubtitleId"])

      // Selecting external track "ext:de-1" as secondary works cleanly
      bridge.selectSecondarySubtitleTrack(player, "ext:de-1")
      assertEquals("ext:de-1", bridge.selectedSecondarySubtitleId)
      assertEquals("ext:de-1", emitted.last()["selectedSecondarySubtitleId"])

      // Stopping clears secondary selection completely
      bridge.onStop()
      assertNull(bridge.selectedSecondarySubtitleId)
      assertNull(lastSecondaryTarget)
    } finally {
      player.release()
    }
  }

  @Test
  fun `SecondarySubtitleController delivers non-overlapping top secondary cues honoring delay and SDH filter (#402)`() {
    val delivered = mutableListOf<List<Cue>>()
    val controller = SecondarySubtitleController(onSecondaryCues = { delivered += it })

    // Renderer-delivered secondary cues honor SDH filtering, subtitleDelayMs, and top anchoring
    controller.onRendererCues(
      positionUs = 5_000_000L,
      rawCues = listOf(Cue.Builder().setText("[music] Hello secondary").build()),
      filterSdh = true,
    )
    controller.resolveAndDeliverSecondary(positionMs = 5_000L, activeSecondaryId = "1:1", filterSdh = true)
    assertEquals(1, delivered.size)
    val topCue = delivered.last().single()
    assertEquals("Hello secondary", topCue.text.toString())
    assertEquals(SECONDARY_SUBTITLE_TOP_LINE_FRACTION, topCue.line, 0.0001f)
    assertEquals(Cue.LINE_TYPE_FRACTION, topCue.lineType)
    assertEquals(Cue.ANCHOR_TYPE_START, topCue.lineAnchor)

    // Adjusting subtitleDelayMs shifts cue visibility without clearing buffered entries
    controller.setDelayMs(2_000L)
    controller.resolveAndDeliverSecondary(positionMs = 6_000L, activeSecondaryId = "1:1", filterSdh = true)
    assertTrue("At 6s with +2s delay, 5s cue should not be active yet", delivered.last().isEmpty())
    controller.resolveAndDeliverSecondary(positionMs = 7_500L, activeSecondaryId = "1:1", filterSdh = true)
    assertEquals("Hello secondary", delivered.last().single().text.toString())

    // Dynamic sidecar track renders as secondary and clears on resetAll()
    val extCfg = ExternalSubtitleConfig(id = "es-1", uri = "https://subs.example/es.srt", label = "Spanish", language = "es")
    assertTrue(controller.registerExternalTrack(extCfg))
    assertFalse("duplicate external track registration is ignored", controller.registerExternalTrack(extCfg))
    controller.storeSidecarCues(
      "ext:es-1",
      listOf(TimedSidecarCue(startMs = 10_000L, endMs = 14_000L, text = "Hola mundo")),
    )
    controller.setDelayMs(0L)
    controller.resolveAndDeliverSecondary(positionMs = 12_000L, activeSecondaryId = "ext:es-1", filterSdh = false)
    assertEquals("Hola mundo", delivered.last().single().text.toString())
    assertEquals(SECONDARY_SUBTITLE_TOP_LINE_FRACTION, delivered.last().single().line, 0.0001f)

    // Clearing on stop/zap empties visible secondary cues and sidecars
    controller.resetAll()
    assertTrue(delivered.last().isEmpty())
    assertFalse(controller.hasActiveSidecars)
  }

  @Test
  fun `SecondaryTextRenderer keeps primary TrackGroup mapping intact and DualSubtitleTrackSelector excludes primary (#402)`() {
    val secondary = SecondaryTextRenderer(output = {}, outputLooper = Looper.getMainLooper())
    val srtFormat = Format.Builder().setSampleMimeType(MimeTypes.APPLICATION_SUBRIP).build()
    assertEquals(
      "SecondaryTextRenderer must downgrade FORMAT_HANDLED to FORMAT_EXCEEDS_CAPABILITIES",
      C.FORMAT_EXCEEDS_CAPABILITIES,
      RendererCapabilities.getFormatSupport(secondary.capabilities.supportsFormat(srtFormat)),
    )

    val selector = DualSubtitleTrackSelector(RuntimeEnvironment.getApplication())
    val tg = textGroup.mediaTrackGroup
    val groups = TrackGroupArray(tg)
    val primaryDef = ExoTrackSelection.Definition(tg, 0)

    // Asking for the same track as primary (Turkish, index 0) returns null
    assertNull(
      selector.findSecondaryDefinition(
        groups,
        TrackChoice(id = "1:0", language = "tr", label = "Turkish", formatId = "sub-tr"),
        primaryDef,
      )
    )

    // Asking for English (index 1) resolves cleanly to index 1
    val enDef = selector.findSecondaryDefinition(
      groups,
      TrackChoice(id = "1:1", language = "en", label = "English", formatId = "sub-en"),
      primaryDef,
    )
    assertNotNull(enDef)
    assertEquals(1, enDef!!.tracks.single())

    // Asking for external track ext:de-1 (index 2) resolves cleanly by stable formatId
    val extDef = selector.findSecondaryDefinition(
      groups,
      TrackChoice(id = "ext:de-1", language = "de", label = "German External", formatId = "ext:de-1"),
      primaryDef,
    )
    assertNotNull(extDef)
    assertEquals(2, extDef!!.tracks.single())
  }

  @Test
  fun `Media3Engine supports dynamic mid-playback addExternalSubtitle and dual cue clearing on stop (#32, #402)`() {
    val tempSrt = File.createTempFile("elv-dyn-", ".srt")
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    val events = CopyOnWriteArrayList<Map<String, Any?>>()
    val secondaryHistory = CopyOnWriteArrayList<List<Cue>>()
    engine.eventObserverForTest = { events += it }
    try {
      tempSrt.writeText("1\n00:00:00,000 --> 00:05:00,000\nDynamic Sidecar Cue\n")
      engine.bindView(object : ViewSink {
        override fun onShutter(media: Long, framed: Boolean) = Unit
        override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) = Unit
        override fun onScreenOn(on: Boolean) = Unit
        override fun onSecondaryCues(cues: List<Cue>) {
          secondaryHistory += cues
        }
      })
      engine.load(1, LoadRequest("http://127.0.0.1:9/movie/1.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))
      engine.addExternalSubtitle(
        1,
        ExternalSubtitleConfig(id = "dyn-1", uri = android.net.Uri.fromFile(tempSrt).toString(), label = "Dynamic SRT", language = "en"),
      )
      engine.selectSecondarySubtitleTrack(1, "ext:dyn-1")

      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3)
      while (events.none { it["type"] == "tracks" } && System.nanoTime() < deadline) {
        Thread.sleep(15)
      }
      val trackEvent = events.lastOrNull { it["type"] == "tracks" }
      assertNotNull("addExternalSubtitle must emit tracks event with external track", trackEvent)
      @Suppress("UNCHECKED_CAST")
      val tracksMap = trackEvent!!["tracks"] as Map<String, Any?>
      @Suppress("UNCHECKED_CAST")
      val subtitles = tracksMap["subtitles"] as List<Map<String, Any>>
      assertTrue(subtitles.any { it["id"] == "ext:dyn-1" && it["external"] == true })
      assertEquals("ext:dyn-1", tracksMap["selectedSecondarySubtitleId"])

      // Stopping clears secondary cues cleanly
      engine.stop(2)
      val synced = CountDownLatch(1)
      val handler = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }.get(engine) as android.os.Handler
      handler.post { synced.countDown() }
      assertTrue(synced.await(3, TimeUnit.SECONDS))
      assertTrue(secondaryHistory.lastOrNull().orEmpty().isEmpty())
    } finally {
      engine.dispose()
      tempSrt.delete()
    }
  }
}

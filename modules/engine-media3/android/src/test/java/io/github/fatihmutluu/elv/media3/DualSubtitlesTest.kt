package io.github.fatihmutluu.elv.media3

import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.Timeline
import androidx.media3.common.TrackGroup
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.text.Cue
import androidx.media3.common.text.CueGroup
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RendererCapabilities
import androidx.media3.exoplayer.source.MediaSource
import androidx.media3.exoplayer.source.TrackGroupArray
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.exoplayer.trackselection.ExoTrackSelection
import androidx.media3.exoplayer.upstream.DefaultBandwidthMeter
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

  @Test
  fun `secondary track index preceding primary track index preserves both primary and secondary selections (#402)`() {
    val audioGroup = group(
      "a",
      listOf(Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("eng").build()),
      selectedIndex = 0,
    )
    // Both 2:0 (secondary) and 2:1 (primary) are selected simultaneously by dual Media3 text renderers.
    val dualTextGroup = Tracks.Group(
      TrackGroup(
        "s-dual",
        Format.Builder().setId("sub-tr").setSampleMimeType(MimeTypes.APPLICATION_SUBRIP).setLanguage("tur").setLabel("Turkish").build(),
        Format.Builder().setId("sub-en").setSampleMimeType(MimeTypes.TEXT_VTT).setLanguage("eng").setLabel("English").build(),
      ),
      false,
      intArrayOf(C.FORMAT_HANDLED, C.FORMAT_HANDLED),
      booleanArrayOf(true, true),
    )
    val dualTracks = Tracks(listOf(videoGroup, audioGroup, dualTextGroup))

    // 1) inspectMediaTracks excludes selectedSecondarySubtitleId ("2:0") so "2:1" remains primary.
    val snapshot = inspectMediaTracks(
      dualTracks,
      textDisabled = false,
      selectedSecondarySubtitleId = "2:0",
    )
    assertEquals("primary must resolve to 2:1 when 2:0 is secondary", "2:1", snapshot.selectedSubtitleId)
    assertEquals("secondary 2:0 must not be wiped", "2:0", snapshot.selectedSecondarySubtitleId)

    // 2) TrackSelectorBridge with SubChoice.Default (primary 2:1) + secondary 2:0 survives onTracksChanged
    val emitted = mutableListOf<Map<String, Any?>>()
    val bridge = TrackSelectorBridge(
      onTracks = { emitted += it },
      onClearCues = {},
    )
    val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
    try {
      val initialPrimary1 = Tracks.Group(
        dualTextGroup.mediaTrackGroup,
        false,
        intArrayOf(C.FORMAT_HANDLED, C.FORMAT_HANDLED),
        booleanArrayOf(false, true),
      )
      bridge.onTracksChanged(player, Tracks(listOf(videoGroup, audioGroup, initialPrimary1)))
      assertEquals("2:1", emitted.last()["selectedSubtitleId"])

      // Pick earlier index 2:0 as secondary while primary stays Default (2:1)
      bridge.selectSecondarySubtitleTrack(player, "2:0")
      assertEquals("2:0", bridge.selectedSecondarySubtitleId)

      // Now Media3 reports both 2:0 and 2:1 as selected in onTracksChanged
      bridge.onTracksChanged(player, dualTracks)
      assertEquals("secondary 2:0 must survive onTracksChanged when primary is Default 2:1", "2:0", bridge.selectedSecondarySubtitleId)
      assertEquals("2:1", emitted.last()["selectedSubtitleId"])
      assertEquals("2:0", emitted.last()["selectedSecondarySubtitleId"])
    } finally {
      player.release()
    }
  }

  @Test
  fun `DualSubtitleTrackSelector binds SecondaryTextRenderer with extra text renderer ahead and matches group-track fallback (#402)`() {
    fun stubCaps(name: String, trackType: Int, handledMime: String?): RendererCapabilities =
      object : RendererCapabilities {
        override fun getName(): String = name
        override fun getTrackType(): Int = trackType
        override fun supportsFormat(format: Format): Int =
          if (handledMime != null && format.sampleMimeType == handledMime) {
            RendererCapabilities.create(C.FORMAT_HANDLED)
          } else {
            RendererCapabilities.create(C.FORMAT_UNSUPPORTED_TYPE)
          }
        override fun supportsMixedMimeTypeAdaptation(): Int = RendererCapabilities.ADAPTIVE_NOT_SUPPORTED
      }

    val context = RuntimeEnvironment.getApplication()
    val secondaryRenderer = SecondaryTextRenderer(output = {}, outputLooper = Looper.getMainLooper())
    assertEquals(
      "SecondaryTextRenderer capabilities must expose SecondaryTextRenderer name",
      "SecondaryTextRenderer",
      secondaryRenderer.capabilities.name,
    )

    val selector = DualSubtitleTrackSelector(context)
    selector.init({}, DefaultBandwidthMeter.Builder(context).build())

    // Simulate AssRenderersFactory inserting an extra C.TRACK_TYPE_TEXT renderer ahead of SecondaryTextRenderer:
    // 0: Video, 1: Audio, 2: AssExtraText (unmatched MIME), 3: PrimaryText, 4: SecondaryTextRenderer
    val caps = arrayOf(
      stubCaps("VideoRenderer", C.TRACK_TYPE_VIDEO, MimeTypes.VIDEO_H264),
      stubCaps("AudioRenderer", C.TRACK_TYPE_AUDIO, MimeTypes.AUDIO_AAC),
      stubCaps("AssExtraTextRenderer", C.TRACK_TYPE_TEXT, MimeTypes.TEXT_SSA),
      stubCaps("PrimaryTextRenderer", C.TRACK_TYPE_TEXT, MimeTypes.APPLICATION_SUBRIP),
      secondaryRenderer.capabilities,
    )
    // Two unnamed subtitle tracks with null id, language, and label — only distinguishable by group:track!
    val unnamedGroup = TrackGroup(
      "s-unnamed",
      Format.Builder()
        .setSampleMimeType(MimeTypes.APPLICATION_SUBRIP)
        .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
        .build(),
      Format.Builder().setSampleMimeType(MimeTypes.APPLICATION_SUBRIP).build(),
    )
    val trackGroups = TrackGroupArray(
      TrackGroup("v", Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).build()),
      TrackGroup("a", Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).build()),
      unnamedGroup,
    )

    // Global group indices: 0=video, 1=audio, 2=unnamedGroup -> track 0 is "2:0" (primary), track 1 is "2:1" (secondary).
    selector.setSecondarySelection(
      TrackChoice(id = "2:1", language = null, label = null, formatId = null),
      primaryDisabled = false,
    )
    val result = selector.selectTracks(
      caps,
      trackGroups,
      MediaSource.MediaPeriodId(Object()),
      Timeline.EMPTY,
    )
    assertNull("extra text renderer slot 2 must not be assigned secondary selection", result.selections[2])
    assertNotNull("primary text renderer slot 3 must keep primary track", result.selections[3])
    assertEquals(0, result.selections[3]!!.getIndexInTrackGroup(0))
    assertNotNull("SecondaryTextRenderer slot 4 must receive secondary selection by group:track fallback", result.selections[4])
    assertEquals(1, result.selections[4]!!.getIndexInTrackGroup(0))

    // Direct findSecondaryDefinition also matches identical language/label tracks via group:track fallback
    val identicalGroup = TrackGroup(
      "s-ident",
      Format.Builder().setSampleMimeType(MimeTypes.APPLICATION_SUBRIP).setLanguage("eng").setLabel("English").build(),
      Format.Builder().setSampleMimeType(MimeTypes.APPLICATION_SUBRIP).setLanguage("eng").setLabel("English").build(),
      Format.Builder().setSampleMimeType(MimeTypes.APPLICATION_SUBRIP).setLanguage("eng").setLabel("English").build(),
    )
    val picked = selector.findSecondaryDefinition(
      TrackGroupArray(identicalGroup),
      TrackChoice(id = "0:2", language = "en", label = "English", formatId = null),
      ExoTrackSelection.Definition(identicalGroup, 0),
    )
    assertNotNull(picked)
    assertEquals("must pick exact group:track index 2 among identical English tracks", 2, picked!!.tracks.single())
  }

  @Test
  fun `Media3Engine selectSubtitleTrack preserves active secondary cues when toggling or disabling primary (#402)`() {
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    val primaryHistory = CopyOnWriteArrayList<List<Cue>>()
    val secondaryHistory = CopyOnWriteArrayList<List<Cue>>()
    try {
      engine.bindView(object : ViewSink {
        override fun onShutter(media: Long, framed: Boolean) = Unit
        override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) = Unit
        override fun onScreenOn(on: Boolean) = Unit
        override fun onCues(cues: List<Cue>) {
          primaryHistory += cues
        }
        override fun onSecondaryCues(cues: List<Cue>) {
          secondaryHistory += cues
        }
      })
      val handler = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }.get(engine) as android.os.Handler
      val secondarySubs = Media3Engine::class.java.getDeclaredField("secondarySubs").apply { isAccessible = true }.get(engine) as SecondarySubtitleController
      val tracksBridge = Media3Engine::class.java.getDeclaredField("tracksBridge").apply { isAccessible = true }.get(engine) as TrackSelectorBridge
      val fence = Media3Engine::class.java.getDeclaredField("fence").apply { isAccessible = true }.get(engine) as PrepareFence
      val secondaryTextOutput = Media3Engine::class.java.getDeclaredField("secondaryTextOutput").apply { isAccessible = true }.get(engine) as TextOutput

      engine.load(1, LoadRequest("http://127.0.0.1:9/movie/1.mp4", emptyMap(), live = false, startMs = 0L, softwareAudio = false))

      val setupDone = CountDownLatch(1)
      handler.post {
        // Open renderer fence and select embedded secondary track "1:1" with active secondary cue
        val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }.get(engine) as ExoPlayer
        val preparesField = Media3Engine::class.java.getDeclaredField("prepares").apply { isAccessible = true }.get(engine) as Long
        fence.passed(preparesField)
        tracksBridge.onTracksChanged(playerField, Tracks(listOf(videoGroup, textGroup)))
        tracksBridge.selectSecondarySubtitleTrack(playerField, "1:1")
        secondaryTextOutput.onCues(CueGroup(listOf(Cue.Builder().setText("Keep me visible").build()), 0L))
        setupDone.countDown()
      }
      assertTrue(setupDone.await(3, TimeUnit.SECONDS))
      assertEquals(
        "secondary cue must be active before turning off primary",
        "Keep me visible",
        secondaryHistory.lastOrNull()?.singleOrNull()?.text?.toString(),
      )

      // Turn off primary subtitles: primary clears, but active secondary cues MUST stay visible!
      val beforeDisableCount = secondaryHistory.size
      engine.selectSubtitleTrack(1, null)
      val afterDisable = CountDownLatch(1)
      handler.post { afterDisable.countDown() }
      assertTrue(afterDisable.await(3, TimeUnit.SECONDS))

      assertTrue("secondary buffer must remain populated after primary off", secondarySubs.isSecondaryBufferNotEmpty)
      val emittedAfterPrimaryOff = secondaryHistory.subList(beforeDisableCount, secondaryHistory.size)
      assertTrue(
        "turning off primary subtitle must NEVER wipe active secondary cues; emittedAfterPrimaryOff=$emittedAfterPrimaryOff",
        emittedAfterPrimaryOff.none { it.isEmpty() },
      )
      assertEquals("Keep me visible", secondaryHistory.last().single().text.toString())
    } finally {
      engine.dispose()
    }
  }
}

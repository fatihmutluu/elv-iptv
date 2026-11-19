package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class TrackSelectorBridgeTest {
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
    listOf(Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setWidth(1280).setHeight(720).build()),
    selectedIndex = 0,
  )

  private val audioGroup = group(
    "a",
    listOf(
      Format.Builder()
        .setSampleMimeType(MimeTypes.AUDIO_AAC)
        .setCodecs("mp4a.40.2")
        .setLanguage("tur")
        .setLabel("Turkish")
        .setChannelCount(2)
        .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
        .build(),
      Format.Builder()
        .setSampleMimeType(MimeTypes.AUDIO_AAC)
        .setCodecs("mp4a.40.2")
        .setLanguage("eng")
        .setLabel("English")
        .setChannelCount(6)
        .build(),
    ),
    selectedIndex = 0,
  )

  private val textGroup = group(
    "s",
    listOf(
      Format.Builder()
        .setSampleMimeType(MimeTypes.APPLICATION_SUBRIP)
        .setLanguage("tur")
        .setLabel("Turkish SRT")
        .setSelectionFlags(C.SELECTION_FLAG_FORCED)
        .build(),
      Format.Builder()
        .setSampleMimeType(MimeTypes.TEXT_VTT)
        .setLanguage("eng")
        .setLabel("English VTT")
        .build(),
    ),
    selectedIndex = 0,
  )

  @Test
  fun `enumerates audio and text tracks with groupIndex-trackIndex IDs and active selections`() {
    val tracks = Tracks(listOf(videoGroup, audioGroup, textGroup))
    val snapshot = inspectMediaTracks(tracks, textDisabled = false)
    assertEquals("1:0", snapshot.selectedAudioId)
    assertEquals("2:0", snapshot.selectedSubtitleId)
    assertEquals(2, snapshot.audio.size)
    assertEquals(
      TrackInfoSnapshot(
        id = "1:0",
        language = "tr",
        label = "Turkish",
        codec = "mp4a.40.2",
        channels = 2,
        forced = false,
        isDefault = true,
      ),
      snapshot.audio[0],
    )
    assertEquals("1:1", snapshot.audio[1].id)
    assertEquals("en", snapshot.audio[1].language)
    assertEquals(6, snapshot.audio[1].channels)
    assertEquals(2, snapshot.subtitles.size)
    assertTrue(snapshot.subtitles[0].forced)
    assertEquals("2:1", snapshot.subtitles[1].id)

    val disabledSnapshot = inspectMediaTracks(tracks, textDisabled = true)
    assertNull(disabledSnapshot.selectedSubtitleId)

    // Actively selected FORMAT_EXCEEDS_CAPABILITIES audio must be included, while unselected unsupported stays hidden
    val exceedsAudioGroup = group(
      "a-exceeds",
      listOf(
        Format.Builder().setSampleMimeType(MimeTypes.AUDIO_E_AC3).setLanguage("eng").setChannelCount(8).build(),
        Format.Builder().setSampleMimeType(MimeTypes.AUDIO_DTS).setLanguage("deu").build(),
      ),
      selectedIndex = 0,
      supported = intArrayOf(C.FORMAT_EXCEEDS_CAPABILITIES, C.FORMAT_EXCEEDS_CAPABILITIES),
    )
    val exceedsSnapshot = inspectMediaTracks(Tracks(listOf(videoGroup, exceedsAudioGroup)), textDisabled = false)
    assertEquals(listOf("1:0"), exceedsSnapshot.audio.map { it.id })
    assertEquals("1:0", exceedsSnapshot.selectedAudioId)
  }

  @Test
  fun `ignores Tracks EMPTY, preserves active subtitle cues on re-select, guards unmatched IDs and reconciles swapped labels`() {
    val emitted = mutableListOf<Map<String, Any?>>()
    var clearedCues = 0
    val bridge = TrackSelectorBridge(
      onTracks = { emitted += it },
      onClearCues = { clearedCues += 1 },
    )
    val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
    try {
      // Transient Tracks.EMPTY on setMediaSource must be ignored
      bridge.onTracksChanged(player, Tracks.EMPTY)
      assertTrue("Tracks.EMPTY must never emit", emitted.isEmpty())

      val initialTracks = Tracks(listOf(videoGroup, audioGroup, textGroup))
      bridge.onTracksChanged(player, initialTracks)
      assertEquals(1, emitted.size)

      // Re-selecting the ALREADY active subtitle ("2:0") must NOT clear active cues!
      bridge.selectSubtitleTrack(player, "2:0")
      assertEquals("re-selecting active subtitle must keep visible cues", 0, clearedCues)

      // Switching to a DIFFERENT subtitle ("2:1") DOES clear stale cues
      bridge.selectSubtitleTrack(player, "2:1")
      assertEquals(1, clearedCues)

      // Unmatched audio/subtitle IDs must be ignored without wiping overrides or clearing cues
      bridge.selectAudioTrack(player, "1:1")
      val savedAudioOverride = player.trackSelectionParameters.overrides[audioGroup.mediaTrackGroup]?.trackIndices
      assertEquals(listOf(1), savedAudioOverride)

      bridge.selectAudioTrack(player, "99:99")
      assertEquals(
        "unmatched audio ID must not clear active override",
        listOf(1),
        player.trackSelectionParameters.overrides[audioGroup.mediaTrackGroup]?.trackIndices,
      )

      bridge.selectSubtitleTrack(player, null)
      assertEquals(2, clearedCues)
      assertTrue(player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))

      bridge.selectSubtitleTrack(player, "99:99")
      assertTrue(
        "unmatched subtitle ID must not re-enable disabled subtitles",
        player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT),
      )
      assertEquals("unmatched subtitle ID must not clear cues", 2, clearedCues)

      // Same-language tracks swapping order must follow label, and BCP-47 region tags match ISO 639-2
      val dualEnglish = group(
        "a-dual",
        listOf(
          Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("en-US").setLabel("Commentary").build(),
          Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("en-US").setLabel("Main").build(),
        ),
        selectedIndex = 0,
      )
      bridge.onTracksChanged(player, Tracks(listOf(videoGroup, dualEnglish)))
      bridge.selectAudioTrack(player, "1:1") // Pick "Main"

      bridge.onPrepareReuse()
      val swappedDualEnglish = group(
        "a-dual-swapped",
        listOf(
          Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("eng").setLabel("Main").build(),
          Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("eng").setLabel("Commentary").build(),
        ),
        selectedIndex = 1,
      )
      bridge.onTracksChanged(player, Tracks(listOf(videoGroup, swappedDualEnglish)))
      assertEquals(
        "must pick swapped index 0 ('Main') instead of keeping stale index 1 ('Commentary')",
        listOf(0),
        player.trackSelectionParameters.overrides[swappedDualEnglish.mediaTrackGroup]?.trackIndices,
      )
      assertTrue(sameLanguage("tr", "tur"))
      assertTrue(sameLanguage("deu", "ger"))
      assertTrue(sameLanguage("en-US", "eng"))
      assertFalse(sameLanguage("und", "und"))

      // Reloading a new media with Default subtitle preference restores CaptioningManager accessibility defaults
      val (_, defaultReq) = parseLoadArgs(mapOf("attempt" to 9, "url" to "http://h/2.mkv", "kind" to "vod"))
      bridge.onLoad(defaultReq)
      bridge.applyInitialParameters(player)
      assertTrue(player.trackSelectionParameters.usePreferredTextLanguagesAndRoleFlagsFromCaptioningManager)
      assertFalse(player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))
    } finally {
      player.release()
    }
  }

  @Test
  fun `selects audio and subtitle overrides and falls back by language and label across reloads`() {
    val emitted = mutableListOf<Map<String, Any?>>()
    var clearedCues = 0
    val bridge = TrackSelectorBridge(
      onTracks = { emitted += it },
      onClearCues = { clearedCues += 1 },
    )
    val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
    try {
      val initialTracks = Tracks(listOf(videoGroup, audioGroup, textGroup))
      bridge.onTracksChanged(player, initialTracks)
      assertEquals(1, emitted.size)

      bridge.selectAudioTrack(player, "1:1")
      val audioOverride = player.trackSelectionParameters.overrides[audioGroup.mediaTrackGroup]
      assertEquals(listOf(1), audioOverride?.trackIndices)

      // Simulate a reload where groups reordered (text before audio, so English audio is now 2:1 instead of 1:1)
      bridge.onPrepareReuse()
      val shiftedAudioGroup = group(
        "a-reloaded",
        listOf(
          Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("tur").setLabel("Turkish").build(),
          Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("eng").setLabel("English").build(),
        ),
        selectedIndex = 0,
      )
      val shiftedTracks = Tracks(listOf(videoGroup, textGroup, shiftedAudioGroup))
      bridge.onTracksChanged(player, shiftedTracks)
      val shiftedOverride = player.trackSelectionParameters.overrides[shiftedAudioGroup.mediaTrackGroup]
      assertEquals(listOf(1), shiftedOverride?.trackIndices)

      // Turning subtitles off disables C.TRACK_TYPE_TEXT and clears cues immediately
      bridge.selectSubtitleTrack(player, null)
      assertTrue(player.trackSelectionParameters.disabledTrackTypes.contains(C.TRACK_TYPE_TEXT))
      assertEquals(1, clearedCues)
    } finally {
      player.release()
    }
  }

  @Test
  fun `parseLoadArgs distinguishes default, null Off, and explicit subtitleTrackId`() {
    val (_, defaultReq) = parseLoadArgs(mapOf("attempt" to 1, "url" to "http://h/1.mkv", "kind" to "vod"))
    assertEquals(SubtitlePreference.Default, defaultReq.subtitlePreference)
    assertNull(defaultReq.audioTrackId)

    val (_, offReq) = parseLoadArgs(
      mapOf(
        "attempt" to 2,
        "url" to "http://h/1.mkv",
        "kind" to "vod",
        "audioTrackId" to "1:1",
        "subtitleTrackId" to null,
      )
    )
    assertEquals(SubtitlePreference.Off, offReq.subtitlePreference)
    assertEquals("1:1", offReq.audioTrackId)

    val (_, selectedReq) = parseLoadArgs(
      mapOf("attempt" to 3, "url" to "http://h/1.mkv", "kind" to "vod", "subtitleTrackId" to "2:0")
    )
    assertEquals(SubtitlePreference.Selected("2:0"), selectedReq.subtitlePreference)
  }

  @Test
  fun `preserves lastVodPositionMs across recreate and retry and clears cues on load, stop and off`() {
    val cuesHistory = CopyOnWriteArrayList<List<Cue>>()
    val engine = Media3Engine(RuntimeEnvironment.getApplication())
    try {
      engine.bindView(object : ViewSink {
        override fun onShutter(media: Long, framed: Boolean) = Unit
        override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) = Unit
        override fun onScreenOn(on: Boolean) = Unit
        override fun onCues(cues: List<Cue>) {
          cuesHistory += cues
        }
      })
      engine.load(
        1,
        LoadRequest(
          url = "http://127.0.0.1:9/movie/demo/demo/1.mp4",
          headers = emptyMap(),
          live = false,
          startMs = 95_000L,
          softwareAudio = false,
        ),
      )
      engine.recreate(2)
      engine.retry(3)
      engine.selectSubtitleTrack(4, null)

      val synced = CountDownLatch(1)
      val handlerField = Media3Engine::class.java.getDeclaredField("handler").apply { isAccessible = true }
      val handler = handlerField.get(engine) as android.os.Handler
      var resumedAt: Long? = null
      handler.post {
        val playerField = Media3Engine::class.java.getDeclaredField("player").apply { isAccessible = true }
        val current = playerField.get(engine) as ExoPlayer?
        resumedAt = current?.currentPosition
        synced.countDown()
      }
      assertTrue(synced.await(5, TimeUnit.SECONDS))
      assertEquals(95_000L, resumedAt)
      assertFalse(cuesHistory.isEmpty())
      assertTrue(cuesHistory.all { it.isEmpty() })
    } finally {
      engine.dispose()
    }
  }
}

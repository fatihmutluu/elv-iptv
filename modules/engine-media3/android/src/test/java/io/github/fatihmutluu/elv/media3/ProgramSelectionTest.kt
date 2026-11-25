package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
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
class ProgramSelectionTest {
  private fun group(
    id: String,
    formats: List<Format>,
    selectedIndex: Int = -1,
    supported: IntArray = IntArray(formats.size) { C.FORMAT_HANDLED },
  ): Tracks.Group {
    val selected = BooleanArray(formats.size) { it == selectedIndex }
    return Tracks.Group(TrackGroup(id, *formats.toTypedArray()), false, supported, selected)
  }

  private fun buildTwoProgramTracks(
    selectedProgram: Int = 1,
  ): Tracks {
    val p1Video = group(
      "v1",
      listOf(
        Format.Builder()
          .setId("1/256")
          .setSampleMimeType(MimeTypes.VIDEO_H264)
          .setWidth(1920)
          .setHeight(1080)
          .setAverageBitrate(5_000_000)
          .build(),
      ),
      selectedIndex = if (selectedProgram == 1) 0 else -1,
    )
    val p1Audio = group(
      "a1",
      listOf(
        Format.Builder()
          .setId("1/257")
          .setSampleMimeType(MimeTypes.AUDIO_AAC)
          .setLanguage("tur")
          .setLabel("Turkish")
          .setChannelCount(2)
          .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
          .build(),
        Format.Builder()
          .setId("1/258")
          .setSampleMimeType(MimeTypes.AUDIO_AAC)
          .setLanguage("eng")
          .setLabel("English")
          .setChannelCount(2)
          .build(),
      ),
      selectedIndex = if (selectedProgram == 1) 0 else -1,
    )
    val p1Text = group(
      "t1",
      listOf(
        Format.Builder()
          .setId("1/259")
          .setSampleMimeType(MimeTypes.APPLICATION_SUBRIP)
          .setLanguage("tur")
          .setLabel("Turkish Sub")
          .build(),
      ),
      selectedIndex = if (selectedProgram == 1) 0 else -1,
    )
    val p2Video = group(
      "v2",
      listOf(
        Format.Builder()
          .setId("2/512")
          .setSampleMimeType(MimeTypes.VIDEO_H264)
          .setWidth(1920)
          .setHeight(1080)
          .setAverageBitrate(5_000_000)
          .build(),
      ),
      selectedIndex = if (selectedProgram == 2) 0 else -1,
    )
    val p2Audio = group(
      "a2",
      listOf(
        Format.Builder()
          .setId("2/513")
          .setSampleMimeType(MimeTypes.AUDIO_AAC)
          .setLanguage("deu")
          .setLabel("German")
          .setChannelCount(2)
          .setSelectionFlags(C.SELECTION_FLAG_DEFAULT)
          .build(),
        Format.Builder()
          .setId("2/514")
          .setSampleMimeType(MimeTypes.AUDIO_AAC)
          .setLanguage("eng")
          .setLabel("English")
          .setChannelCount(6)
          .build(),
      ),
      selectedIndex = if (selectedProgram == 2) 0 else -1,
    )
    val p2Text = group(
      "t2",
      listOf(
        Format.Builder()
          .setId("2/515")
          .setSampleMimeType(MimeTypes.APPLICATION_SUBRIP)
          .setLanguage("deu")
          .setLabel("German Sub")
          .build(),
      ),
      selectedIndex = if (selectedProgram == 2) 0 else -1,
    )
    val extText = group(
      "ext",
      listOf(
        Format.Builder()
          .setId("ext:sidecar-1")
          .setSampleMimeType(MimeTypes.APPLICATION_SUBRIP)
          .setLanguage("eng")
          .setLabel("External EN")
          .build(),
      ),
      selectedIndex = -1,
    )
    return Tracks(listOf(p1Video, p1Audio, p1Text, p2Video, p2Audio, p2Text, extText))
  }

  @Test
  fun `single program and standard tracks omit programs and selectedProgramId`() {
    val regularTracks = Tracks(
      listOf(
        group(
          "v",
          listOf(Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setWidth(1280).setHeight(720).build()),
          selectedIndex = 0,
        ),
        group(
          "a",
          listOf(Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("eng").build()),
          selectedIndex = 0,
        ),
      ),
    )
    val regularSnapshot = inspectMediaTracks(regularTracks, textDisabled = false)
    assertTrue(regularSnapshot.programs.isEmpty())
    assertNull(regularSnapshot.selectedProgramId)
    assertNull(regularSnapshot.audio[0].programId)
    val regularMap = regularSnapshot.toMap()
    assertFalse(regularMap.containsKey("programs"))
    assertFalse(regularMap.containsKey("selectedProgramId"))

    val singleTsProgram = Tracks(
      listOf(
        group(
          "v",
          listOf(Format.Builder().setId("1/256").setSampleMimeType(MimeTypes.VIDEO_H264).setHeight(720).build()),
          selectedIndex = 0,
        ),
        group(
          "a",
          listOf(Format.Builder().setId("1/257").setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("eng").build()),
          selectedIndex = 0,
        ),
        group(
          "ext",
          listOf(Format.Builder().setId("ext:sub-1").setSampleMimeType(MimeTypes.TEXT_VTT).setLanguage("eng").build()),
          selectedIndex = -1,
        ),
      ),
    )
    val singleSnapshot = inspectMediaTracks(singleTsProgram, textDisabled = false)
    assertTrue(singleSnapshot.programs.isEmpty())
    assertNull(singleSnapshot.selectedProgramId)
    assertNull(singleSnapshot.audio[0].programId)
    assertFalse(singleSnapshot.toMap().containsKey("programs"))
  }

  @Test
  fun `extracts multi-program tracks from slash and colon format IDs and group IDs`() {
    val tracks = buildTwoProgramTracks(selectedProgram = 1)
    val snapshot = inspectMediaTracks(tracks, textDisabled = false)

    assertEquals(
      listOf(
        ProgramInfoSnapshot(id = "1", label = "Program 1", programNumber = 1),
        ProgramInfoSnapshot(id = "2", label = "Program 2", programNumber = 2),
      ),
      snapshot.programs,
    )
    assertEquals("1", snapshot.selectedProgramId)
    assertEquals(listOf("1", "1", "2", "2"), snapshot.audio.map { it.programId })
    assertEquals(listOf("1", "2", null), snapshot.subtitles.map { it.programId })
    assertEquals(listOf("1", "2"), snapshot.videoQualities.map { it.programId })

    val map = snapshot.toMap()
    assertNotNull(map["programs"])
    assertEquals("1", map["selectedProgramId"])

    // Colon format IDs (<programNumber>:<pid>)
    val colonTracks = Tracks(
      listOf(
        group(
          "a1",
          listOf(Format.Builder().setId("101:256").setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("tur").build()),
          selectedIndex = -1,
        ),
        group(
          "a2",
          listOf(Format.Builder().setId("102:512").setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("eng").build()),
          selectedIndex = 0,
        ),
      ),
    )
    val colonSnapshot = inspectMediaTracks(colonTracks, textDisabled = false)
    assertEquals(listOf("101", "102"), colonSnapshot.programs.map { it.id })
    assertEquals(listOf(101, 102), colonSnapshot.programs.map { it.programNumber })
    assertEquals("102", colonSnapshot.selectedProgramId)

    // Group ID prefix fallback when Format.id is null
    val groupPrefixTracks = Tracks(
      listOf(
        group(
          "program-10",
          listOf(Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("tur").build()),
          selectedIndex = 0,
        ),
        group(
          "program-20",
          listOf(Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).setLanguage("eng").build()),
          selectedIndex = -1,
        ),
      ),
    )
    val groupPrefixSnapshot = inspectMediaTracks(groupPrefixTracks, textDisabled = false)
    assertEquals(listOf("10", "20"), groupPrefixSnapshot.programs.map { it.id })
    assertEquals("10", groupPrefixSnapshot.selectedProgramId)
  }

  @Test
  fun `selectProgram switches video and audio overrides, clears stale overrides, and re-emits tracks`() {
    val emitted = mutableListOf<Map<String, Any?>>()
    val bridge = TrackSelectorBridge(
      onTracks = { emitted += it },
      onClearCues = {},
    )
    val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
    try {
      val tracks = buildTwoProgramTracks(selectedProgram = 1)
      bridge.onTracksChanged(player, tracks)
      assertEquals(1, emitted.size)
      assertEquals("1", emitted.last()["selectedProgramId"])

      // Set an audio override in program 1 first
      bridge.selectAudioTrack(player, "1:1")
      val p1AudioGroup = tracks.groups[1].mediaTrackGroup
      assertEquals(listOf(1), player.trackSelectionParameters.overrides[p1AudioGroup]?.trackIndices)

      // Now switch to program 2
      bridge.selectProgram(player, "2")
      val p1VideoGroup = tracks.groups[0].mediaTrackGroup
      val p2VideoGroup = tracks.groups[3].mediaTrackGroup
      val p2AudioGroup = tracks.groups[4].mediaTrackGroup

      assertNull("stale program 1 video override must be cleared", player.trackSelectionParameters.overrides[p1VideoGroup])
      assertNull("stale program 1 audio override must be cleared", player.trackSelectionParameters.overrides[p1AudioGroup])
      assertEquals(listOf(0), player.trackSelectionParameters.overrides[p2VideoGroup]?.trackIndices)
      // Prior audio language was English (1:1), so program 2 picks its English track (track index 1 -> "4:1")
      assertEquals(listOf(1), player.trackSelectionParameters.overrides[p2AudioGroup]?.trackIndices)
      assertEquals("2", emitted.last()["selectedProgramId"])
      assertEquals("4:1", emitted.last()["selectedAudioId"])

      // Unmatched program ID must be ignored without disturbing active overrides
      val countBefore = emitted.size
      bridge.selectProgram(player, "999")
      assertEquals(countBefore, emitted.size)
      assertEquals(listOf(0), player.trackSelectionParameters.overrides[p2VideoGroup]?.trackIndices)

      // Selecting Auto video quality (null) keeps active program video group override
      bridge.selectVideoQuality(player, null)
      assertEquals(listOf(0), player.trackSelectionParameters.overrides[p2VideoGroup]?.trackIndices)
    } finally {
      player.release()
    }
  }

  @Test
  fun `load request programId applies preferred service on initial onTracksChanged`() {
    val emitted = mutableListOf<Map<String, Any?>>()
    val bridge = TrackSelectorBridge(
      onTracks = { emitted += it },
      onClearCues = {},
    )
    val player = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).build()
    try {
      val (_, parsedReq) = parseLoadArgs(
        mapOf(
          "attempt" to 1,
          "url" to "https://cdn.example.test/live/mpts.ts",
          "kind" to "live",
          "programId" to "2",
        ),
      )
      assertEquals("2", parsedReq.programId)

      bridge.onLoad(parsedReq)
      val tracks = buildTwoProgramTracks(selectedProgram = 1)
      bridge.onTracksChanged(player, tracks)

      val p2VideoGroup = tracks.groups[3].mediaTrackGroup
      val p2AudioGroup = tracks.groups[4].mediaTrackGroup
      assertEquals(listOf(0), player.trackSelectionParameters.overrides[p2VideoGroup]?.trackIndices)
      assertEquals(listOf(0), player.trackSelectionParameters.overrides[p2AudioGroup]?.trackIndices)
      assertEquals("2", emitted.last()["selectedProgramId"])
    } finally {
      player.release()
    }
  }
}

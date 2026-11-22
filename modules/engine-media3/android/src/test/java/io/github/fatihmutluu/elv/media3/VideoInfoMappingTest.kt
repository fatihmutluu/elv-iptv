package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.ColorInfo
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
@OptIn(UnstableApi::class)
class VideoInfoMappingTest {
  @Test
  fun `maps HEVC 4K HDR10 format and prefers decoded VideoSize dimensions`() {
    val hdr10Color = ColorInfo.Builder()
      .setColorSpace(C.COLOR_SPACE_BT2020)
      .setColorRange(C.COLOR_RANGE_LIMITED)
      .setColorTransfer(C.COLOR_TRANSFER_ST2084)
      .build()
    val format = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_H265)
      .setWidth(1920)
      .setHeight(1080)
      .setFrameRate(59.94f)
      .setColorInfo(hdr10Color)
      .build()

    val info = deriveVideoInfo(format, VideoSize(3840, 2160))
    assertEquals(
      VideoInfoSnapshot(width = 3840, height = 2160, fps = 59.94, codec = "hevc", hdr = "hdr10"),
      info,
    )
    assertEquals(
      mapOf("width" to 3840, "height" to 2160, "fps" to 59.94, "codec" to "hevc", "hdr" to "hdr10"),
      info?.toMap(),
    )
  }

  @Test
  fun `maps HLG, Dolby Vision, and SDR streams cleanly`() {
    val hlgColor = ColorInfo.Builder()
      .setColorTransfer(C.COLOR_TRANSFER_HLG)
      .build()
    val hlgFmt = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_H264)
      .setWidth(1920)
      .setHeight(1080)
      .setFrameRate(50f)
      .setColorInfo(hlgColor)
      .build()
    assertEquals(
      VideoInfoSnapshot(width = 1920, height = 1080, fps = 50.0, codec = "h264", hdr = "hlg"),
      deriveVideoInfo(hlgFmt, null),
    )

    val dvFmt = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_DOLBY_VISION)
      .setCodecs("dvhe.08.06")
      .setWidth(3840)
      .setHeight(2160)
      .setFrameRate(23.976f)
      .build()
    assertEquals(
      VideoInfoSnapshot(width = 3840, height = 2160, fps = 23.98, codec = "hevc", hdr = "dv"),
      deriveVideoInfo(dvFmt, null),
    )

    val sdrAv1 = Format.Builder()
      .setSampleMimeType(MimeTypes.VIDEO_AV1)
      .setWidth(1280)
      .setHeight(720)
      .build()
    assertEquals(
      VideoInfoSnapshot(width = 1280, height = 720, fps = null, codec = "av1", hdr = "sdr"),
      deriveVideoInfo(sdrAv1, null),
    )
  }

  @Test
  fun `returns null when neither format nor positive videoSize is present`() {
    assertNull(deriveVideoInfo(null, null))
    assertNull(deriveVideoInfo(null, VideoSize.UNKNOWN))
  }

  @Test
  fun `extracts selected video format from Tracks and skips unselected or non-video groups`() {
    val audioFmt = Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).build()
    val unselectedVideo = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setWidth(1280).setHeight(720).build()
    val selectedVideo = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_VP9).setWidth(1920).setHeight(1080).build()

    val tracks = Tracks(
      listOf(
        Tracks.Group(TrackGroup("a", audioFmt), false, intArrayOf(C.FORMAT_HANDLED), booleanArrayOf(true)),
        Tracks.Group(
          TrackGroup("v", unselectedVideo, selectedVideo),
          false,
          intArrayOf(C.FORMAT_HANDLED, C.FORMAT_HANDLED),
          booleanArrayOf(false, true),
        ),
      )
    )

    val extracted = extractSelectedVideoFormat(tracks)
    assertEquals(MimeTypes.VIDEO_VP9, extracted?.sampleMimeType)
    assertEquals(1920, extracted?.width)
  }
}

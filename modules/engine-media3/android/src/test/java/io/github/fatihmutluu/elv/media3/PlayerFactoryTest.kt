package io.github.fatihmutluu.elv.media3

import android.os.Looper
import android.provider.Settings
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackSelectionParameters.AudioOffloadPreferences
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.SeekParameters
import androidx.media3.exoplayer.mediacodec.MediaCodecInfo
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.trackselection.DefaultTrackSelector
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class PlayerFactoryTest {
  @Test
  fun `configures DefaultTrackSelector mixed-audio adaptiveness, capability invalidation and AudioOffload without tunneling (#111, #191, #222)`() {
    val app = RuntimeEnvironment.getApplication()
    val factory = PlayerFactory(app, Looper.getMainLooper(), loadControlFor(lowRam = false), CodecPolicy())
    val player = factory.build(softwareAudio = false)
    try {
      val selector = player.trackSelector as DefaultTrackSelector
      val params = selector.parameters
      assertTrue(params.allowAudioMixedMimeTypeAdaptiveness)
      assertTrue(params.allowAudioMixedSampleRateAdaptiveness)
      assertTrue(params.allowAudioMixedChannelCountAdaptiveness)
      assertTrue(params.allowAudioMixedDecoderSupportAdaptiveness)
      assertTrue(params.allowInvalidateSelectionsOnRendererCapabilitiesChange)
      assertEquals(AudioOffloadPreferences.AUDIO_OFFLOAD_MODE_ENABLED, params.audioOffloadPreferences.audioOffloadMode)
      assertFalse("tunneling must remain disabled (#222)", params.tunnelingEnabled)
    } finally {
      player.release()
    }
  }

  @Test
  fun `falls back cleanly to handleAudioFocus false when TAKE_AUDIO_FOCUS throws SecurityException (#260)`() {
    val app = RuntimeEnvironment.getApplication()
    var attemptsWithFocus = 0
    val factory = PlayerFactory(
      context = app,
      looper = Looper.getMainLooper(),
      buffers = loadControlFor(lowRam = true),
      codecPolicy = CodecPolicy(),
      audioFocusProbe = { handleFocus ->
        if (handleFocus) {
          attemptsWithFocus += 1
          throw SecurityException("TAKE_AUDIO_FOCUS denied by firmware")
        }
      },
    )
    assertTrue(factory.audioFocusAllowed)
    val player = factory.build(softwareAudio = false)
    try {
      assertEquals(1, attemptsWithFocus)
      assertFalse(factory.audioFocusAllowed)
    } finally {
      player.release()
    }
  }

  @Test
  fun `vodSeekParametersFor chooses PREVIOUS_SYNC on initial resume and rewind and CLOSEST_SYNC on forward seek (#313)`() {
    assertEquals(SeekParameters.PREVIOUS_SYNC, vodSeekParametersFor(targetPositionMs = 30_000L, currentPositionMs = null))
    assertEquals(SeekParameters.PREVIOUS_SYNC, vodSeekParametersFor(targetPositionMs = 20_000L, currentPositionMs = 30_000L))
    assertEquals(SeekParameters.PREVIOUS_SYNC, vodSeekParametersFor(targetPositionMs = 30_000L, currentPositionMs = 30_000L))
    assertEquals(SeekParameters.CLOSEST_SYNC, vodSeekParametersFor(targetPositionMs = 40_000L, currentPositionMs = 30_000L))
  }

  @Test
  fun `selects StreamKind and BufferPreset LoadControlValues per build call and binds profile loadControl reference (#147, #422)`() {
    val app = RuntimeEnvironment.getApplication()
    val seen = mutableListOf<Pair<StreamKind, BufferPreset>>()
    val profile = DeviceMemoryProfile(isLowRamDevice = false, totalMemBytes = 4L * 1024L * 1024L * 1024L, lowRam = false)
    // Verify backward-compatible DeviceMemoryProfile.loadControl(live) overload
    assertEquals(0, profile.loadControl(live = true).backBufferMs)
    assertEquals(12_000, profile.loadControl(live = false).backBufferMs)

    // Verify unambiguous binding of profile::loadControl to PlayerFactory primary constructor
    val refFactory = PlayerFactory(app, Looper.getMainLooper(), profile::loadControl, CodecPolicy())
    val refPlayer = refFactory.build(
      softwareAudio = false,
      live = true,
      streamKind = StreamKind.RAW_TS_LIVE,
      bufferPreset = BufferPreset.BALANCED,
    )
    refPlayer.release()

    val factory = PlayerFactory(
      context = app,
      looper = Looper.getMainLooper(),
      loadControlForStream = { kind, preset ->
        seen += kind to preset
        profile.loadControl(kind, preset)
      },
      codecPolicy = CodecPolicy(),
    )
    val tsPlayer = factory.build(softwareAudio = false, live = true, streamKind = StreamKind.RAW_TS_LIVE, bufferPreset = BufferPreset.AUTO)
    val hlsPlayer = factory.build(softwareAudio = false, live = true)
    val vodPlayer = factory.build(softwareAudio = false, live = false, streamKind = StreamKind.VOD, bufferPreset = BufferPreset.LARGE)
    try {
      assertEquals(
        listOf(
          StreamKind.RAW_TS_LIVE to BufferPreset.AUTO,
          StreamKind.HLS_LIVE to BufferPreset.AUTO,
          StreamKind.VOD to BufferPreset.LARGE,
        ),
        seen,
      )
    } finally {
      tsPlayer.release()
      hlsPlayer.release()
      vodPlayer.release()
    }
  }

  @Test
  fun `gates CaptioningManager text preferences behind system captioning enabled state (#438)`() {
    val app = RuntimeEnvironment.getApplication()
    val resolver = app.contentResolver
    Settings.Secure.putInt(resolver, "accessibility_captioning_enabled", 0)
    Settings.Secure.putString(resolver, "accessibility_captioning_locale", "tr")
    assertFalse(isSystemCaptioningEnabled(app))

    val disabledFactory = PlayerFactory(
      context = app,
      looper = Looper.getMainLooper(),
      loadControlForStream = { kind, preset -> loadControlForStream(false, 2L * 1024 * 1024 * 1024, kind, preset) },
      codecPolicy = CodecPolicy(),
      captioningEnabled = { false },
    )
    val disabledPlayer = disabledFactory.build(softwareAudio = false)
    try {
      val params = (disabledPlayer.trackSelector as DefaultTrackSelector).parameters
      assertFalse(
        "CaptioningManager integration must be disabled when system captioning is off",
        params.usePreferredTextLanguagesAndRoleFlagsFromCaptioningManager,
      )
      assertTrue("preferredTextLanguages must remain empty when captioning disabled", params.preferredTextLanguages.isEmpty())
      assertEquals(0, params.preferredTextRoleFlags)
    } finally {
      disabledPlayer.release()
    }

    Settings.Secure.putInt(resolver, "accessibility_captioning_enabled", 1)
    assertTrue(isSystemCaptioningEnabled(app))

    val enabledFactory = PlayerFactory(
      context = app,
      looper = Looper.getMainLooper(),
      loadControlForStream = { kind, preset -> loadControlForStream(false, 2L * 1024 * 1024 * 1024, kind, preset) },
      codecPolicy = CodecPolicy(),
      captioningEnabled = { true },
    )
    val enabledPlayer = enabledFactory.build(softwareAudio = false)
    try {
      val params = (enabledPlayer.trackSelector as DefaultTrackSelector).parameters
      assertTrue(
        "CaptioningManager settings must be enabled when system captioning is on",
        params.usePreferredTextLanguagesAndRoleFlagsFromCaptioningManager,
      )
    } finally {
      enabledPlayer.release()
      Settings.Secure.putInt(resolver, "accessibility_captioning_enabled", 0)
    }
  }

  @Test
  fun `gates seamless video frame-rate switching strategy on API 30+ and AutoFrameRateMode (#151, #116)`() {
    assertEquals(C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF, videoChangeFrameRateStrategyForApi(28))
    assertEquals(C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF, videoChangeFrameRateStrategyForApi(29))
    assertEquals(C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS, videoChangeFrameRateStrategyForApi(30))
    assertEquals(C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS, videoChangeFrameRateStrategyForApi(34))
    assertEquals(C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF, videoChangeFrameRateStrategyForApi(34, AutoFrameRateMode.OFF))
    assertEquals(
      C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS,
      videoChangeFrameRateStrategyForApi(34, AutoFrameRateMode.SEAMLESS),
    )
    assertEquals(
      C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS,
      videoChangeFrameRateStrategyForApi(34, AutoFrameRateMode.ALWAYS),
    )

    val app = RuntimeEnvironment.getApplication()
    val api30Factory = PlayerFactory(
      context = app,
      looper = Looper.getMainLooper(),
      buffers = loadControlFor(lowRam = false),
      codecPolicy = CodecPolicy(),
      sdkInt = 30,
    )
    val api29Factory = PlayerFactory(
      context = app,
      looper = Looper.getMainLooper(),
      buffers = loadControlFor(lowRam = false),
      codecPolicy = CodecPolicy(),
      sdkInt = 29,
    )
    val api30Player = api30Factory.build(softwareAudio = false)
    val api29Player = api29Factory.build(softwareAudio = false)
    try {
      assertEquals(C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_ONLY_IF_SEAMLESS, api30Player.videoChangeFrameRateStrategy)
      assertEquals(C.VIDEO_CHANGE_FRAME_RATE_STRATEGY_OFF, api29Player.videoChangeFrameRateStrategy)
    } finally {
      api30Player.release()
      api29Player.release()
    }
  }

  @Test
  fun `propagates VideoDecoderMode to PolicyVideoRenderer and extension renderer preference (#411)`() {
    val app = RuntimeEnvironment.getApplication()
    val factory = PlayerFactory(app, Looper.getMainLooper(), loadControlFor(lowRam = false), CodecPolicy())
    val hwCodec = MediaCodecInfo.newInstance("c2.qti.avc.decoder", MimeTypes.VIDEO_H264, MimeTypes.VIDEO_H264, null, true, false, true, false, false)
    val swCodec = MediaCodecInfo.newInstance("c2.android.avc.decoder", MimeTypes.VIDEO_H264, MimeTypes.VIDEO_H264, null, false, true, false, false, false)
    val selector = MediaCodecSelector { _, _, _ -> listOf(hwCodec, swCodec) }
    val format = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setWidth(1920).setHeight(1080).build()

    val autoPlayer = factory.build(softwareAudio = false, decoderMode = VideoDecoderMode.AUTO)
    val hwPlayer = factory.build(softwareAudio = false, decoderMode = VideoDecoderMode.HARDWARE)
    val swPlayer = factory.build(softwareAudio = false, decoderMode = VideoDecoderMode.SOFTWARE)
    try {
      fun videoRenderer(player: androidx.media3.exoplayer.ExoPlayer): PolicyVideoRenderer =
        (0 until player.rendererCount).map { player.getRenderer(it) }.filterIsInstance<PolicyVideoRenderer>().single()

      fun audioRenderers(player: androidx.media3.exoplayer.ExoPlayer): List<String> =
        (0 until player.rendererCount).map { player.getRenderer(it) }.filter { it.trackType == C.TRACK_TYPE_AUDIO }.map { it.javaClass.name }

      val autoVideo = videoRenderer(autoPlayer)
      val hwVideo = videoRenderer(hwPlayer)
      val swVideo = videoRenderer(swPlayer)
      assertEquals(VideoDecoderMode.AUTO, autoVideo.decoderModeForTest)
      assertEquals(VideoDecoderMode.HARDWARE, hwVideo.decoderModeForTest)
      assertEquals(VideoDecoderMode.SOFTWARE, swVideo.decoderModeForTest)
      assertEquals(listOf(hwCodec.name), hwVideo.resolveDecoderInfosForTest(selector, format).map { it.name })
      assertEquals(listOf(swCodec.name), swVideo.resolveDecoderInfosForTest(selector, format).map { it.name })
      assertEquals("androidx.media3.decoder.ffmpeg.FfmpegAudioRenderer", audioRenderers(swPlayer).first())
      assertEquals("androidx.media3.exoplayer.audio.MediaCodecAudioRenderer", audioRenderers(hwPlayer).first())
    } finally {
      autoPlayer.release()
      hwPlayer.release()
      swPlayer.release()
    }
  }

  @Test
  fun `skips Android audio focus acquisition when handleAudioFocus is false for secondary Multi-View tiles (#34, #221)`() {
    val app = RuntimeEnvironment.getApplication()
    val probeCalls = mutableListOf<Boolean>()
    val factory = PlayerFactory(
      context = app,
      looper = Looper.getMainLooper(),
      buffers = loadControlFor(lowRam = false, live = true),
      codecPolicy = CodecPolicy(),
      audioFocusProbe = { probeCalls += it },
    )
    val secondaryPlayer = factory.build(
      softwareAudio = false,
      live = true,
      streamKind = StreamKind.HLS_LIVE,
      handleAudioFocus = false,
      multiViewTileCount = 4,
    )
    val primaryPlayer = factory.build(
      softwareAudio = false,
      live = true,
      streamKind = StreamKind.HLS_LIVE,
      handleAudioFocus = true,
      multiViewTileCount = 4,
    )
    try {
      assertEquals(listOf(false, true), probeCalls)
      assertTrue("explicit handleAudioFocus=false must not permanently disable factory audioFocusAllowed", factory.audioFocusAllowed)
    } finally {
      secondaryPlayer.release()
      primaryPlayer.release()
    }
  }
}

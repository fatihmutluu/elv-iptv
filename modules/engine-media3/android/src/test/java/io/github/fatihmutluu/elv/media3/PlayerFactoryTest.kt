package io.github.fatihmutluu.elv.media3

import android.os.Looper
import android.provider.Settings
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.SeekParameters
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
  fun `configures DefaultTrackSelector mixed-audio adaptiveness and capability invalidation (#111, #191)`() {
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
  fun `selects live vs VOD LoadControlValues per build call (#422)`() {
    val app = RuntimeEnvironment.getApplication()
    val seenLiveFlags = mutableListOf<Boolean>()
    val profile = DeviceMemoryProfile(isLowRamDevice = true, totalMemBytes = 1024L * 1024L * 1024L, lowRam = true)
    val factory = PlayerFactory(
      context = app,
      looper = Looper.getMainLooper(),
      loadControlForLive = { live ->
        seenLiveFlags += live
        profile.loadControl(live)
      },
      codecPolicy = CodecPolicy(),
    )
    val livePlayer = factory.build(softwareAudio = false, live = true)
    val vodPlayer = factory.build(softwareAudio = false, live = false)
    try {
      assertEquals(listOf(true, false), seenLiveFlags)
    } finally {
      livePlayer.release()
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
      loadControlForLive = { loadControlFor(lowRam = false, live = it) },
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
      loadControlForLive = { loadControlFor(lowRam = false, live = it) },
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
}

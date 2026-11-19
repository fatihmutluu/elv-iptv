package io.github.fatihmutluu.elv.media3

import android.os.Looper
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
}

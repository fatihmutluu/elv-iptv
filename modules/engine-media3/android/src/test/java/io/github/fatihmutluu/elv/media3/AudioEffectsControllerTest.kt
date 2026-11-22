package io.github.fatihmutluu.elv.media3

import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.MimeTypes
import androidx.media3.common.TrackGroup
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import java.util.concurrent.TimeUnit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class AudioEffectsControllerTest {
  private class FakeGainEffect(
    val sessionId: Int,
    private val throwOnApply: Boolean = false,
  ) : GainEffect {
    var enabled: Boolean = false
      private set
    val appliedGainsMb = mutableListOf<Int>()
    var released: Boolean = false

    override fun setEnabled(enabled: Boolean) {
      if (throwOnApply && enabled) throw RuntimeException("OEM AudioEffect failure")
      this.enabled = enabled
    }

    override fun setTargetGain(gainMb: Int) {
      if (throwOnApply) throw RuntimeException("OEM AudioEffect failure")
      appliedGainsMb += gainMb
    }

    override fun release() {
      released = true
    }
  }

  private fun audioTracks(channelCount: Int, selected: Boolean = true): Tracks {
    val format = Format.Builder()
      .setSampleMimeType(MimeTypes.AUDIO_AAC)
      .setChannelCount(channelCount)
      .build()
    val group = Tracks.Group(
      TrackGroup("audio", format),
      /* adaptiveSupported = */ false,
      intArrayOf(C.FORMAT_HANDLED),
      booleanArrayOf(selected),
    )
    return Tracks(listOf(group))
  }

  @Test
  fun `never creates LoudnessEnhancer on unset or zero audioSessionId (#260)`() {
    val created = mutableListOf<Int>()
    val controller = AudioEffectsController(
      handler = Handler(Looper.getMainLooper()),
      effectFactory = { id ->
        created += id
        FakeGainEffect(id)
      },
    )
    controller.setBoostDb(6.0)
    controller.onAudioSessionIdChanged(C.AUDIO_SESSION_ID_UNSET)
    controller.onAudioSessionIdChanged(0)
    controller.onAudioSessionIdChanged(-5)
    assertTrue(created.isEmpty())
    assertFalse(controller.isEffectActive)
    controller.release()
  }

  @Test
  fun `disables and releases effect on 5_1 multichannel audio and re-enables on stereo (#260)`() {
    val effects = mutableListOf<FakeGainEffect>()
    val controller = AudioEffectsController(
      handler = Handler(Looper.getMainLooper()),
      effectFactory = { id -> FakeGainEffect(id).also { effects += it } },
      refreshIntervalMs = 300_000L,
    )
    controller.onAudioSessionIdChanged(42)
    controller.setBoostDb(4.5)
    assertEquals(1, effects.size)
    assertEquals(42, effects[0].sessionId)
    assertTrue(effects[0].enabled)
    assertEquals(listOf(450), effects[0].appliedGainsMb)

    // Switch to 5.1 (6 channels): must disable and release immediately
    controller.onTracksChanged(audioTracks(channelCount = 6))
    assertFalse(controller.isEffectActive)
    assertTrue(effects[0].released)
    assertFalse(effects[0].enabled)

    // Switch back to stereo (2 channels): re-creates and enables cleanly
    controller.onTracksChanged(audioTracks(channelCount = 2))
    assertTrue(controller.isEffectActive)
    assertEquals(2, effects.size)
    assertTrue(effects[1].enabled)
    assertEquals(listOf(450), effects[1].appliedGainsMb)

    // Setting boost <= 0 disables and releases
    controller.setBoostDb(0.0)
    assertFalse(controller.isEffectActive)
    assertTrue(effects[1].released)
    controller.release()
  }

  @Test
  fun `refreshes gain every 5 minutes to counter AOSP DRC drift and cancels strictly on onStop and release (#260)`() {
    val looper = Looper.getMainLooper()
    val shadowLooper = Shadows.shadowOf(looper)
    val effects = mutableListOf<FakeGainEffect>()
    val controller = AudioEffectsController(
      handler = Handler(looper),
      effectFactory = { id -> FakeGainEffect(id).also { effects += it } },
      refreshIntervalMs = 300_000L,
    )
    controller.onAudioSessionIdChanged(77)
    controller.setBoostDb(3.0)
    assertEquals(listOf(300), effects[0].appliedGainsMb)

    // Advance 5 minutes -> gain refreshed once
    shadowLooper.idleFor(300_000L, TimeUnit.MILLISECONDS)
    assertEquals(listOf(300, 300), effects[0].appliedGainsMb)

    // Advance another 5 minutes -> gain refreshed twice
    shadowLooper.idleFor(300_000L, TimeUnit.MILLISECONDS)
    assertEquals(listOf(300, 300, 300), effects[0].appliedGainsMb)

    // onStop releases effect and cancels scheduled refresh
    controller.onStop()
    assertTrue(effects[0].released)
    assertFalse(controller.isEffectActive)
    shadowLooper.idleFor(600_000L, TimeUnit.MILLISECONDS)
    assertEquals(3, effects[0].appliedGainsMb.size)
    assertEquals(1, effects.size)

    // Session change re-activates and replaces old session cleanly
    controller.onAudioSessionIdChanged(88)
    assertEquals(2, effects.size)
    assertEquals(88, effects[1].sessionId)
    assertTrue(controller.isEffectActive)

    // release() cancels timer and prevents future activation
    controller.release()
    assertTrue(effects[1].released)
    shadowLooper.idleFor(600_000L, TimeUnit.MILLISECONDS)
    assertEquals(1, effects[1].appliedGainsMb.size)
    controller.setBoostDb(8.0)
    controller.onAudioSessionIdChanged(99)
    assertEquals(2, effects.size)
  }

  @Test
  fun `swallows OEM AudioEffect creation and apply exceptions without crashing (#260)`() {
    val throwingCreate = AudioEffectsController(
      handler = Handler(Looper.getMainLooper()),
      effectFactory = { throw UnsupportedOperationException("no LoudnessEnhancer on OEM ROM") },
    )
    throwingCreate.onAudioSessionIdChanged(10)
    throwingCreate.setBoostDb(5.0)
    assertFalse(throwingCreate.isEffectActive)
    throwingCreate.release()

    val brokenEffects = mutableListOf<FakeGainEffect>()
    val throwingApply = AudioEffectsController(
      handler = Handler(Looper.getMainLooper()),
      effectFactory = { id -> FakeGainEffect(id, throwOnApply = true).also { brokenEffects += it } },
    )
    throwingApply.onAudioSessionIdChanged(11)
    throwingApply.setBoostDb(5.0)
    assertFalse(throwingApply.isEffectActive)
    assertEquals(1, brokenEffects.size)
    assertTrue(brokenEffects[0].released)
    throwingApply.release()
  }
}

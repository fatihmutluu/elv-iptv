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

  private class FakeDrcEffect(
    val sessionId: Int,
    private val throwOnApply: Boolean = false,
  ) : DrcEffect {
    var enabled: Boolean = false
      private set
    val appliedConfigs = mutableListOf<NightModeDrcConfig>()
    var released: Boolean = false

    override fun applyConfig(config: NightModeDrcConfig) {
      if (throwOnApply) throw RuntimeException("OEM DynamicsProcessing HAL error")
      appliedConfigs += config
    }

    override fun setEnabled(enabled: Boolean) {
      if (throwOnApply && enabled) throw RuntimeException("OEM DynamicsProcessing HAL error")
      this.enabled = enabled
    }

    override fun release() {
      released = true
    }
  }

  @Test
  fun `NightModeDrcPolicy maps presets cleanly and gates DynamicsProcessing below API 28 (#115)`() {
    assertEquals(NightModeDrcPreset.OFF, parseNightModeDrcPreset(null))
    assertEquals(NightModeDrcPreset.OFF, parseNightModeDrcPreset("unknown"))
    assertEquals(NightModeDrcPreset.LIGHT, parseNightModeDrcPreset(" light "))
    assertEquals(NightModeDrcPreset.NIGHT, parseNightModeDrcPreset("NIGHT"))
    assertEquals(null, nightModeDrcConfigFor(NightModeDrcPreset.OFF))

    val light = nightModeDrcConfigFor(NightModeDrcPreset.LIGHT)!!
    val night = nightModeDrcConfigFor(NightModeDrcPreset.NIGHT)!!
    assertTrue("NIGHT ratio must compress harder than LIGHT", night.ratio > light.ratio)
    assertTrue("NIGHT threshold must be lower than LIGHT", night.thresholdDb < light.thresholdDb)
    assertEquals(-1.5f, night.limiterThresholdDb, 0.01f)
    assertTrue(light.limiterEnabled && night.limiterEnabled)

    // Platform factory returns null safely on API < 28 or non-positive sessionId
    assertEquals(null, createPlatformDynamicsProcessing(audioSessionId = 42, sdkInt = 27))
    assertEquals(null, createPlatformDynamicsProcessing(audioSessionId = 0, sdkInt = 34))
  }

  @Test
  fun `Night-Mode DRC attaches on valid stereo session, auto-disables on multichannel, handles session swap, stop, release, and HAL errors (#115)`() {
    val drcEffects = mutableListOf<FakeDrcEffect>()
    val controller = AudioEffectsController(
      handler = Handler(Looper.getMainLooper()),
      drcEffectFactory = { id -> FakeDrcEffect(id).also { drcEffects += it } },
    )

    // Unset session -> does not create
    controller.setNightModeDrc(NightModeDrcPreset.LIGHT)
    assertFalse(controller.isDrcEffectActive)
    assertTrue(drcEffects.isEmpty())

    // Valid session -> attaches LIGHT
    controller.onAudioSessionIdChanged(55)
    assertTrue(controller.isDrcEffectActive)
    assertEquals(1, drcEffects.size)
    assertEquals(NightModeDrcPreset.LIGHT, drcEffects[0].appliedConfigs.last().preset)
    assertTrue(drcEffects[0].enabled)

    // Switching LIGHT -> NIGHT updates in place on same session
    controller.setNightModeDrc(NightModeDrcPreset.NIGHT)
    assertEquals(1, drcEffects.size)
    assertEquals(NightModeDrcPreset.NIGHT, drcEffects[0].appliedConfigs.last().preset)

    // Multichannel (5.1) -> disables & releases DRC automatically
    controller.onTracksChanged(audioTracks(channelCount = 6))
    assertFalse(controller.isDrcEffectActive)
    assertTrue(drcEffects[0].released)

    // Back to stereo -> re-creates DRC
    controller.onTracksChanged(audioTracks(channelCount = 2))
    assertTrue(controller.isDrcEffectActive)
    assertEquals(2, drcEffects.size)

    // Session ID change -> releases old DRC and attaches new session
    controller.onAudioSessionIdChanged(66)
    assertTrue(drcEffects[1].released)
    assertEquals(3, drcEffects.size)
    assertEquals(66, drcEffects[2].sessionId)

    // onStop releases DRC cleanly
    controller.onStop()
    assertTrue(drcEffects[2].released)
    assertFalse(controller.isDrcEffectActive)

    // OFF releases DRC and stays inactive
    controller.onAudioSessionIdChanged(77)
    assertTrue(controller.isDrcEffectActive)
    controller.setNightModeDrc(NightModeDrcPreset.OFF)
    assertFalse(controller.isDrcEffectActive)
    assertTrue(drcEffects[3].released)

    // Release locks out future activation
    controller.release()
    controller.setNightModeDrc(NightModeDrcPreset.NIGHT)
    controller.onAudioSessionIdChanged(88)
    assertEquals(4, drcEffects.size)

    // OEM HAL exception on apply releases and does not crash
    val broken = mutableListOf<FakeDrcEffect>()
    val failing = AudioEffectsController(
      handler = Handler(Looper.getMainLooper()),
      drcEffectFactory = { id -> FakeDrcEffect(id, throwOnApply = true).also { broken += it } },
    )
    failing.onAudioSessionIdChanged(99)
    failing.setNightModeDrc(NightModeDrcPreset.NIGHT)
    assertFalse(failing.isDrcEffectActive)
    assertEquals(1, broken.size)
    assertTrue(broken[0].released)
    failing.release()
  }
}

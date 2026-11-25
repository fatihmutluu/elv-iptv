package io.github.fatihmutluu.elv.media3

import android.media.audiofx.LoudnessEnhancer
import android.os.Handler
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import kotlin.math.roundToInt

private const val DEFAULT_REFRESH_INTERVAL_MS = 300_000L
private const val MAX_BOOST_DB = 24.0

/** Testable abstraction over Android's native [LoudnessEnhancer] (#260). */
internal interface GainEffect {
  fun setEnabled(enabled: Boolean)
  fun setTargetGain(gainMb: Int)
  fun release()
}

/** Creates a platform [LoudnessEnhancer] for a non-zero [audioSessionId], catching OEM [AudioEffect] failures (#260). */
internal fun createPlatformLoudnessEnhancer(audioSessionId: Int): GainEffect? {
  if (audioSessionId <= 0) return null
  return runCatching {
    val enhancer = LoudnessEnhancer(audioSessionId)
    object : GainEffect {
      override fun setEnabled(enabled: Boolean) {
        enhancer.setEnabled(enabled)
      }

      override fun setTargetGain(gainMb: Int) {
        enhancer.setTargetGain(gainMb)
      }

      override fun release() {
        enhancer.release()
      }
    }
  }.getOrNull()
}

/**
 * Manages optional stereo audio gain boost via [LoudnessEnhancer] (#260) and API 28+ Night-Mode DRC via
 * [android.media.audiofx.DynamicsProcessing] (#115):
 * - Never attaches to `audioSessionId <= 0` / `C.AUDIO_SESSION_ID_UNSET`.
 * - Automatically disables and releases on multichannel (`channelCount > 2`, e.g. 5.1/7.1) streams or `OFF`/`boostDb <= 0`.
 * - Wraps native audio effect calls in `runCatching` so buggy OEM audio HALs never crash playback.
 * - Periodically refreshes loudness target gain on [handler] (default 5 min) to counter AOSP DRC downward drift,
 *   cancelling strictly on [onStop], session change, multichannel switch, and [release].
 */
@OptIn(UnstableApi::class)
internal class AudioEffectsController(
  private val handler: Handler,
  private val effectFactory: (Int) -> GainEffect? = ::createPlatformLoudnessEnhancer,
  private val refreshIntervalMs: Long = DEFAULT_REFRESH_INTERVAL_MS,
  private val drcEffectFactory: (Int) -> DrcEffect? = ::createPlatformDynamicsProcessing,
) {
  private var boostDb: Double = 0.0
  private var drcPreset: NightModeDrcPreset = NightModeDrcPreset.OFF
  private var audioSessionId: Int = C.AUDIO_SESSION_ID_UNSET
  private var multichannelActive: Boolean = false
  private var effect: GainEffect? = null
  private var effectSessionId: Int = C.AUDIO_SESSION_ID_UNSET
  private var drcEffect: DrcEffect? = null
  private var drcSessionId: Int = C.AUDIO_SESSION_ID_UNSET
  private var released: Boolean = false

  private val refreshRunnable = Runnable { refreshGain() }

  internal val isEffectActive: Boolean
    get() = effect != null

  internal val isDrcEffectActive: Boolean
    get() = drcEffect != null

  fun setBoostDb(db: Double) {
    if (released) return
    boostDb = if (db.isFinite() && db > 0.0) db.coerceAtMost(MAX_BOOST_DB) else 0.0
    syncEffect()
  }

  /** Sets the stereo Night-Mode DRC preset (`OFF` / `LIGHT` / `NIGHT`, #115). */
  fun setNightModeDrc(preset: NightModeDrcPreset) {
    if (released) return
    drcPreset = preset
    syncDrcEffect()
  }

  fun onAudioSessionIdChanged(sessionId: Int) {
    if (released) return
    if (sessionId == audioSessionId) return
    audioSessionId = sessionId
    if (effectSessionId != sessionId) {
      releaseActiveEffect()
    }
    if (drcSessionId != sessionId) {
      releaseActiveDrcEffect()
    }
    syncEffect()
    syncDrcEffect()
  }

  fun onTracksChanged(tracks: Tracks) {
    if (released) return
    var maxSelectedChannels = Format.NO_VALUE
    for (group in tracks.groups) {
      if (group.type != C.TRACK_TYPE_AUDIO || !group.isSelected) continue
      for (i in 0 until group.length) {
        if (group.isTrackSelected(i)) {
          val channels = group.getTrackFormat(i).channelCount
          if (channels > maxSelectedChannels) maxSelectedChannels = channels
        }
      }
    }
    multichannelActive = maxSelectedChannels > 2
    syncEffect()
    syncDrcEffect()
  }

  fun onStop() {
    if (released) return
    multichannelActive = false
    releaseActiveEffect()
    releaseActiveDrcEffect()
  }

  fun release() {
    released = true
    audioSessionId = C.AUDIO_SESSION_ID_UNSET
    multichannelActive = false
    releaseActiveEffect()
    releaseActiveDrcEffect()
  }

  private fun shouldActivate(): Boolean =
    !released &&
      boostDb > 0.0 &&
      audioSessionId > 0 &&
      audioSessionId != C.AUDIO_SESSION_ID_UNSET &&
      !multichannelActive

  private fun shouldActivateDrc(): Boolean =
    !released &&
      drcPreset != NightModeDrcPreset.OFF &&
      audioSessionId > 0 &&
      audioSessionId != C.AUDIO_SESSION_ID_UNSET &&
      !multichannelActive

  private fun gainMillibels(): Int = (boostDb * 100.0).roundToInt()

  private fun syncEffect() {
    if (!shouldActivate()) {
      releaseActiveEffect()
      return
    }
    if (effect == null || effectSessionId != audioSessionId) {
      releaseActiveEffect()
      val created = runCatching { effectFactory(audioSessionId) }.getOrNull() ?: return
      effect = created
      effectSessionId = audioSessionId
    }
    val applied = runCatching {
      val target = effect ?: return
      target.setTargetGain(gainMillibels())
      target.setEnabled(true)
    }.isSuccess
    if (!applied) {
      releaseActiveEffect()
      return
    }
    scheduleRefresh()
  }

  private fun syncDrcEffect() {
    val config = nightModeDrcConfigFor(drcPreset)
    if (!shouldActivateDrc() || config == null) {
      releaseActiveDrcEffect()
      return
    }
    if (drcEffect == null || drcSessionId != audioSessionId) {
      releaseActiveDrcEffect()
      val created = runCatching { drcEffectFactory(audioSessionId) }.getOrNull() ?: return
      drcEffect = created
      drcSessionId = audioSessionId
    }
    val applied = runCatching {
      val target = drcEffect ?: return
      target.applyConfig(config)
      target.setEnabled(true)
    }.isSuccess
    if (!applied) {
      releaseActiveDrcEffect()
    }
  }

  private fun refreshGain() {
    if (!shouldActivate() || effect == null) {
      releaseActiveEffect()
      return
    }
    val applied = runCatching {
      val target = effect ?: return
      target.setTargetGain(gainMillibels())
      target.setEnabled(true)
    }.isSuccess
    if (!applied) {
      releaseActiveEffect()
      return
    }
    scheduleRefresh()
  }

  private fun scheduleRefresh() {
    handler.removeCallbacks(refreshRunnable)
    if (refreshIntervalMs > 0L) {
      handler.postDelayed(refreshRunnable, refreshIntervalMs)
    }
  }

  private fun releaseActiveEffect() {
    handler.removeCallbacks(refreshRunnable)
    val current = effect
    effect = null
    effectSessionId = C.AUDIO_SESSION_ID_UNSET
    if (current != null) {
      runCatching { current.setEnabled(false) }
      runCatching { current.release() }
    }
  }

  private fun releaseActiveDrcEffect() {
    val current = drcEffect
    drcEffect = null
    drcSessionId = C.AUDIO_SESSION_ID_UNSET
    if (current != null) {
      runCatching { current.setEnabled(false) }
      runCatching { current.release() }
    }
  }
}

package io.github.fatihmutluu.elv.media3

import android.media.audiofx.DynamicsProcessing
import android.os.Build
import androidx.annotation.RequiresApi
import java.util.Locale

/** Night-Mode dynamic range compression preset for Android Media3 (`#115`). */
internal enum class NightModeDrcPreset(val wireName: String) {
  OFF("off"),
  LIGHT("light"),
  NIGHT("night"),
}

/** Parses a wire Night-Mode DRC preset (`off` / `light` / `night`), defaulting to [NightModeDrcPreset.OFF]. */
internal fun parseNightModeDrcPreset(raw: String?): NightModeDrcPreset =
  when (raw?.trim()?.lowercase(Locale.ROOT)) {
    NightModeDrcPreset.LIGHT.wireName -> NightModeDrcPreset.LIGHT
    NightModeDrcPreset.NIGHT.wireName -> NightModeDrcPreset.NIGHT
    else -> NightModeDrcPreset.OFF
  }

/** Pure multi-band compressor + limiter parameters applied to API 28+ [DynamicsProcessing] (`#115`). */
internal data class NightModeDrcConfig(
  val preset: NightModeDrcPreset,
  val preGainDb: Float,
  val postGainDb: Float,
  val ratio: Float,
  val thresholdDb: Float,
  val kneeWidthDb: Float,
  val attackTimeMs: Float,
  val releaseTimeMs: Float,
  val noiseGateThresholdDb: Float,
  val expanderRatio: Float,
  val limiterEnabled: Boolean,
  val limiterThresholdDb: Float,
  val limiterRatio: Float,
  val limiterAttackTimeMs: Float,
  val limiterReleaseTimeMs: Float,
  val limiterPostGainDb: Float,
)

private val LIGHT_DRC_CONFIG = NightModeDrcConfig(
  preset = NightModeDrcPreset.LIGHT,
  preGainDb = 2.0f,
  postGainDb = 3.0f,
  ratio = 2.5f,
  thresholdDb = -20.0f,
  kneeWidthDb = 6.0f,
  attackTimeMs = 15.0f,
  releaseTimeMs = 150.0f,
  noiseGateThresholdDb = -70.0f,
  expanderRatio = 1.0f,
  limiterEnabled = true,
  limiterThresholdDb = -2.0f,
  limiterRatio = 10.0f,
  limiterAttackTimeMs = 2.0f,
  limiterReleaseTimeMs = 60.0f,
  limiterPostGainDb = 0.0f,
)

private val NIGHT_DRC_CONFIG = NightModeDrcConfig(
  preset = NightModeDrcPreset.NIGHT,
  preGainDb = 4.0f,
  postGainDb = 6.0f,
  ratio = 4.0f,
  thresholdDb = -26.0f,
  kneeWidthDb = 8.0f,
  attackTimeMs = 8.0f,
  releaseTimeMs = 120.0f,
  noiseGateThresholdDb = -65.0f,
  expanderRatio = 1.0f,
  limiterEnabled = true,
  limiterThresholdDb = -1.5f,
  limiterRatio = 20.0f,
  limiterAttackTimeMs = 1.0f,
  limiterReleaseTimeMs = 50.0f,
  limiterPostGainDb = 0.0f,
)

/** Returns the MBC + limiter profile for [preset], or `null` when [NightModeDrcPreset.OFF] (`#115`). */
internal fun nightModeDrcConfigFor(preset: NightModeDrcPreset): NightModeDrcConfig? = when (preset) {
  NightModeDrcPreset.OFF -> null
  NightModeDrcPreset.LIGHT -> LIGHT_DRC_CONFIG
  NightModeDrcPreset.NIGHT -> NIGHT_DRC_CONFIG
}

/** Testable abstraction over Android API 28+ [DynamicsProcessing] (`#115`). */
internal interface DrcEffect {
  fun applyConfig(config: NightModeDrcConfig)
  fun setEnabled(enabled: Boolean)
  fun release()
}

/**
 * Isolated API 28+ helper so older Android runtimes never load or verify `android.media.audiofx.DynamicsProcessing`
 * when instantiating [AudioEffectsController] (`#115`).
 */
@RequiresApi(Build.VERSION_CODES.P)
private object Api28DynamicsProcessingFactory {
  private const val STEREO_CHANNELS = 2
  private const val FULL_BAND_CUTOFF_HZ = 20_000f

  fun create(audioSessionId: Int): DrcEffect? = runCatching {
    val dpConfig = DynamicsProcessing.Config.Builder(
      /* variant = */ DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
      /* channelCount = */ STEREO_CHANNELS,
      /* preEqInUse = */ false,
      /* preEqBandCount = */ 0,
      /* mbcInUse = */ true,
      /* mbcBandCount = */ 1,
      /* postEqInUse = */ false,
      /* postEqBandCount = */ 0,
      /* limiterInUse = */ true,
    ).build()
    val dp = DynamicsProcessing(0, audioSessionId, dpConfig)
    object : DrcEffect {
      override fun applyConfig(config: NightModeDrcConfig) {
        val mbc = DynamicsProcessing.Mbc(true, true, 1)
        val band = DynamicsProcessing.MbcBand(
          /* enabled = */ true,
          /* cutoffFrequency = */ FULL_BAND_CUTOFF_HZ,
          /* attackTime = */ config.attackTimeMs,
          /* releaseTime = */ config.releaseTimeMs,
          /* ratio = */ config.ratio,
          /* threshold = */ config.thresholdDb,
          /* kneeWidth = */ config.kneeWidthDb,
          /* noiseGateThreshold = */ config.noiseGateThresholdDb,
          /* expanderRatio = */ config.expanderRatio,
          /* preGain = */ config.preGainDb,
          /* postGain = */ config.postGainDb,
        )
        mbc.setBand(0, band)
        dp.setMbcAllChannelsTo(mbc)
        val limiter = DynamicsProcessing.Limiter(
          /* inUse = */ true,
          /* enabled = */ config.limiterEnabled,
          /* linkGroup = */ 0,
          /* attackTime = */ config.limiterAttackTimeMs,
          /* releaseTime = */ config.limiterReleaseTimeMs,
          /* ratio = */ config.limiterRatio,
          /* threshold = */ config.limiterThresholdDb,
          /* postGain = */ config.limiterPostGainDb,
        )
        dp.setLimiterAllChannelsTo(limiter)
      }

      override fun setEnabled(enabled: Boolean) {
        dp.setEnabled(enabled)
      }

      override fun release() {
        dp.release()
      }
    }
  }.getOrNull()
}

/**
 * Creates a platform API 28+ [DynamicsProcessing] Night-Mode DRC effect bound to [audioSessionId], returning `null`
 * safely on API < 28, invalid session IDs, or HAL exceptions (`#115`).
 */
internal fun createPlatformDynamicsProcessing(
  audioSessionId: Int,
  sdkInt: Int = Build.VERSION.SDK_INT,
): DrcEffect? {
  if (audioSessionId <= 0) return null
  if (sdkInt < Build.VERSION_CODES.P || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return null
  return Api28DynamicsProcessingFactory.create(audioSessionId)
}

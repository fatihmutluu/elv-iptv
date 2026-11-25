package io.github.fatihmutluu.elv.media3

import android.app.Activity
import java.lang.ref.WeakReference
import java.util.Locale
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.roundToLong

internal const val AFR_RATE_TOLERANCE = 0.15f
private const val AFR_TIE_EPSILON = 0.005f
private const val MAX_REFRESH_MULTIPLIER = 5
internal const val MAX_REFRESH_RATE_AUDIO_DELAY_OFFSET_MS = 1_000L

/** Auto frame-rate display matching policy (`#116`). */
internal enum class AutoFrameRateMode(val wireName: String) {
  OFF("off"),
  SEAMLESS("seamless"),
  ALWAYS("always"),
}

/** Parses wire AFR mode (`off` / `seamless` / `always`), defaulting to [defaultMode]. */
internal fun parseAutoFrameRateMode(
  raw: String?,
  defaultMode: AutoFrameRateMode = AutoFrameRateMode.SEAMLESS,
): AutoFrameRateMode =
  when (raw?.trim()?.lowercase(Locale.ROOT)) {
    AutoFrameRateMode.OFF.wireName -> AutoFrameRateMode.OFF
    AutoFrameRateMode.SEAMLESS.wireName -> AutoFrameRateMode.SEAMLESS
    AutoFrameRateMode.ALWAYS.wireName -> AutoFrameRateMode.ALWAYS
    else -> defaultMode
  }

/** Pure immutable snapshot of one Android `Display.Mode` for unit-testable AFR selection (#116). */
internal data class DisplayModeInfo(
  val modeId: Int,
  val physicalWidth: Int,
  val physicalHeight: Int,
  val refreshRate: Float,
  val alternativeRefreshRates: List<Float> = emptyList(),
)

/**
 * Selects the best [DisplayModeInfo.modeId] matching [contentFps] while preserving the active pixel resolution
 * `(physicalWidth, physicalHeight)` (#116):
 * - Returns `null` when [mode] is [AutoFrameRateMode.OFF], [contentFps] is non-positive/non-finite, or the current
 *   mode is already optimal.
 * - Prefers an exact refresh rate match (`|rate - contentFps| <= 0.15`), then an integer multiple (`2x..5x`, e.g.
 *   `23.976 -> 119.88`, `25 -> 50/100`).
 */
internal fun selectBestDisplayMode(
  modes: List<DisplayModeInfo>,
  currentModeId: Int,
  contentFps: Float,
  mode: AutoFrameRateMode,
): Int? {
  if (mode == AutoFrameRateMode.OFF) return null
  if (!contentFps.isFinite() || contentFps <= 0f) return null
  val current = modes.firstOrNull { it.modeId == currentModeId } ?: return null
  val sameRes = modes.filter {
    it.physicalWidth == current.physicalWidth &&
      it.physicalHeight == current.physicalHeight &&
      it.refreshRate.isFinite() &&
      it.refreshRate > 0f
  }
  if (sameRes.isEmpty()) return null

  val exact = pickBestForMultiplier(sameRes, currentModeId, contentFps, multiplier = 1)
  if (exact != null) {
    return if (exact.modeId == currentModeId) null else exact.modeId
  }

  // If no 1x exact match exists and current mode already matches a clean integer multiple (2x..5x), keep it.
  if (isIntegerMultipleMatch(current.refreshRate, contentFps)) return null

  var bestMultiple: DisplayModeInfo? = null
  var bestNormError = Float.MAX_VALUE
  var bestMult = Int.MAX_VALUE
  for (mult in 2..MAX_REFRESH_MULTIPLIER) {
    val candidate = pickBestForMultiplier(sameRes, currentModeId, contentFps, multiplier = mult) ?: continue
    val normError = abs(candidate.refreshRate - contentFps * mult) / mult.toFloat()
    val better = bestMultiple == null ||
      normError < bestNormError - AFR_TIE_EPSILON ||
      (abs(normError - bestNormError) <= AFR_TIE_EPSILON &&
        (candidate.modeId == currentModeId || (bestMultiple.modeId != currentModeId && mult < bestMult)))
    if (better) {
      bestMultiple = candidate
      bestNormError = normError
      bestMult = mult
    }
  }
  val chosen = bestMultiple ?: return null
  return if (chosen.modeId == currentModeId) null else chosen.modeId
}

private fun isIntegerMultipleMatch(refreshRate: Float, contentFps: Float): Boolean {
  if (!refreshRate.isFinite() || refreshRate <= 0f) return false
  for (mult in 2..MAX_REFRESH_MULTIPLIER) {
    if (abs(refreshRate - contentFps * mult) <= AFR_RATE_TOLERANCE) return true
  }
  return false
}

private fun pickBestForMultiplier(
  candidates: List<DisplayModeInfo>,
  currentModeId: Int,
  contentFps: Float,
  multiplier: Int,
): DisplayModeInfo? {
  val target = contentFps * multiplier
  var best: DisplayModeInfo? = null
  var bestDiff = Float.MAX_VALUE
  for (candidate in candidates) {
    val diff = abs(candidate.refreshRate - target)
    if (diff > AFR_RATE_TOLERANCE) continue
    val isBetter = best == null ||
      diff < bestDiff - AFR_TIE_EPSILON ||
      (abs(diff - bestDiff) <= AFR_TIE_EPSILON && candidate.modeId == currentModeId)
    if (isBetter) {
      best = candidate
      bestDiff = diff
    }
  }
  return best
}

/** Canonical refresh-rate bucket key used for per-refresh-rate A/V delay lookup (`#115`). */
internal fun canonicalRefreshRateBucket(rateHz: Float): String? {
  if (!rateHz.isFinite() || rateHz <= 0f) return null
  val snapped = snapStandardFrameRate(rateHz)
  return when (snapped) {
    23.976f -> "23.976"
    24f -> "24"
    25f -> "25"
    29.97f -> "29.97"
    30f -> "30"
    50f -> "50"
    59.94f -> "59.94"
    60f -> "60"
    else -> rateHz.roundToInt().takeIf { it > 0 }?.toString()
  }
}

/** Resolves the clamped `[-1000, 1000]` ms A/V sync offset for [activeRateHz] from [offsetsByRate] (`#115`). */
internal fun resolveAudioDelayOffsetForRefreshRate(
  offsetsByRate: Map<String, Long>,
  activeRateHz: Float?,
): Long {
  if (offsetsByRate.isEmpty() || activeRateHz == null || !activeRateHz.isFinite() || activeRateHz <= 0f) {
    return 0L
  }
  val canonical = canonicalRefreshRateBucket(activeRateHz)
  val raw = (if (canonical != null) offsetsByRate[canonical] else null)
    ?: offsetsByRate[activeRateHz.roundToInt().toString()]
    ?: return 0L
  return raw.coerceIn(-MAX_REFRESH_RATE_AUDIO_DELAY_OFFSET_MS, MAX_REFRESH_RATE_AUDIO_DELAY_OFFSET_MS)
}

/** Parses and clamps a JS per-refresh-rate A/V delay map (`Record<string, number>`, `#115`). */
internal fun parseAudioDelayByRefreshRate(raw: Any?): Map<String, Long> {
  val map = raw as? Map<*, *> ?: return emptyMap()
  if (map.isEmpty()) return emptyMap()
  val out = LinkedHashMap<String, Long>()
  for ((k, v) in map) {
    val key = (k as? String)?.trim()?.takeIf { it.isNotEmpty() && it.length <= 16 } ?: continue
    val ms = when (v) {
      is Double -> if (v.isFinite()) v.roundToLong() else continue
      is Float -> if (v.isFinite()) v.roundToLong() else continue
      is Number -> v.toLong()
      else -> continue
    }
    out[key] = ms.coerceIn(-MAX_REFRESH_RATE_AUDIO_DELAY_OFFSET_MS, MAX_REFRESH_RATE_AUDIO_DELAY_OFFSET_MS)
  }
  return out
}

/**
 * Coordinates Android `WindowManager.LayoutParams.preferredDisplayModeId` AFR switching and guaranteed default
 * restoration on stop/dispose/OFF (#116), while notifying [onActiveRefreshRateChanged] for per-refresh-rate A/V delay (#115).
 */
internal class DisplayRefreshController(
  private val activityProvider: () -> Activity?,
  private val readModes: (Activity) -> Pair<Int, List<DisplayModeInfo>>? = ::readDisplayModes,
  private val applyMode: (Activity, Int) -> Boolean = ::applyPreferredDisplayMode,
  private val restoreMode: (Activity) -> Boolean = ::restoreDefaultDisplayMode,
  private val onActiveRefreshRateChanged: (Float?) -> Unit = {},
) {
  var mode: AutoFrameRateMode = AutoFrameRateMode.SEAMLESS
    private set

  var activeRefreshRateHz: Float? = null
    private set

  private var appliedModeId: Int = 0
  private var appliedActivity: WeakReference<Activity>? = null

  /** Updates AFR policy; immediately restores the default display mode when switched to [AutoFrameRateMode.OFF]. */
  fun setMode(next: AutoFrameRateMode) {
    mode = next
    if (next == AutoFrameRateMode.OFF) {
      restoreDefault()
    }
  }

  /** Evaluates [contentFps] against the active display's supported modes and switches when appropriate. */
  fun onContentFrameRate(contentFps: Float) {
    if (!contentFps.isFinite() || contentFps <= 0f) return
    val activity = activityProvider()
    if (activity == null) {
      updateActiveRefreshRate(contentFps)
      return
    }
    val snapshot = readModes(activity)
    if (snapshot == null) {
      updateActiveRefreshRate(contentFps)
      return
    }
    val (currentModeId, modes) = snapshot
    val currentMode = modes.firstOrNull { it.modeId == currentModeId }
    if (mode == AutoFrameRateMode.OFF) {
      updateActiveRefreshRate(currentMode?.refreshRate)
      return
    }
    val targetModeId = selectBestDisplayMode(modes, currentModeId, contentFps, mode)
    if (targetModeId == null) {
      updateActiveRefreshRate(currentMode?.refreshRate ?: contentFps)
      return
    }
    val targetMode = modes.firstOrNull { it.modeId == targetModeId } ?: return
    val canApplyWindowSwitch = when (mode) {
      AutoFrameRateMode.OFF -> false
      AutoFrameRateMode.ALWAYS -> true
      AutoFrameRateMode.SEAMLESS ->
        currentMode?.alternativeRefreshRates?.any { abs(it - targetMode.refreshRate) <= AFR_RATE_TOLERANCE } == true
    }
    if (canApplyWindowSwitch && targetModeId != appliedModeId && applyMode(activity, targetModeId)) {
      appliedModeId = targetModeId
      appliedActivity = WeakReference(activity)
      updateActiveRefreshRate(targetMode.refreshRate)
    } else if (canApplyWindowSwitch && targetModeId == appliedModeId) {
      updateActiveRefreshRate(targetMode.refreshRate)
    } else {
      updateActiveRefreshRate(if (mode == AutoFrameRateMode.SEAMLESS) contentFps else currentMode?.refreshRate)
    }
  }

  /** Restores `preferredDisplayModeId = 0` on the activity whose display mode was modified; idempotent. */
  fun restoreDefault() {
    val hadOverride = appliedModeId != 0
    val targetActivity = appliedActivity?.get() ?: activityProvider()
    appliedModeId = 0
    appliedActivity = null
    if (hadOverride && targetActivity != null) {
      restoreMode(targetActivity)
    }
    updateActiveRefreshRate(null)
  }

  private fun updateActiveRefreshRate(rateHz: Float?) {
    if (activeRefreshRateHz != rateHz) {
      activeRefreshRateHz = rateHz
      onActiveRefreshRateChanged(rateHz)
    }
  }
}

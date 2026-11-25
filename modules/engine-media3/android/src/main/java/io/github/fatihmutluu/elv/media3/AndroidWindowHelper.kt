package io.github.fatihmutluu.elv.media3

import android.app.Activity
import android.app.PictureInPictureParams
import android.app.UiModeManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.os.Looper
import android.util.Rational
import android.view.OrientationEventListener
import android.view.View
import android.view.WindowManager
import androidx.annotation.RequiresApi
import androidx.core.app.OnPictureInPictureModeChangedProvider
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.util.Consumer
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.lang.ref.WeakReference
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.math.abs
import kotlin.math.round

internal const val MIN_PIP_ASPECT_NUM = 418_410
internal const val MIN_PIP_ASPECT_DEN = 1_000_000
internal const val MAX_PIP_ASPECT_NUM = 239
internal const val MAX_PIP_ASPECT_DEN = 100
internal const val ORIENTATION_TOLERANCE_DEGREES = 25

private const val MIN_PIP_ASPECT = MIN_PIP_ASPECT_NUM.toDouble() / MIN_PIP_ASPECT_DEN.toDouble()
private const val MAX_PIP_ASPECT = MAX_PIP_ASPECT_NUM.toDouble() / MAX_PIP_ASPECT_DEN.toDouble()
private const val PIP_FRACTIONAL_SCALE = 1_000.0
private const val PIP_UI_THREAD_TIMEOUT_MS = 500L

internal val ZERO_SAFE_AREA_INSETS: Map<String, Double> = mapOf(
  "top" to 0.0,
  "right" to 0.0,
  "bottom" to 0.0,
  "left" to 0.0,
)

/** True when [context] runs on Android TV / Fire TV (`UI_MODE_TYPE_TELEVISION` or `FEATURE_LEANBACK`, #143, #255). */
internal fun isTvDevice(context: Context): Boolean {
  val uiMode = runCatching {
    context.getSystemService(UiModeManager::class.java)?.currentModeType
  }.getOrNull()
  if (uiMode == Configuration.UI_MODE_TYPE_TELEVISION) return true
  val configUiMode = runCatching {
    (context.resources?.configuration?.uiMode ?: 0) and Configuration.UI_MODE_TYPE_MASK
  }.getOrNull()
  if (configUiMode == Configuration.UI_MODE_TYPE_TELEVISION) return true
  return runCatching {
    context.packageManager?.hasSystemFeature(PackageManager.FEATURE_LEANBACK) == true
  }.getOrDefault(false)
}

/**
 * Clamps a Picture-in-Picture aspect ratio strictly into Android's legal `[0.418410, 2.390000]` range
 * (`418410/1000000` .. `239/100`), defaulting to `16:9` when dimensions are non-positive (#266).
 */
internal fun clampPipAspectRatio(width: Int, height: Int): Pair<Int, Int> {
  if (width <= 0 || height <= 0) return 16 to 9
  val ratio = width.toDouble() / height.toDouble()
  return when {
    !ratio.isFinite() -> 16 to 9
    ratio < MIN_PIP_ASPECT -> MIN_PIP_ASPECT_NUM to MIN_PIP_ASPECT_DEN
    ratio > MAX_PIP_ASPECT -> MAX_PIP_ASPECT_NUM to MAX_PIP_ASPECT_DEN
    else -> width to height
  }
}

/**
 * Scales fractional floating-point PiP dimensions (e.g. `1.777, 1.0` -> `1777:1000`) before clamping into Android's
 * legal `[0.418410, 2.390000]` range, defaulting to `16:9` on null/non-finite/non-positive inputs (#266).
 */
internal fun clampPipAspectRatio(aspectWidth: Double?, aspectHeight: Double?): Pair<Int, Int> {
  val w = aspectWidth?.takeIf { it.isFinite() && it > 0.0 } ?: return 16 to 9
  val h = aspectHeight?.takeIf { it.isFinite() && it > 0.0 } ?: return 16 to 9
  val isFractional = w % 1.0 != 0.0 || h % 1.0 != 0.0
  val scale = if (isFractional && maxOf(w, h) < 1_000_000.0) PIP_FRACTIONAL_SCALE else 1.0
  val intW = round(w * scale).coerceIn(0.0, Int.MAX_VALUE.toDouble()).toInt()
  val intH = round(h * scale).coerceIn(0.0, Int.MAX_VALUE.toDouble()).toInt()
  return clampPipAspectRatio(intW, intH)
}

/**
 * True when the Android status bar is hidden in [insets], checking `Type.statusBars()` rather than
 * `Type.systemBars()` so gesture-navigation phones still report fullscreen accurately (#266).
 */
internal fun isStatusBarHidden(insets: WindowInsetsCompat?): Boolean =
  insets != null && !insets.isVisible(WindowInsetsCompat.Type.statusBars())

/**
 * Computes mobile safe area insets in dp as `max(systemBars, displayCutout) / density`, or all `0.0` on TV (#255).
 */
internal fun computeSafeAreaInsetsDp(
  systemLeft: Int,
  systemTop: Int,
  systemRight: Int,
  systemBottom: Int,
  cutoutLeft: Int,
  cutoutTop: Int,
  cutoutRight: Int,
  cutoutBottom: Int,
  density: Float,
  isTv: Boolean,
): Map<String, Double> {
  if (isTv) return ZERO_SAFE_AREA_INSETS
  val cleanDensity = if (density.isFinite() && density > 0f) density.toDouble() else 1.0
  fun edge(sys: Int, cut: Int): Double = maxOf(sys, cut, 0).toDouble() / cleanDensity
  return mapOf(
    "top" to edge(systemTop, cutoutTop),
    "right" to edge(systemRight, cutoutRight),
    "bottom" to edge(systemBottom, cutoutBottom),
    "left" to edge(systemLeft, cutoutLeft),
  )
}

/**
 * True when physical sensor [orientationDegrees] is within +/- 25 degrees of [targetLandscape] (`90`/`270` for
 * landscape, `0`/`180` for portrait), ignoring [OrientationEventListener.ORIENTATION_UNKNOWN] (#266).
 */
internal fun isSensorAlignedWithTarget(orientationDegrees: Int, targetLandscape: Boolean): Boolean {
  if (orientationDegrees == OrientationEventListener.ORIENTATION_UNKNOWN || orientationDegrees < 0) return false
  val normalized = orientationDegrees % 360
  return if (targetLandscape) {
    angularDistance(normalized, 90) <= ORIENTATION_TOLERANCE_DEGREES ||
      angularDistance(normalized, 270) <= ORIENTATION_TOLERANCE_DEGREES
  } else {
    angularDistance(normalized, 0) <= ORIENTATION_TOLERANCE_DEGREES ||
      angularDistance(normalized, 180) <= ORIENTATION_TOLERANCE_DEGREES
  }
}

private fun angularDistance(angle: Int, target: Int): Int {
  val diff = abs(angle - target) % 360
  return minOf(diff, 360 - diff)
}

/** Applies `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES` on non-TV API >= 28 activities for full-bleed playback (#255). */
internal fun applyShortEdgesCutoutMode(activity: Activity) {
  if (isTvDevice(activity)) return
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P) return
  activity.runOnUiThread {
    if (activity.isFinishing || activity.isDestroyed) return@runOnUiThread
    val window = activity.window ?: return@runOnUiThread
    val params = window.attributes ?: return@runOnUiThread
    if (params.layoutInDisplayCutoutMode != WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES) {
      params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      window.attributes = params
    }
  }
}

/** Extracts `max(systemBars, displayCutout)` in dp from [insets] (#255). */
internal fun extractSafeAreaInsetsDp(
  insets: WindowInsetsCompat,
  density: Float,
  isTv: Boolean,
): Map<String, Double> {
  if (isTv) return ZERO_SAFE_AREA_INSETS
  val sys = insets.getInsets(WindowInsetsCompat.Type.systemBars())
  val cut = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
  return computeSafeAreaInsetsDp(
    systemLeft = sys.left,
    systemTop = sys.top,
    systemRight = sys.right,
    systemBottom = sys.bottom,
    cutoutLeft = cut.left,
    cutoutTop = cut.top,
    cutoutRight = cut.right,
    cutoutBottom = cut.bottom,
    density = density,
    isTv = false,
  )
}

/** Reads the current safe area insets in dp for [activity], returning all zeroes on TV or unavailable decorView (#255). */
internal fun readSafeAreaInsetsDp(activity: Activity): Map<String, Double> {
  if (isTvDevice(activity)) return ZERO_SAFE_AREA_INSETS
  val decorView = activity.window?.decorView ?: return ZERO_SAFE_AREA_INSETS
  val rootInsets = ViewCompat.getRootWindowInsets(decorView) ?: return ZERO_SAFE_AREA_INSETS
  return extractSafeAreaInsetsDp(rootInsets, activity.resources.displayMetrics.density, isTv = false)
}

/**
 * Observes `WindowInsetsCompat` on [activity]'s decorView (non-TV only), forwarding deduplicated safe area insets
 * in dp and returning an idempotent cleanup lambda (#255).
 */
internal fun observeSafeAreaInsets(
  activity: Activity,
  onChange: (Map<String, Double>) -> Unit,
): () -> Unit {
  if (isTvDevice(activity)) return {}
  val decorRef = WeakReference<View>(activity.window?.decorView)
  val active = AtomicBoolean(true)
  var lastEmitted: Map<String, Double>? = null

  activity.runOnUiThread {
    if (!active.get() || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
    val decor = decorRef.get() ?: return@runOnUiThread
    ViewCompat.setOnApplyWindowInsetsListener(decor) { view, insets ->
      if (active.get()) {
        val next = extractSafeAreaInsetsDp(insets, view.resources.displayMetrics.density, isTv = false)
        if (next != lastEmitted) {
          lastEmitted = next
          onChange(next)
        }
      }
      ViewCompat.onApplyWindowInsets(view, insets)
    }
    ViewCompat.requestApplyInsets(decor)
  }

  return {
    if (active.compareAndSet(true, false)) {
      activity.runOnUiThread {
        decorRef.get()?.let { decor ->
          ViewCompat.setOnApplyWindowInsetsListener(decor, null)
        }
      }
    }
  }
}

/**
 * Observes Picture-in-Picture mode changes on non-TV activities implementing [OnPictureInPictureModeChangedProvider]
 * (`ComponentActivity` / `ReactActivity`), returning an idempotent cleanup lambda (#266).
 */
internal fun observePictureInPictureMode(
  activity: Activity,
  onChange: (Boolean) -> Unit,
): () -> Unit {
  if (isTvDevice(activity)) return {}
  val provider = activity as? OnPictureInPictureModeChangedProvider ?: return {}
  val providerRef = WeakReference(provider)
  val active = AtomicBoolean(true)
  val listener = Consumer<PictureInPictureModeChangedInfo> { info ->
    if (active.get()) {
      onChange(info.isInPictureInPictureMode)
    }
  }

  activity.runOnUiThread {
    if (!active.get() || activity.isFinishing || activity.isDestroyed) return@runOnUiThread
    providerRef.get()?.addOnPictureInPictureModeChangedListener(listener)
  }

  return {
    if (active.compareAndSet(true, false)) {
      activity.runOnUiThread {
        providerRef.get()?.removeOnPictureInPictureModeChangedListener(listener)
      }
    }
  }
}

/** True when [activity]'s status bar is hidden (gesture-nav safe, #266). */
internal fun isActivityStatusBarFullscreen(activity: Activity): Boolean {
  val decorView = activity.window?.decorView ?: return false
  return isStatusBarHidden(ViewCompat.getRootWindowInsets(decorView))
}

/**
 * Validates and rounds optional PiP `sourceRectHint` coordinates (`left`, `top`, `right`, `bottom`) into a
 * non-empty non-negative [Rect] (`right > left && bottom > top`), or returns `null` when omitted or invalid (#34).
 */
internal fun resolvePipSourceRect(
  left: Double?,
  top: Double?,
  right: Double?,
  bottom: Double?,
): Rect? {
  if (left == null || top == null || right == null || bottom == null) return null
  if (!left.isFinite() || !top.isFinite() || !right.isFinite() || !bottom.isFinite()) return null
  if (left < 0.0 || top < 0.0 || right <= left || bottom <= top) return null
  val l = round(left).coerceIn(0.0, Int.MAX_VALUE.toDouble()).toInt()
  val t = round(top).coerceIn(0.0, Int.MAX_VALUE.toDouble()).toInt()
  val r = round(right).coerceIn(0.0, Int.MAX_VALUE.toDouble()).toInt()
  val b = round(bottom).coerceIn(0.0, Int.MAX_VALUE.toDouble()).toInt()
  return if (r > l && b > t) Rect(l, t, r, b) else null
}

@RequiresApi(Build.VERSION_CODES.O)
private fun buildPipParams(
  aspectWidth: Int,
  aspectHeight: Int,
  sourceRect: Rect?,
  autoEnterEnabled: Boolean? = null,
  sdkInt: Int = Build.VERSION.SDK_INT,
): PictureInPictureParams {
  val builder = PictureInPictureParams.Builder()
    .setAspectRatio(Rational(aspectWidth, aspectHeight))
  if (sourceRect != null) {
    builder.setSourceRectHint(sourceRect)
  }
  if (autoEnterEnabled != null && sdkInt >= Build.VERSION_CODES.S && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
    applyPipAutoEnterEnabledApi31(builder, autoEnterEnabled)
  }
  return builder.build()
}

@RequiresApi(Build.VERSION_CODES.S)
private fun applyPipAutoEnterEnabledApi31(
  builder: PictureInPictureParams.Builder,
  enabled: Boolean,
) {
  builder.setAutoEnterEnabled(enabled)
}

@RequiresApi(Build.VERSION_CODES.S)
private fun applyAutoEnterPipParamsApi31(
  activity: Activity,
  enabled: Boolean,
  aspect: Pair<Int, Int>,
  sourceRect: Rect?,
): Boolean {
  val params = buildPipParams(
    aspectWidth = aspect.first,
    aspectHeight = aspect.second,
    sourceRect = sourceRect,
    autoEnterEnabled = enabled,
    sdkInt = Build.VERSION_CODES.S,
  )
  activity.setPictureInPictureParams(params)
  return true
}

private fun runOnActivityUiThreadSync(activity: Activity, action: () -> Boolean): Boolean {
  if (Looper.myLooper() == Looper.getMainLooper()) return action()
  val result = AtomicBoolean(false)
  val done = CountDownLatch(1)
  activity.runOnUiThread {
    try {
      result.set(action())
    } finally {
      done.countDown()
    }
  }
  done.await(PIP_UI_THREAD_TIMEOUT_MS, TimeUnit.MILLISECONDS)
  return result.get()
}

/**
 * Enters Android Picture-in-Picture mode with strictly clamped aspect ratio and optional `sourceRectHint` on
 * non-TV API >= 26 devices (#266, #34). Returns `false` on TV, unsupported API levels, finishing activities, or
 * OEM exceptions.
 */
internal fun enterPictureInPicture(
  activity: Activity,
  aspectWidth: Double?,
  aspectHeight: Double?,
  sourceLeft: Double? = null,
  sourceTop: Double? = null,
  sourceRight: Double? = null,
  sourceBottom: Double? = null,
  sdkInt: Int = Build.VERSION.SDK_INT,
): Boolean {
  if (isTvDevice(activity)) return false
  if (sdkInt < Build.VERSION_CODES.O) return false
  if (activity.isFinishing || activity.isDestroyed) return false
  val (w, h) = clampPipAspectRatio(aspectWidth, aspectHeight)
  val sourceRect = resolvePipSourceRect(sourceLeft, sourceTop, sourceRight, sourceBottom)

  return runOnActivityUiThreadSync(activity) {
    runCatching {
      if (activity.isFinishing || activity.isDestroyed) return@runCatching false
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@runCatching false
      val params = buildPipParams(w, h, sourceRect, autoEnterEnabled = null, sdkInt = sdkInt)
      activity.enterPictureInPictureMode(params)
    }.getOrDefault(false)
  }
}

/**
 * Configures Android 12+ (API 31+) `PictureInPictureParams.Builder.setAutoEnterEnabled` with clamped aspect ratio
 * and optional `sourceRectHint` on non-TV devices (#34). Returns `false` safely on TV, API < 31, finishing
 * activities, or OEM exceptions.
 */
internal fun setAutoEnterPictureInPicture(
  activity: Activity,
  enabled: Boolean,
  aspectWidth: Double? = null,
  aspectHeight: Double? = null,
  sourceLeft: Double? = null,
  sourceTop: Double? = null,
  sourceRight: Double? = null,
  sourceBottom: Double? = null,
  sdkInt: Int = Build.VERSION.SDK_INT,
  applyAutoEnter: ((Activity, Boolean, Pair<Int, Int>, Rect?) -> Boolean)? = null,
): Boolean {
  if (isTvDevice(activity)) return false
  if (sdkInt < Build.VERSION_CODES.S) return false
  if (activity.isFinishing || activity.isDestroyed) return false
  val aspect = clampPipAspectRatio(aspectWidth, aspectHeight)
  val sourceRect = resolvePipSourceRect(sourceLeft, sourceTop, sourceRight, sourceBottom)

  return runOnActivityUiThreadSync(activity) {
    runCatching {
      if (activity.isFinishing || activity.isDestroyed) return@runCatching false
      if (applyAutoEnter != null) {
        applyAutoEnter(activity, enabled, aspect, sourceRect)
      } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        applyAutoEnterPipParamsApi31(activity, enabled, aspect, sourceRect)
      } else {
        false
      }
    }.getOrDefault(false)
  }
}

/**
 * Sensor-guided temporary orientation controller (#266):
 * - Enables [OrientationEventListener] ONLY while a temporary orientation override is active.
 * - Restores `SCREEN_ORIENTATION_UNSPECIFIED` and disables the sensor once physical angle matches the target.
 * - Immediately disables the sensor on touch lock (`setLocked(true)`), `clear()`, or `dispose()` (zero sensor leaks).
 */
internal class SmartOrientationController(
  private val createSensorListener: (Context, (Int) -> Unit) -> SensorHandle = ::androidOrientationSensor,
) {
  internal interface SensorHandle {
    fun canDetectOrientation(): Boolean
    fun enable()
    fun disable()
  }

  private val lock = Any()
  private var touchLocked = false
  private var targetLandscape: Boolean? = null
  private var activeActivity: WeakReference<Activity>? = null
  private var sensor: SensorHandle? = null

  /** Locks or unlocks the current activity orientation for touch lock (#440), disabling any temporary sensor watcher. */
  fun setLocked(activity: Activity, locked: Boolean) {
    if (isTvDevice(activity)) return
    val oldSensor: SensorHandle?
    synchronized(lock) {
      touchLocked = locked
      targetLandscape = null
      activeActivity = null
      oldSensor = sensor
      sensor = null
    }
    oldSensor?.disable()
    val orientation = if (locked) {
      ActivityInfo.SCREEN_ORIENTATION_LOCKED
    } else {
      ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
    }
    applyOrientation(activity, orientation)
  }

  /** Requests a temporary [landscape] or portrait orientation that auto-releases once the physical sensor aligns. */
  fun requestTemporaryOrientation(activity: Activity, landscape: Boolean) {
    if (isTvDevice(activity)) return
    val oldSensor: SensorHandle?
    val newSensor: SensorHandle?
    synchronized(lock) {
      if (touchLocked) return
      oldSensor = sensor
      sensor = null
      targetLandscape = landscape
      activeActivity = WeakReference(activity)
      val candidate = createSensorListener(activity.applicationContext ?: activity) { degrees ->
        onSensorAngle(degrees)
      }
      newSensor = if (candidate.canDetectOrientation()) {
        sensor = candidate
        candidate
      } else {
        null
      }
    }
    oldSensor?.disable()
    val requested = if (landscape) {
      ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
    } else {
      ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT
    }
    applyOrientation(activity, requested)
    if (newSensor != null) {
      var shouldDisable = false
      synchronized(lock) {
        if (sensor === newSensor && !touchLocked) {
          newSensor.enable()
        } else {
          shouldDisable = true
        }
      }
      if (shouldDisable) newSensor.disable()
    }
  }

  /** Clears any active temporary orientation request and immediately disables the orientation sensor. */
  fun clear() {
    val oldSensor: SensorHandle?
    synchronized(lock) {
      targetLandscape = null
      activeActivity = null
      oldSensor = sensor
      sensor = null
    }
    oldSensor?.disable()
  }

  /** Releases sensor resources on module destruction; idempotent. */
  fun dispose() = clear()

  private fun onSensorAngle(degrees: Int) {
    val activityToRelease: Activity?
    val sensorToDisable: SensorHandle?
    synchronized(lock) {
      val target = targetLandscape ?: return
      if (touchLocked || !isSensorAlignedWithTarget(degrees, target)) return
      targetLandscape = null
      activityToRelease = activeActivity?.get()
      activeActivity = null
      sensorToDisable = sensor
      sensor = null
    }
    sensorToDisable?.disable()
    if (activityToRelease != null) {
      applyOrientation(activityToRelease, ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
    }
  }

  private fun applyOrientation(activity: Activity, orientation: Int) {
    activity.runOnUiThread {
      if (!activity.isFinishing && !activity.isDestroyed) {
        activity.requestedOrientation = orientation
      }
    }
  }
}

private fun androidOrientationSensor(
  context: Context,
  onAngle: (Int) -> Unit,
): SmartOrientationController.SensorHandle {
  val listener = object : OrientationEventListener(context) {
    override fun onOrientationChanged(orientation: Int) = onAngle(orientation)
  }
  return object : SmartOrientationController.SensorHandle {
    override fun canDetectOrientation(): Boolean = runCatching { listener.canDetectOrientation() }.getOrDefault(false)
    override fun enable() {
      runCatching { listener.enable() }
    }
    override fun disable() {
      runCatching { listener.disable() }
    }
  }
}

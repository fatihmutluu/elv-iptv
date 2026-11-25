package io.github.fatihmutluu.elv.media3

import android.app.Activity
import android.app.UiModeManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.Rect
import android.os.Build
import android.view.OrientationEventListener
import androidx.core.app.OnPictureInPictureModeChangedProvider
import androidx.core.app.PictureInPictureModeChangedInfo
import androidx.core.graphics.Insets
import androidx.core.util.Consumer
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows

@RunWith(RobolectricTestRunner::class)
class AndroidWindowHelperTest {
  private class FakeSensorHandle(
    private val canDetect: Boolean = true,
  ) : SmartOrientationController.SensorHandle {
    var enabled = false
    var enableCount = 0
    var disableCount = 0
    var listener: ((Int) -> Unit)? = null

    override fun canDetectOrientation(): Boolean = canDetect

    override fun enable() {
      enabled = true
      enableCount += 1
    }

    override fun disable() {
      enabled = false
      disableCount += 1
    }

    fun emitOrientation(degrees: Int) {
      if (enabled) listener?.invoke(degrees)
    }
  }

  @Test
  fun `detects TV devices via Leanback feature or UI_MODE_TYPE_TELEVISION (#255, #266)`() {
    val app = RuntimeEnvironment.getApplication()
    assertFalse("default Robolectric environment is not TV", isTvDevice(app))

    Shadows.shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_LEANBACK, true)
    assertTrue("FEATURE_LEANBACK must be detected as TV", isTvDevice(app))

    Shadows.shadowOf(app.packageManager).setSystemFeature(PackageManager.FEATURE_LEANBACK, false)
    val prevUiMode = app.resources.configuration.uiMode
    app.resources.configuration.uiMode =
      (prevUiMode and Configuration.UI_MODE_TYPE_MASK.inv()) or Configuration.UI_MODE_TYPE_TELEVISION
    try {
      assertTrue("UI_MODE_TYPE_TELEVISION must be detected as TV", isTvDevice(app))
    } finally {
      app.resources.configuration.uiMode = prevUiMode
    }
  }

  @Test
  fun `clamps PiP aspect ratios strictly to Android bounds with 16 to 9 fallback (#266)`() {
    assertEquals(16 to 9, clampPipAspectRatio(0, 1080))
    assertEquals(16 to 9, clampPipAspectRatio(1920, 0))
    assertEquals(16 to 9, clampPipAspectRatio(-1920, 1080))
    assertEquals(16 to 9, clampPipAspectRatio(1920, -1080))

    assertEquals(1920 to 1080, clampPipAspectRatio(1920, 1080))
    assertEquals(4 to 3, clampPipAspectRatio(4, 3))
    assertEquals(1 to 1, clampPipAspectRatio(1, 1))

    // Exact boundaries remain untouched
    assertEquals(MIN_PIP_ASPECT_NUM to MIN_PIP_ASPECT_DEN, clampPipAspectRatio(MIN_PIP_ASPECT_NUM, MIN_PIP_ASPECT_DEN))
    assertEquals(MAX_PIP_ASPECT_NUM to MAX_PIP_ASPECT_DEN, clampPipAspectRatio(MAX_PIP_ASPECT_NUM, MAX_PIP_ASPECT_DEN))

    // Ultrawide (> 2.39) clamps to 239:100
    assertEquals(239 to 100, clampPipAspectRatio(3840, 1080))
    assertEquals(239 to 100, clampPipAspectRatio(240, 100))

    // Tall portrait (< 0.418410) clamps to 418410:1000000
    assertEquals(418_410 to 1_000_000, clampPipAspectRatio(100, 1000))
    assertEquals(418_410 to 1_000_000, clampPipAspectRatio(418_409, 1_000_000))
  }

  @Test
  fun `checks statusBars visibility instead of systemBars for gesture-nav fullscreen (#266)`() {
    assertFalse("null insets must not report hidden status bar", isStatusBarHidden(null))

    val visibleStatusBar = WindowInsetsCompat.Builder()
      .setSystemWindowInsets(Insets.of(0, 72, 0, 48))
      .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, 72, 0, 0))
      .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, 48))
      .setVisible(WindowInsetsCompat.Type.statusBars(), true)
      .setVisible(WindowInsetsCompat.Type.navigationBars(), true)
      .build()
    assertFalse("visible status bar must return false", isStatusBarHidden(visibleStatusBar))

    // Fullscreen video on gesture-nav phone: status bar hidden, bottom gesture bar still present
    val gestureFullscreen = WindowInsetsCompat.Builder()
      .setSystemWindowInsets(Insets.of(0, 0, 0, 48))
      .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.NONE)
      .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, 48))
      .setVisible(WindowInsetsCompat.Type.statusBars(), false)
      .setVisible(WindowInsetsCompat.Type.navigationBars(), true)
      .build()
    assertTrue("status bar hidden with visible gesture bar must still report fullscreen", isStatusBarHidden(gestureFullscreen))
  }

  @Test
  fun `computes safe area insets in dp as max(systemBars, displayCutout) and zeroes them on TV (#255)`() {
    val mobile = computeSafeAreaInsetsDp(
      systemLeft = 0,
      systemTop = 48,
      systemRight = 24,
      systemBottom = 60,
      cutoutLeft = 90,
      cutoutTop = 72,
      cutoutRight = 0,
      cutoutBottom = 12,
      density = 3f,
      isTv = false,
    )
    assertEquals(24.0, mobile["top"]!!, 0.001)
    assertEquals(8.0, mobile["right"]!!, 0.001)
    assertEquals(20.0, mobile["bottom"]!!, 0.001)
    assertEquals(30.0, mobile["left"]!!, 0.001)

    val tv = computeSafeAreaInsetsDp(
      systemLeft = 90,
      systemTop = 90,
      systemRight = 90,
      systemBottom = 90,
      cutoutLeft = 90,
      cutoutTop = 90,
      cutoutRight = 90,
      cutoutBottom = 90,
      density = 2f,
      isTv = true,
    )
    assertEquals(ZERO_SAFE_AREA_INSETS, tv)
  }

  @Test
  fun `evaluates sensor orientation alignment with 25-degree tolerance and ignores unknown (#266)`() {
    assertFalse(isSensorAlignedWithTarget(OrientationEventListener.ORIENTATION_UNKNOWN, targetLandscape = true))
    assertFalse(isSensorAlignedWithTarget(OrientationEventListener.ORIENTATION_UNKNOWN, targetLandscape = false))

    // Landscape: 90 +/- 25 and 270 +/- 25
    assertTrue(isSensorAlignedWithTarget(90, targetLandscape = true))
    assertTrue(isSensorAlignedWithTarget(65, targetLandscape = true))
    assertTrue(isSensorAlignedWithTarget(115, targetLandscape = true))
    assertFalse(isSensorAlignedWithTarget(64, targetLandscape = true))
    assertFalse(isSensorAlignedWithTarget(116, targetLandscape = true))
    assertTrue(isSensorAlignedWithTarget(270, targetLandscape = true))
    assertTrue(isSensorAlignedWithTarget(245, targetLandscape = true))
    assertTrue(isSensorAlignedWithTarget(295, targetLandscape = true))
    assertFalse(isSensorAlignedWithTarget(0, targetLandscape = true))

    // Portrait: 0 +/- 25 (with 360 wrap) and 180 +/- 25
    assertTrue(isSensorAlignedWithTarget(0, targetLandscape = false))
    assertTrue(isSensorAlignedWithTarget(25, targetLandscape = false))
    assertTrue(isSensorAlignedWithTarget(335, targetLandscape = false))
    assertTrue(isSensorAlignedWithTarget(359, targetLandscape = false))
    assertFalse(isSensorAlignedWithTarget(26, targetLandscape = false))
    assertFalse(isSensorAlignedWithTarget(334, targetLandscape = false))
    assertTrue(isSensorAlignedWithTarget(180, targetLandscape = false))
    assertTrue(isSensorAlignedWithTarget(155, targetLandscape = false))
    assertTrue(isSensorAlignedWithTarget(205, targetLandscape = false))
    assertFalse(isSensorAlignedWithTarget(90, targetLandscape = false))
  }

  @Test
  fun `SmartOrientationController releases temporary orientation once sensor aligns and disables on touch lock or dispose (#266)`() {
    val activity = Robolectric.buildActivity(Activity::class.java).create().get()
    val handles = mutableListOf<FakeSensorHandle>()
    val controller = SmartOrientationController { _, onAngle ->
      FakeSensorHandle().also {
        it.listener = onAngle
        handles += it
      }
    }

    // Request temporary landscape
    controller.requestTemporaryOrientation(activity, landscape = true)
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, activity.requestedOrientation)
    assertEquals(1, handles.size)
    assertTrue("sensor listener must be enabled during temporary request", handles[0].enabled)

    // Still upright -> keeps landscape lock
    handles[0].emitOrientation(0)
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE, activity.requestedOrientation)
    assertTrue(handles[0].enabled)

    // Device physically rotated to landscape (90 deg) -> releases to UNSPECIFIED and disables sensor
    handles[0].emitOrientation(90)
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, activity.requestedOrientation)
    assertFalse("sensor listener must disable immediately once aligned", handles[0].enabled)

    // Request temporary portrait, then touch-lock engages -> sensor disabled immediately and locked
    controller.requestTemporaryOrientation(activity, landscape = false)
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT, activity.requestedOrientation)
    assertTrue(handles.last().enabled)

    controller.setLocked(activity, locked = true)
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_LOCKED, activity.requestedOrientation)
    assertFalse("touch lock must disable sensor listener immediately", handles.last().enabled)

    // Temporary orientation request while touch-locked is ignored
    val countBefore = handles.size
    controller.requestTemporaryOrientation(activity, landscape = true)
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_LOCKED, activity.requestedOrientation)
    assertEquals(countBefore, handles.size)

    // Unlock restores UNSPECIFIED; dispose disables any active listener
    controller.setLocked(activity, locked = false)
    assertEquals(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED, activity.requestedOrientation)
    controller.requestTemporaryOrientation(activity, landscape = true)
    assertTrue(handles.last().enabled)
    controller.dispose()
    assertFalse("dispose must disable sensor listener cleanly", handles.last().enabled)
  }

  @Test
  fun `enterPictureInPicture returns false on TV and unsupported API levels (#266)`() {
    val activity = Robolectric.buildActivity(Activity::class.java).create().get()
    Shadows.shadowOf(activity.packageManager).setSystemFeature(PackageManager.FEATURE_LEANBACK, true)
    assertFalse("PiP must return false on TV devices", enterPictureInPicture(activity, 1920.0, 1080.0))
    assertFalse(
      "PiP with sourceRect must return false on TV devices",
      enterPictureInPicture(activity, 1920.0, 1080.0, 0.0, 0.0, 1080.0, 608.0),
    )
  }

  @Test
  fun `resolvePipSourceRect validates non-empty non-negative bounds and rounds fractional coordinates (#34)`() {
    assertEquals(null, resolvePipSourceRect(null, 0.0, 100.0, 100.0))
    assertEquals(null, resolvePipSourceRect(0.0, null, 100.0, 100.0))
    assertEquals(null, resolvePipSourceRect(0.0, 0.0, null, 100.0))
    assertEquals(null, resolvePipSourceRect(0.0, 0.0, 100.0, null))
    assertEquals(null, resolvePipSourceRect(Double.NaN, 0.0, 100.0, 100.0))
    assertEquals(null, resolvePipSourceRect(0.0, 0.0, Double.POSITIVE_INFINITY, 100.0))
    assertEquals(null, resolvePipSourceRect(-1.0, 0.0, 100.0, 100.0))
    assertEquals(null, resolvePipSourceRect(0.0, -5.0, 100.0, 100.0))
    assertEquals(null, resolvePipSourceRect(100.0, 0.0, 100.0, 100.0))
    assertEquals(null, resolvePipSourceRect(120.0, 0.0, 100.0, 100.0))
    assertEquals(null, resolvePipSourceRect(0.0, 100.0, 100.0, 100.0))
    assertEquals(null, resolvePipSourceRect(10.4, 20.0, 10.45, 50.0))

    assertEquals(Rect(0, 0, 1080, 608), resolvePipSourceRect(0.0, 0.0, 1080.0, 608.0))
    assertEquals(Rect(10, 21, 300, 201), resolvePipSourceRect(10.2, 20.7, 300.4, 200.6))
  }

  @Test
  fun `setAutoEnterPictureInPicture gates on API 31+, non-TV, and forwards clamped aspect ratio and sourceRect (#34)`() {
    val activity = Robolectric.buildActivity(Activity::class.java).create().get()
    var appliedCalls = 0
    var lastEnabled: Boolean? = null
    var lastAspect: Pair<Int, Int>? = null
    var lastRect: Rect? = null

    val fakeApply: (Activity, Boolean, Pair<Int, Int>, Rect?) -> Boolean = { _, enabled, aspect, rect ->
      appliedCalls += 1
      lastEnabled = enabled
      lastAspect = aspect
      lastRect = rect
      true
    }

    // API < 31 returns false cleanly without invoking API 31 builder
    assertFalse(
      setAutoEnterPictureInPicture(
        activity = activity,
        enabled = true,
        aspectWidth = 16.0,
        aspectHeight = 9.0,
        sdkInt = Build.VERSION_CODES.R,
        applyAutoEnter = fakeApply,
      ),
    )
    assertEquals(0, appliedCalls)

    // API 31+ on mobile applies clamped aspect ratio and validated sourceRect
    assertTrue(
      setAutoEnterPictureInPicture(
        activity = activity,
        enabled = true,
        aspectWidth = 3840.0,
        aspectHeight = 1080.0,
        sourceLeft = 10.0,
        sourceTop = 20.0,
        sourceRight = 1010.0,
        sourceBottom = 580.0,
        sdkInt = Build.VERSION_CODES.S,
        applyAutoEnter = fakeApply,
      ),
    )
    assertEquals(1, appliedCalls)
    assertEquals(true, lastEnabled)
    assertEquals(239 to 100, lastAspect)
    assertEquals(Rect(10, 20, 1010, 580), lastRect)

    // Disabling auto-enter with invalid rect omits sourceRect
    assertTrue(
      setAutoEnterPictureInPicture(
        activity = activity,
        enabled = false,
        aspectWidth = 16.0,
        aspectHeight = 9.0,
        sourceLeft = 50.0,
        sourceTop = 50.0,
        sourceRight = 50.0,
        sourceBottom = 100.0,
        sdkInt = Build.VERSION_CODES.S,
        applyAutoEnter = fakeApply,
      ),
    )
    assertEquals(2, appliedCalls)
    assertEquals(false, lastEnabled)
    assertEquals(16 to 9, lastAspect)
    assertEquals(null, lastRect)

    // OEM exception returns false safely
    assertFalse(
      setAutoEnterPictureInPicture(
        activity = activity,
        enabled = true,
        aspectWidth = 16.0,
        aspectHeight = 9.0,
        sdkInt = Build.VERSION_CODES.S,
        applyAutoEnter = { _, _, _, _ -> throw IllegalStateException("OEM PiP disabled") },
      ),
    )

    // TV device returns false even on API 31+
    Shadows.shadowOf(activity.packageManager).setSystemFeature(PackageManager.FEATURE_LEANBACK, true)
    assertFalse(
      setAutoEnterPictureInPicture(
        activity = activity,
        enabled = true,
        aspectWidth = 16.0,
        aspectHeight = 9.0,
        sdkInt = Build.VERSION_CODES.S,
        applyAutoEnter = fakeApply,
      ),
    )
    assertEquals(2, appliedCalls)
  }

  @Test
  fun `scales fractional Double PiP aspect ratios before clamping instead of truncating to 1 to 1 (#266)`() {
    assertEquals(1777 to 1000, clampPipAspectRatio(1.777, 1.0))
    assertEquals(1920 to 1080, clampPipAspectRatio(1920.0, 1080.0))
    assertEquals(239 to 100, clampPipAspectRatio(3.5, 1.0))
    assertEquals(418_410 to 1_000_000, clampPipAspectRatio(0.2, 1.0))
    assertEquals(16 to 9, clampPipAspectRatio(null, 1.0))
    assertEquals(16 to 9, clampPipAspectRatio(Double.NaN, 1.0))
  }

  @Test
  fun `observePictureInPictureMode forwards PiP callbacks, unregisters cleanly, and skips TV (#266)`() {
    val pipActivity = Robolectric.buildActivity(TestPipActivity::class.java).create().get()
    val events = mutableListOf<Boolean>()
    val detach = observePictureInPictureMode(pipActivity) { events += it }
    assertEquals(1, pipActivity.pipListenerCount)

    pipActivity.dispatchPipModeChanged(true)
    pipActivity.dispatchPipModeChanged(false)
    assertEquals(listOf(true, false), events)

    // Cleanup unregisters listener so later PiP changes are ignored
    detach()
    assertEquals("detach must unregister PiP listener", 0, pipActivity.pipListenerCount)
    pipActivity.dispatchPipModeChanged(true)
    assertEquals("detached observer must stop receiving PiP callbacks", listOf(true, false), events)

    // Plain Activity (not OnPictureInPictureModeChangedProvider) is a safe no-op
    val plainActivity = Robolectric.buildActivity(Activity::class.java).create().get()
    val plainDetach = observePictureInPictureMode(plainActivity) { events += it }
    plainDetach()

    // TV activity is strictly skipped
    Shadows.shadowOf(pipActivity.packageManager).setSystemFeature(PackageManager.FEATURE_LEANBACK, true)
    val tvEvents = mutableListOf<Boolean>()
    val tvDetach = observePictureInPictureMode(pipActivity) { tvEvents += it }
    assertEquals("TV devices must not register PiP listeners", 0, pipActivity.pipListenerCount)
    pipActivity.dispatchPipModeChanged(true)
    assertTrue("TV devices must not observe PiP mode changes", tvEvents.isEmpty())
    tvDetach()
  }

  @Test
  fun `SmartOrientationController does not leak enabled sensor if disposed or locked mid-request (#266)`() {
    var onRequestedOrientation: (() -> Unit)? = null
    val racingActivity = Robolectric.buildActivity(RacingOrientationActivity::class.java).create().get()
    racingActivity.onOrientationSet = { onRequestedOrientation?.invoke() }

    val handles = mutableListOf<FakeSensorHandle>()
    val controller = SmartOrientationController { _, onAngle ->
      FakeSensorHandle().also {
        it.listener = onAngle
        handles += it
      }
    }

    // Race 1: dispose() runs after sensor is created/stored and before enable()
    onRequestedOrientation = { controller.dispose() }
    controller.requestTemporaryOrientation(racingActivity, landscape = true)
    assertEquals(1, handles.size)
    assertFalse("disposed controller must never leave sensor enabled", handles[0].enabled)
    assertEquals("sensor must not be enabled after dispose", 0, handles[0].enableCount)

    // Race 2: setLocked(true) runs after sensor is created/stored and before enable()
    onRequestedOrientation = {
      onRequestedOrientation = null
      controller.setLocked(racingActivity, locked = true)
    }
    controller.requestTemporaryOrientation(racingActivity, landscape = true)
    assertEquals(2, handles.size)
    assertFalse("touch-locked controller must never leave sensor enabled", handles[1].enabled)
    assertEquals("sensor must not be enabled after setLocked(true)", 0, handles[1].enableCount)
  }

  @Test
  fun `observeSafeAreaInsets reads current displayMetrics density dynamically on each insets dispatch (#255)`() {
    val activity = Robolectric.buildActivity(Activity::class.java).create().get()
    val decor = activity.window.decorView
    val received = mutableListOf<Map<String, Double>>()
    activity.resources.displayMetrics.density = 2f
    val detach = observeSafeAreaInsets(activity) { received += it }
    try {
      val insets = WindowInsetsCompat.Builder()
        .setSystemWindowInsets(Insets.of(0, 60, 0, 0))
        .setInsets(WindowInsetsCompat.Type.systemBars(), Insets.of(0, 60, 0, 0))
        .build()

      ViewCompat.dispatchApplyWindowInsets(decor, insets)
      assertEquals(30.0, received.last()["top"]!!, 0.001)

      // Density changes dynamically (e.g. foldable / display zoom): next dispatch uses updated density
      activity.resources.displayMetrics.density = 3f
      ViewCompat.dispatchApplyWindowInsets(decor, insets)
      assertEquals(20.0, received.last()["top"]!!, 0.001)
    } finally {
      detach()
    }
  }

  @Test
  fun `applyPreferredDisplayMode and restoreDefaultDisplayMode update preferredDisplayModeId safely (#116)`() {
    val activity = Robolectric.buildActivity(Activity::class.java).create().get()
    assertFalse(applyPreferredDisplayMode(activity, modeId = -1))
    assertFalse(applyPreferredDisplayMode(activity, modeId = 3, sdkInt = Build.VERSION_CODES.LOLLIPOP_MR1))
    assertTrue(applyPreferredDisplayMode(activity, modeId = 5))
    assertEquals(5, activity.window.attributes.preferredDisplayModeId)
    assertTrue(restoreDefaultDisplayMode(activity))
    assertEquals(0, activity.window.attributes.preferredDisplayModeId)
  }

  class TestPipActivity : Activity(), OnPictureInPictureModeChangedProvider {
    private val listeners = java.util.concurrent.CopyOnWriteArrayList<Consumer<PictureInPictureModeChangedInfo>>()

    override fun addOnPictureInPictureModeChangedListener(listener: Consumer<PictureInPictureModeChangedInfo>) {
      listeners += listener
    }

    override fun removeOnPictureInPictureModeChangedListener(listener: Consumer<PictureInPictureModeChangedInfo>) {
      listeners -= listener
    }

    fun dispatchPipModeChanged(inPip: Boolean) {
      val info = PictureInPictureModeChangedInfo(inPip)
      listeners.forEach { it.accept(info) }
    }

    val pipListenerCount: Int
      get() = listeners.size
  }

  class RacingOrientationActivity : Activity() {
    var onOrientationSet: (() -> Unit)? = null

    override fun setRequestedOrientation(requestedOrientation: Int) {
      super.setRequestedOrientation(requestedOrientation)
      onOrientationSet?.invoke()
    }
  }
}

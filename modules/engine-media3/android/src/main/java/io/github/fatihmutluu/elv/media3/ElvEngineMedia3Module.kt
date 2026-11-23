package io.github.fatihmutluu.elv.media3

import android.app.Activity
import android.content.ActivityNotFoundException
import android.os.SystemClock
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.lang.ref.WeakReference
import java.util.Collections
import kotlin.concurrent.thread

/**
 * Exposes the Media3 engine as the shared object class `Engine` with the player core spec 5.1 commands and
 * `onEngineEvent`, plus `uptimeMs()`, TV HDMI-CEC standby (`onStandbyChanged`), mobile display-cutout safe area
 * insets (`onSafeAreaInsetsChanged`), orientation/PiP window controls (`onPictureInPictureChanged`), and
 * `Media3SurfaceView`. Engines and listeners still alive when the module destroys are cleaned up automatically.
 */
class ElvEngineMedia3Module : Module() {
  private val engines: MutableSet<Media3Engine> = Collections.synchronizedSet(mutableSetOf())
  private val orientationController = SmartOrientationController()
  private val lifecycleLock = Any()
  private var standbyMonitor: StandbyMonitor? = null
  private var detachSafeAreaObserver: (() -> Unit)? = null
  private var observedInsetsActivity: WeakReference<Activity>? = null
  private var detachPipObserver: (() -> Unit)? = null
  private var observedPipActivity: WeakReference<Activity>? = null
  private var pendingPlaylistPick: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("ElvEngineMedia3")

    Events("onStandbyChanged", "onSafeAreaInsetsChanged", "onPictureInPictureChanged")

    Function("uptimeMs") {
      SystemClock.uptimeMillis().toDouble()
    }

    Function("setOrientationLocked") { locked: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      orientationController.setLocked(activity, locked)
    }

    Function("requestTemporaryOrientation") { landscape: Boolean ->
      val activity = appContext.currentActivity ?: return@Function
      orientationController.requestTemporaryOrientation(activity, landscape)
    }

    Function("applyShortEdgesCutoutMode") {
      val activity = appContext.currentActivity
      if (activity != null) applyShortEdgesCutoutMode(activity)
      Unit
    }

    Function("getSafeAreaInsets") {
      val activity = appContext.currentActivity ?: return@Function ZERO_SAFE_AREA_INSETS
      readSafeAreaInsetsDp(activity)
    }

    Function("isStatusBarFullscreen") {
      val activity = appContext.currentActivity ?: return@Function false
      isActivityStatusBarFullscreen(activity)
    }

    Function("enterPictureInPicture") { aspectWidth: Double?, aspectHeight: Double? ->
      val activity = appContext.currentActivity ?: return@Function false
      enterPictureInPicture(activity, aspectWidth, aspectHeight)
    }

    Function("notifyPictureInPictureModeChanged") { inPip: Boolean ->
      runCatching {
        sendEvent("onPictureInPictureChanged", mapOf("inPip" to inPip))
      }
    }

    AsyncFunction("readClipboardText") { ->
      val context = appContext.currentActivity ?: appContext.reactContext ?: return@AsyncFunction null
      readClipboardTextFromContext(context)
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("pickPlaylistFile") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val intent = createPlaylistPickerIntent()
      val canHandle = runCatching { intent.resolveActivity(activity.packageManager) != null }.getOrDefault(false)
      if (!canHandle) {
        promise.resolve(null)
        return@AsyncFunction
      }
      val displaced = synchronized(lifecycleLock) {
        val prev = pendingPlaylistPick
        pendingPlaylistPick = promise
        prev
      }
      displaced?.resolve(null)
      try {
        activity.startActivityForResult(intent, PICK_PLAYLIST_REQUEST_CODE)
      } catch (_: ActivityNotFoundException) {
        clearPendingPickIfSame(promise)?.resolve(null)
      } catch (_: SecurityException) {
        clearPendingPickIfSame(promise)?.resolve(null)
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { activity, payload ->
      if (payload.requestCode != PICK_PLAYLIST_REQUEST_CODE) return@OnActivityResult
      val promise = synchronized(lifecycleLock) {
        val pending = pendingPlaylistPick
        pendingPlaylistPick = null
        pending
      } ?: return@OnActivityResult
      val uri = if (payload.resultCode == Activity.RESULT_OK) payload.data?.data else null
      if (uri == null) {
        promise.resolve(null)
        return@OnActivityResult
      }
      val appCtx = activity.applicationContext
      thread(isDaemon = true, name = "ElvSafPlaylistRead") {
        try {
          val picked = readBoundedPlaylistDocument(appCtx, uri)
          promise.resolve(picked?.toBridgeMap())
        } catch (tooLarge: PlaylistTooLargeException) {
          promise.reject("E_PLAYLIST_TOO_LARGE", tooLarge.message ?: "Playlist file too large", tooLarge)
        } catch (err: Exception) {
          promise.reject("E_PLAYLIST_READ_FAILED", err.message ?: "Failed to read playlist file", err)
        }
      }
    }

    OnCreate {
      startStandbyMonitor()
      attachSafeAreaObserver()
      attachPipObserver()
    }

    OnActivityEntersForeground {
      startStandbyMonitor()
      attachSafeAreaObserver()
      attachPipObserver()
    }

    OnDestroy {
      val monitorToStop: StandbyMonitor?
      val insetsToDetach: (() -> Unit)?
      val pipToDetach: (() -> Unit)?
      val pickToCancel: Promise?
      synchronized(lifecycleLock) {
        monitorToStop = standbyMonitor
        standbyMonitor = null
        insetsToDetach = detachSafeAreaObserver
        detachSafeAreaObserver = null
        observedInsetsActivity = null
        pipToDetach = detachPipObserver
        detachPipObserver = null
        observedPipActivity = null
        pickToCancel = pendingPlaylistPick
        pendingPlaylistPick = null
      }
      pickToCancel?.resolve(null)
      monitorToStop?.stop()
      insetsToDetach?.invoke()
      pipToDetach?.invoke()
      orientationController.dispose()
      val alive = synchronized(engines) { engines.toList() }
      alive.forEach { it.dispose() }
    }

    Class("Engine", Media3Engine::class) {
      Constructor {
        val context = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()
        Media3Engine(context, appContext) { engines.remove(it) }.also { engines.add(it) }
      }

      Events("onEngineEvent", "onRemoteMediaAction")

      Function("load") { engine: Media3Engine, args: Map<String, Any?> ->
        val (attempt, request) = parseLoadArgs(args)
        engine.load(attempt, request)
      }

      Function("retry") { engine: Media3Engine, attempt: Int -> engine.retry(attempt) }

      Function("play") { engine: Media3Engine, attempt: Int -> engine.play(attempt) }

      Function("pause") { engine: Media3Engine, attempt: Int -> engine.pause(attempt) }

      Function("seek") { engine: Media3Engine, attempt: Int, positionMs: Double ->
        if (positionMs.isFinite()) engine.seek(attempt, positionMs.toLong())
      }

      Function("setScrubbing") { engine: Media3Engine, attempt: Int, scrubbing: Boolean ->
        engine.setScrubbing(attempt, scrubbing)
      }

      Function("setSpeed") { engine: Media3Engine, attempt: Int, rate: Double ->
        engine.setSpeed(attempt, rate)
      }

      Function("setPitchLock") { engine: Media3Engine, locked: Boolean ->
        engine.setPitchLock(locked)
      }

      Function("setMediaMetadata") { engine: Media3Engine, metadata: Map<String, Any?>? ->
        engine.setMediaMetadata(parseMediaMetadataArgs(metadata))
      }

      Function("setBackgroundAudioEnabled") { engine: Media3Engine, enabled: Boolean ->
        engine.setBackgroundAudioEnabled(enabled)
      }

      Function("setAudioBoostDb") { engine: Media3Engine, attempt: Int, db: Double ->
        if (db.isFinite()) engine.setAudioBoostDb(attempt, db)
      }

      Function("supportsHardwareHevc4k") { engine: Media3Engine ->
        engine.supportsHardwareHevc4k
      }

      Function("selectAudioTrack") { engine: Media3Engine, attempt: Int, id: String ->
        engine.selectAudioTrack(attempt, id)
      }

      Function("selectSubtitleTrack") { engine: Media3Engine, attempt: Int, id: String? ->
        engine.selectSubtitleTrack(attempt, id)
      }

      Function("stop") { engine: Media3Engine, attempt: Int -> engine.stop(attempt) }

      Function("recreate") { engine: Media3Engine, attempt: Int -> engine.recreate(attempt) }
    }

    View(Media3SurfaceView::class) {
      Prop("engine") { view: Media3SurfaceView, engine: Media3Engine? -> view.bind(engine) }

      Prop("resizeMode") { view: Media3SurfaceView, mode: String? -> view.setResizeMode(mode) }

      Prop("subtitleBottomInsetPx") { view: Media3SurfaceView, inset: Double? ->
        view.setSubtitleBottomInsetPx(inset)
      }

      Prop("subtitleFontFamily") { view: Media3SurfaceView, family: String? ->
        view.setSubtitleFontFamily(family)
      }

      Prop("surfaceRecreationToken") { view: Media3SurfaceView, token: Int? ->
        view.setSurfaceRecreationToken(token ?: 0)
      }

      Prop("useTextureView") { view: Media3SurfaceView, enabled: Boolean? ->
        view.setUseTextureView(enabled == true)
      }

      OnViewDestroys { view: Media3SurfaceView -> view.bind(null) }
    }
  }

  private fun startStandbyMonitor() {
    val context = appContext.reactContext?.applicationContext ?: return
    if (!isTvDevice(context)) return
    val monitor = synchronized(lifecycleLock) {
      if (standbyMonitor != null) return
      val weakModule = WeakReference(this)
      StandbyMonitor(context) { standby ->
        weakModule.get()?.runCatching {
          sendEvent("onStandbyChanged", mapOf("standby" to standby))
        }
      }.also { standbyMonitor = it }
    }
    monitor.start()
  }

  private fun attachSafeAreaObserver() {
    val activity = appContext.currentActivity ?: return
    if (isTvDevice(activity)) return
    val previous: (() -> Unit)?
    val weakModule = WeakReference(this)
    synchronized(lifecycleLock) {
      if (observedInsetsActivity?.get() === activity && detachSafeAreaObserver != null) return
      previous = detachSafeAreaObserver
      observedInsetsActivity = WeakReference(activity)
      detachSafeAreaObserver = observeSafeAreaInsets(activity) { insets ->
        weakModule.get()?.runCatching {
          sendEvent("onSafeAreaInsetsChanged", insets)
        }
      }
    }
    previous?.invoke()
  }

  private fun attachPipObserver() {
    val activity = appContext.currentActivity ?: return
    if (isTvDevice(activity)) return
    val previous: (() -> Unit)?
    val weakModule = WeakReference(this)
    synchronized(lifecycleLock) {
      if (observedPipActivity?.get() === activity && detachPipObserver != null) return
      previous = detachPipObserver
      observedPipActivity = WeakReference(activity)
      detachPipObserver = observePictureInPictureMode(activity) { inPip ->
        weakModule.get()?.runCatching {
          sendEvent("onPictureInPictureChanged", mapOf("inPip" to inPip))
        }
      }
    }
    previous?.invoke()
  }

  private fun clearPendingPickIfSame(target: Promise): Promise? =
    synchronized(lifecycleLock) {
      if (pendingPlaylistPick === target) {
        pendingPlaylistPick = null
        target
      } else {
        null
      }
    }
}

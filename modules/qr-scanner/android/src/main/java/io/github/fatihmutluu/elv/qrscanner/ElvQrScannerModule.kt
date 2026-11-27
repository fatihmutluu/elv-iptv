package io.github.fatihmutluu.elv.qrscanner

import android.app.Activity
import android.app.UiModeManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal const val REQUEST_CODE_QR_SCAN = 0x4551

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

internal fun isQrScannerHardwareAvailable(context: Context): Boolean {
  if (isTvDevice(context)) return false
  return runCatching {
    context.packageManager?.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY) == true
  }.getOrDefault(false)
}

/**
 * Expo native module presenting an in-app CameraX + ZXing QR code scanner on handheld Android
 * phone/tablet devices without any GMS, Firebase, or MLKit dependencies (`#510`).
 */
class ElvQrScannerModule : Module() {
  private val lock = Any()
  private var pendingScanPromise: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("ElvQrScanner")

    Function("isAvailable") {
      val context = appContext.currentActivity ?: appContext.reactContext ?: return@Function false
      isQrScannerHardwareAvailable(context)
    }

    AsyncFunction("scan") { promise: Promise ->
      val activity = appContext.currentActivity
      if (activity == null || !isQrScannerHardwareAvailable(activity)) {
        promise.resolve(null)
        return@AsyncFunction
      }
      synchronized(lock) {
        if (pendingScanPromise != null) {
          promise.resolve(null)
          return@AsyncFunction
        }
        pendingScanPromise = promise
      }
      try {
        val intent = Intent(activity, QrScannerActivity::class.java)
        activity.startActivityForResult(intent, REQUEST_CODE_QR_SCAN)
      } catch (_: ActivityNotFoundException) {
        clearPendingPromiseIfSame(promise)?.resolve(null)
      } catch (_: SecurityException) {
        clearPendingPromiseIfSame(promise)?.resolve(null)
      }
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_CODE_QR_SCAN) return@OnActivityResult
      val promise = synchronized(lock) {
        val current = pendingScanPromise
        pendingScanPromise = null
        current
      } ?: return@OnActivityResult

      val qrText = if (payload.resultCode == Activity.RESULT_OK) {
        payload.data
          ?.getStringExtra(QrScannerActivity.EXTRA_QR_TEXT)
          ?.trim()
          ?.takeIf { it.isNotEmpty() }
      } else {
        null
      }
      promise.resolve(qrText)
    }

    OnDestroy {
      val promiseToCancel = synchronized(lock) {
        val current = pendingScanPromise
        pendingScanPromise = null
        current
      }
      promiseToCancel?.resolve(null)
    }
  }

  private fun clearPendingPromiseIfSame(target: Promise): Promise? =
    synchronized(lock) {
      if (pendingScanPromise === target) {
        pendingScanPromise = null
        target
      } else {
        null
      }
    }
}

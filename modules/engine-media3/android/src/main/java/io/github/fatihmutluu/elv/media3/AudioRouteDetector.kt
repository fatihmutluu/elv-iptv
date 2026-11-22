package io.github.fatihmutluu.elv.media3

import android.annotation.SuppressLint
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import androidx.annotation.RequiresApi

/**
 * Builds Android [AudioAttributes] matching ELV media playback (`USAGE_MEDIA` + `CONTENT_TYPE_MOVIE`)
 * for API 33+ audio route queries (#187).
 */
internal fun androidMediaAudioAttributes(): AudioAttributes =
  AudioAttributes.Builder()
    .setUsage(AudioAttributes.USAGE_MEDIA)
    .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
    .build()

/**
 * Returns true strictly for Bluetooth audio output sink types (`A2DP`, `SCO`, `BLE_HEADSET`,
 * `BLE_SPEAKER`, `BLE_BROADCAST`). Built-in speakers, HDMI, USB audio, wired outputs, and generic
 * or HID devices return false (#187).
 */
internal fun isBluetoothAudioDeviceType(type: Int): Boolean =
  when (type) {
    AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
    AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
    AudioDeviceInfo.TYPE_BLE_HEADSET,
    AudioDeviceInfo.TYPE_BLE_SPEAKER,
    AudioDeviceInfo.TYPE_BLE_BROADCAST -> true
    else -> false
  }

/** Returns true when any reported audio output device type is a Bluetooth audio sink (#187). */
internal fun hasBluetoothAudioRoute(outputDeviceTypes: Collection<Int>): Boolean =
  outputDeviceTypes.any(::isBluetoothAudioDeviceType)

@RequiresApi(Build.VERSION_CODES.TIRAMISU)
private fun queryMediaRouteDeviceTypesApi33(
  audioManager: AudioManager,
  attributes: AudioAttributes,
): List<Int> =
  audioManager.getAudioDevicesForAttributes(attributes).map { it.type }

private fun queryLegacyOutputDeviceTypes(audioManager: AudioManager): List<Int> =
  audioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).map { it.type }

/**
 * Pure seam selecting API 33+ attribute-scoped media routing (`getAudioDevicesForAttributes`) vs
 * API 28–32 output enumeration (`getDevices(GET_DEVICES_OUTPUTS)`), failing closed to `false` on
 * any platform error (#187).
 */
internal fun isBluetoothAudioRouteActive(
  sdkInt: Int,
  queryForAttributes: (AudioAttributes) -> Collection<Int>,
  queryLegacyOutputs: () -> Collection<Int>,
): Boolean =
  runCatching {
    val deviceTypes = if (sdkInt >= Build.VERSION_CODES.TIRAMISU) {
      queryForAttributes(androidMediaAudioAttributes())
    } else {
      queryLegacyOutputs()
    }
    hasBluetoothAudioRoute(deviceTypes)
  }.getOrDefault(false)

/**
 * Detects whether media playback is currently routed to a Bluetooth audio output sink (#187).
 *
 * - On Android 13+ (API 33+, `TIRAMISU`): queries `AudioManager.getAudioDevicesForAttributes` with
 *   `USAGE_MEDIA` + `CONTENT_TYPE_MOVIE` so paired Bluetooth HID remotes are never returned or
 *   misclassified as Bluetooth audio outputs.
 * - On API 28–32: falls back to `AudioManager.getDevices(AudioManager.GET_DEVICES_OUTPUTS)` and
 *   filters strictly through [isBluetoothAudioDeviceType].
 */
@SuppressLint("NewApi")
internal fun isBluetoothAudioRouteActive(
  context: Context,
  sdkInt: Int = Build.VERSION.SDK_INT,
): Boolean =
  runCatching {
    val audioManager = context.getSystemService(AudioManager::class.java) ?: return false
    isBluetoothAudioRouteActive(
      sdkInt = sdkInt,
      queryForAttributes = { attrs -> queryMediaRouteDeviceTypesApi33(audioManager, attrs) },
      queryLegacyOutputs = { queryLegacyOutputDeviceTypes(audioManager) },
    )
  }.getOrDefault(false)

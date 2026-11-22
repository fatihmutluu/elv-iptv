package io.github.fatihmutluu.elv.media3

import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.os.Build
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class AudioRouteDetectorTest {
  @Test
  fun `isBluetoothAudioDeviceType matches only Bluetooth audio sink types (#187)`() {
    val bluetoothAudioTypes = listOf(
      AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
      AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
      AudioDeviceInfo.TYPE_BLE_HEADSET,
      AudioDeviceInfo.TYPE_BLE_SPEAKER,
      AudioDeviceInfo.TYPE_BLE_BROADCAST,
    )
    for (type in bluetoothAudioTypes) {
      assertTrue("Expected BT audio type $type to match", isBluetoothAudioDeviceType(type))
    }

    val nonBluetoothTypes = listOf(
      AudioDeviceInfo.TYPE_UNKNOWN,
      AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
      AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
      AudioDeviceInfo.TYPE_HDMI,
      AudioDeviceInfo.TYPE_USB_DEVICE,
      AudioDeviceInfo.TYPE_USB_ACCESSORY,
      AudioDeviceInfo.TYPE_USB_HEADSET,
      999,
    )
    for (type in nonBluetoothTypes) {
      assertFalse("Expected non-BT type $type to be rejected", isBluetoothAudioDeviceType(type))
    }
  }

  @Test
  fun `hasBluetoothAudioRoute returns true only when at least one BT audio sink is present (#187)`() {
    assertFalse(hasBluetoothAudioRoute(emptyList()))
    assertFalse(
      hasBluetoothAudioRoute(
        listOf(
          AudioDeviceInfo.TYPE_HDMI,
          AudioDeviceInfo.TYPE_BUILTIN_SPEAKER,
          AudioDeviceInfo.TYPE_USB_DEVICE,
        ),
      ),
    )
    assertTrue(
      hasBluetoothAudioRoute(
        listOf(AudioDeviceInfo.TYPE_HDMI, AudioDeviceInfo.TYPE_BLUETOOTH_A2DP),
      ),
    )
    assertTrue(hasBluetoothAudioRoute(listOf(AudioDeviceInfo.TYPE_BLE_HEADSET)))
    assertTrue(hasBluetoothAudioRoute(listOf(AudioDeviceInfo.TYPE_BLE_SPEAKER)))
    assertTrue(hasBluetoothAudioRoute(listOf(AudioDeviceInfo.TYPE_BLE_BROADCAST)))
  }

  @Test
  fun `API 33+ queries getAudioDevicesForAttributes with USAGE_MEDIA and CONTENT_TYPE_MOVIE instead of legacy outputs (#187)`() {
    var observedAttributes: AudioAttributes? = null
    var legacyCalled = false

    val active = isBluetoothAudioRouteActive(
      sdkInt = Build.VERSION_CODES.TIRAMISU,
      queryForAttributes = { attrs ->
        observedAttributes = attrs
        listOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)
      },
      queryLegacyOutputs = {
        legacyCalled = true
        emptyList()
      },
    )

    assertTrue(active)
    assertFalse("API 33+ must not fall back to legacy GET_DEVICES_OUTPUTS", legacyCalled)
    assertNotNull(observedAttributes)
    assertEquals(AudioAttributes.USAGE_MEDIA, observedAttributes!!.usage)
    assertEquals(AudioAttributes.CONTENT_TYPE_MOVIE, observedAttributes!!.contentType)

    // When active media route is HDMI (even if a BT HID remote is paired), API 33+ returns false.
    val hdmiOnly = isBluetoothAudioRouteActive(
      sdkInt = Build.VERSION_CODES.TIRAMISU,
      queryForAttributes = { listOf(AudioDeviceInfo.TYPE_HDMI) },
      queryLegacyOutputs = {
        legacyCalled = true
        listOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)
      },
    )
    assertFalse(hdmiOnly)
    assertFalse(legacyCalled)
  }

  @Test
  fun `API 31 falls back to legacy output device enumeration and never invokes API 33 attributes query (#187)`() {
    var attributesCalled = false
    var legacyCalls = 0

    val active = isBluetoothAudioRouteActive(
      sdkInt = Build.VERSION_CODES.S,
      queryForAttributes = {
        attributesCalled = true
        emptyList()
      },
      queryLegacyOutputs = {
        legacyCalls += 1
        listOf(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
      },
    )

    assertTrue(active)
    assertFalse("API < 33 must not call getAudioDevicesForAttributes", attributesCalled)
    assertEquals(1, legacyCalls)

    val speakerOnly = isBluetoothAudioRouteActive(
      sdkInt = Build.VERSION_CODES.S,
      queryForAttributes = {
        attributesCalled = true
        listOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP)
      },
      queryLegacyOutputs = {
        legacyCalls += 1
        listOf(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER, AudioDeviceInfo.TYPE_USB_DEVICE)
      },
    )

    assertFalse(speakerOnly)
    assertFalse(attributesCalled)
    assertEquals(2, legacyCalls)
  }

  @Test
  fun `context entry point fails closed safely on runtime exceptions and returns false with no BT outputs (#187)`() {
    val failing = isBluetoothAudioRouteActive(
      sdkInt = Build.VERSION_CODES.TIRAMISU,
      queryForAttributes = { throw SecurityException("audio routing query denied") },
      queryLegacyOutputs = { listOf(AudioDeviceInfo.TYPE_BLUETOOTH_A2DP) },
    )
    assertFalse(failing)

    val app = RuntimeEnvironment.getApplication()
    assertFalse(isBluetoothAudioRouteActive(app, sdkInt = Build.VERSION_CODES.S))
  }
}

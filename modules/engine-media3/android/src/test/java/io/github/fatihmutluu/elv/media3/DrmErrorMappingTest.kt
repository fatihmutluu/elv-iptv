package io.github.fatihmutluu.elv.media3

import android.net.Uri
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class DrmErrorMappingTest {
  @Test
  fun `mapError classifies DRM 6000-6999 codes as terminal drm even when license HTTP failed with 401, 403, or 500 (#272)`() {
    val drmCodes = listOf(
      PlaybackException.ERROR_CODE_DRM_UNSPECIFIED,
      PlaybackException.ERROR_CODE_DRM_PROVISIONING_FAILED,
      PlaybackException.ERROR_CODE_DRM_LICENSE_ACQUISITION_FAILED,
      PlaybackException.ERROR_CODE_DRM_LICENSE_EXPIRED,
    )
    for (drmCode in drmCodes) {
      assertEquals("code=$drmCode status=401", "drm", mapError(401, "text/plain", drmCode))
      assertEquals("code=$drmCode status=403", "drm", mapError(403, "text/html", drmCode))
      assertEquals("code=$drmCode status=458", "drm", mapError(458, null, drmCode))
      assertEquals("code=$drmCode status=500", "drm", mapError(500, "application/json", drmCode))
      assertEquals("code=$drmCode notice=true", "drm", mapError(200, "text/html", drmCode, notice = true))
    }
  }

  @Test
  fun `EventReporter emits terminal drm with errorCodeName only and zero license URL or httpStatus leakage (#272)`() {
    val events = mutableListOf<Map<String, Any?>>()
    val real = ExoPlayer.Builder(RuntimeEnvironment.getApplication()).setLooper(Looper.getMainLooper()).build()
    try {
      val reporter = EventReporter(
        handler = Handler(Looper.getMainLooper()),
        fence = PrepareFence(),
        hasInvalidAttachedSurface = { false },
        send = { events += it },
        onHlsDetected = {},
        onBehindLiveWindow = {},
        onAudioFocusDenied = { false },
        onVideoCodecFailed = {},
        onFirstFrame = {},
        onCue = { _, _ -> },
      )
      reporter.begin(real, live = true, prepareSerial = 1L, reused = false)
      events.clear()

      for (statusCode in listOf(401, 403, 500)) {
        events.clear()
        val licenseCause = HttpDataSource.InvalidResponseCodeException(
          statusCode,
          "HTTP $statusCode",
          null,
          emptyMap(),
          DataSpec(Uri.parse("https://secret-license.drm-provider.test:8443/wv/acquire?token=topsecret")),
          ByteArray(0),
        )
        val drmException = PlaybackException(
          "License acquisition failed",
          licenseCause,
          PlaybackException.ERROR_CODE_DRM_LICENSE_ACQUISITION_FAILED,
        )
        reporter.onPlayerError(drmException)

        val errEvent = events.lastOrNull { it["type"] == "error" }
        val errMap = errEvent?.get("error") as? Map<*, *>
        assertEquals("status=$statusCode", "drm", errMap?.get("code"))
        assertEquals(
          "status=$statusCode",
          "ERROR_CODE_DRM_LICENSE_ACQUISITION_FAILED",
          errMap?.get("detail"),
        )
        assertFalse(
          "status=$statusCode must omit httpStatus on DRM errors",
          errMap?.containsKey("httpStatus") == true,
        )
        val detail = errMap?.get("detail") as? String ?: ""
        assertFalse("detail must never leak license host", detail.contains("drm-provider.test"))
        assertFalse("detail must never leak license scheme", detail.contains("https://"))
      }
    } finally {
      real.release()
    }
  }
}

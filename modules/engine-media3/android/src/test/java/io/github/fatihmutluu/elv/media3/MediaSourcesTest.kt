package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.extractor.ts.TsExtractor
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class MediaSourcesTest {
  private fun errorInfo(error: IOException, errorCount: Int = 1): LoadErrorHandlingPolicy.LoadErrorInfo {
    val spec = DataSpec(Uri.parse("http://127.0.0.1:7878/live/demo/demo/1.m3u8"))
    val loadEvent = LoadEventInfo(1L, spec, 0L)
    val mediaData = MediaLoadData(C.DATA_TYPE_MANIFEST)
    return LoadErrorHandlingPolicy.LoadErrorInfo(loadEvent, mediaData, error, errorCount)
  }

  private fun invalidStatus(code: Int): HttpDataSource.InvalidResponseCodeException =
    HttpDataSource.InvalidResponseCodeException(
      code,
      "HTTP $code",
      null,
      emptyMap(),
      DataSpec(Uri.parse("http://127.0.0.1:7878/live/demo/demo/1.m3u8")),
      ByteArray(0),
    )

  @Test
  fun `ServiceOwnedRetryPolicy blocks variant fallback on 403, limit codes and pre-manifest errors (#84)`() {
    val manifestLoaded = AtomicBoolean(false)
    val policy = ServiceOwnedRetryPolicy(hls = true, manifestLoaded = manifestLoaded)
    val fallbackOptions = LoadErrorHandlingPolicy.FallbackOptions(1, 0, 3, 0)

    // Pre-manifest 404 or 503 fails at once without walking variants
    assertNull(policy.getFallbackSelectionFor(fallbackOptions, errorInfo(invalidStatus(404))))
    assertEquals(C.TIME_UNSET, policy.getRetryDelayMsFor(errorInfo(invalidStatus(404))))

    // Post-manifest: 403 and panel limit 458 still block variant fallback, even when wrapped in outer IOException
    manifestLoaded.set(true)
    val wrapped403 = IOException("hls load error", invalidStatus(403))
    assertNull(policy.getFallbackSelectionFor(fallbackOptions, errorInfo(wrapped403)))
    assertEquals(C.TIME_UNSET, policy.getRetryDelayMsFor(errorInfo(wrapped403)))

    val limit458 = invalidStatus(458)
    assertNull(policy.getFallbackSelectionFor(fallbackOptions, errorInfo(limit458)))
    assertEquals(C.TIME_UNSET, policy.getRetryDelayMsFor(errorInfo(limit458)))

    // Post-manifest 404 or 503 on one variant IS allowed to fall back to another rendition and retry
    assertNotNull(policy.getFallbackSelectionFor(fallbackOptions, errorInfo(invalidStatus(404))))
    assertTrue(policy.getRetryDelayMsFor(errorInfo(invalidStatus(503))) >= 0L)
  }

  @Test
  fun `tsSearchBytesFor scales timestamp search bytes by device RAM and createMediaSource tags mediaId (#111)`() {
    assertEquals(TsExtractor.DEFAULT_TIMESTAMP_SEARCH_BYTES, tsSearchBytesFor(lowRam = true))
    assertTrue(tsSearchBytesFor(lowRam = false) > TsExtractor.DEFAULT_TIMESTAMP_SEARCH_BYTES)

    val source = createMediaSource(
      request = LoadRequest(
        url = "http://127.0.0.1:7878/live/demo/demo/1001.m3u8",
        headers = emptyMap(),
        live = true,
        startMs = null,
        softwareAudio = false,
      ),
      gate = ConnectionGate { it.run() },
      generation = 1L,
      prepareSerial = 42L,
      lowRam = false,
      client = engineHttpClient(),
    )
    assertEquals("42", source.mediaItem.mediaId)
  }
}

package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.source.LoadEventInfo
import androidx.media3.exoplayer.source.MediaLoadData
import androidx.media3.exoplayer.upstream.LoadErrorHandlingPolicy
import androidx.media3.extractor.ts.TsExtractor
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.Assert.assertArrayEquals
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
  fun `SchemeRoutingDataSource serves data URIs via DataSchemeDataSource without touching OkHttp or ConnectionGate (#183)`() {
    var defaultFactoryCalls = 0
    val httpPayload = byteArrayOf(1, 2, 3, 4)
    val routing = SchemeRoutingDataSource(
      defaultDataSourceFactory = {
        defaultFactoryCalls += 1
        ByteArrayDataSource(httpPayload)
      },
    )

    // 1. data:video/mp2t;base64,... opens and reads cleanly without invoking defaultDataSourceFactory
    val tsPayload = ByteArray(188) { idx -> if (idx == 0) 0x47 else (idx and 0xFF).toByte() }
    val dataUri = encodeTsInitDataUri(tsPayload)
    val dataLen = routing.open(DataSpec(Uri.parse(dataUri)))
    assertEquals(tsPayload.size.toLong(), dataLen)
    val decoded = ByteArray(tsPayload.size)
    assertEquals(tsPayload.size, routing.read(decoded, 0, decoded.size))
    routing.close()
    assertArrayEquals(tsPayload, decoded)
    assertEquals("data: URI must never touch OkHttp/ConnectionGate factory", 0, defaultFactoryCalls)

    // 2. Non-data HTTP URI delegates to defaultDataSourceFactory
    val httpLen = routing.open(DataSpec(Uri.parse("http://127.0.0.1:7878/vod/seg0.ts")))
    assertEquals(httpPayload.size.toLong(), httpLen)
    val readHttp = ByteArray(httpPayload.size)
    assertEquals(httpPayload.size, routing.read(readHttp, 0, readHttp.size))
    routing.close()
    assertArrayEquals(httpPayload, readHttp)
    assertEquals(1, defaultFactoryCalls)
  }

  @Test
  fun `tsSearchBytesFor scales timestamp search bytes by device RAM and createMediaSource tags mediaId (#111, #183, #438)`() {
    assertEquals(1_800 * TsExtractor.TS_PACKET_SIZE, tsSearchBytesFor(lowRam = true))
    assertEquals(2_400 * TsExtractor.TS_PACKET_SIZE, tsSearchBytesFor(lowRam = false))
    assertTrue(tsSearchBytesFor(lowRam = true) > TsExtractor.DEFAULT_TIMESTAMP_SEARCH_BYTES)
    assertTrue(tsSearchBytesFor(lowRam = false) > tsSearchBytesFor(lowRam = true))

    val vodFactory = tsCapableFactory(lowRam = false, live = false)
    val liveFactory = tsCapableFactory(lowRam = false, live = true)
    val alwaysEnabledField = vodFactory.javaClass.getDeclaredField("constantBitrateSeekingAlwaysEnabled").apply {
      isAccessible = true
    }
    assertTrue("VOD must enable constantBitrateSeekingAlwaysEnabled", alwaysEnabledField.getBoolean(vodFactory))
    assertTrue("Live must leave constantBitrateSeekingAlwaysEnabled disabled", !alwaysEnabledField.getBoolean(liveFactory))

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

    val vodHlsSource = createMediaSource(
      request = LoadRequest(
        url = "http://127.0.0.1:7878/movie/demo/demo/1001.m3u8",
        headers = emptyMap(),
        live = false,
        startMs = null,
        softwareAudio = false,
      ),
      gate = ConnectionGate { it.run() },
      generation = 2L,
      prepareSerial = 44L,
      lowRam = false,
      client = engineHttpClient(),
    )
    assertEquals("44", vodHlsSource.mediaItem.mediaId)

    val vodTsSource = createMediaSource(
      request = LoadRequest(
        url = "http://127.0.0.1:7878/movie/demo/demo/1001.ts",
        headers = emptyMap(),
        live = false,
        startMs = null,
        softwareAudio = false,
      ),
      gate = ConnectionGate { it.run() },
      generation = 3L,
      prepareSerial = 43L,
      lowRam = true,
      client = engineHttpClient(),
    )
    assertEquals("43", vodTsSource.mediaItem.mediaId)
  }

  @Test
  fun `ProgressTransferListener throttles network byte progress to 500 ms and respects shouldReport (#314)`() {
    var nowMs = 1_000L
    var allow = true
    val reported = mutableListOf<Pair<Long, Long>>()
    val listener = ProgressTransferListener(
      minIntervalMs = PROGRESS_MIN_INTERVAL_MS,
      clockMs = { nowMs },
      shouldReport = { allow },
      onProgress = { bytes, at -> reported += bytes to at },
    )
    val dummySource = ByteArrayDataSource(ByteArray(16))
    val spec = DataSpec(Uri.parse("http://127.0.0.1:7878/movie/demo/demo/1.mp4"))

    // Non-network or zero-byte reads are ignored
    listener.onBytesTransferred(dummySource, spec, isNetwork = false, bytesTransferred = 4096)
    listener.onBytesTransferred(dummySource, spec, isNetwork = true, bytesTransferred = 0)
    assertTrue(reported.isEmpty())

    // First network chunk emits immediately
    listener.onBytesTransferred(dummySource, spec, isNetwork = true, bytesTransferred = 8192)
    assertEquals(listOf(8192L to 1_000L), reported)

    // Within 500 ms is throttled while still accumulating bytes
    nowMs = 1_499L
    listener.onBytesTransferred(dummySource, spec, isNetwork = true, bytesTransferred = 4096)
    assertEquals(1, reported.size)

    // At >= 500 ms emits cumulative total
    nowMs = 1_500L
    listener.onBytesTransferred(dummySource, spec, isNetwork = true, bytesTransferred = 4096)
    assertEquals(listOf(8192L to 1_000L, 16_384L to 1_500L), reported)

    // Suppressed when shouldReport() is false (steady playing)
    allow = false
    nowMs = 2_500L
    listener.onBytesTransferred(dummySource, spec, isNetwork = true, bytesTransferred = 8192)
    assertEquals(2, reported.size)
  }

  @Test
  fun `createMediaSource wires DRM session manager provider onto DASH, HLS, SmoothStreaming, and Progressive sources (#272)`() {
    val clearKeyDrm = ParsedDrmConfig(
      scheme = DrmSchemeKind.CLEARKEY,
      clearKeys = listOf(DrmClearKeyPair("00112233445566778899aabbccddeeff", "ffeeddccbbaa99887766554433221100")),
    )
    val widevineDrm = ParsedDrmConfig(
      scheme = DrmSchemeKind.WIDEVINE,
      licenseUrl = "https://drm.example.test/wv",
      licenseHeaders = mapOf("Authorization" to "Bearer tok"),
      multiSession = true,
    )
    val cases = listOf(
      "https://cdn.example.test/live/ch1.mpd" to clearKeyDrm,
      "https://cdn.example.test/live/ch1.m3u8" to widevineDrm,
      "https://cdn.example.test/live/ch1.ism/Manifest" to widevineDrm,
      "https://cdn.example.test/vod/movie.mp4" to clearKeyDrm,
    )
    val client = engineHttpClient()
    for ((idx, pair) in cases.withIndex()) {
      val (url, drm) = pair
      val source = createMediaSource(
        request = LoadRequest(
          url = url,
          headers = emptyMap(),
          live = idx < 3,
          startMs = null,
          softwareAudio = false,
          drm = drm,
        ),
        gate = ConnectionGate { it.run() },
        generation = idx.toLong() + 1L,
        prepareSerial = 100L + idx,
        lowRam = false,
        client = client,
      )
      assertEquals((100L + idx).toString(), source.mediaItem.mediaId)
    }
  }

  @Test
  fun `createMediaSource forwards DRM licenseHeaders including custom User-Agent to StreamHttp factory (#272)`() {
    val previousAgent = System.getProperty("http.agent")
    System.setProperty("http.agent", "Dalvik/2.1.0 (Linux; U; Android 14)")
    try {
      val capturedRequests = mutableListOf<okhttp3.Request>()
      val capturingClient = okhttp3.Call.Factory { request ->
        capturedRequests += request
        object : okhttp3.Call {
          override fun request(): okhttp3.Request = request
          override fun execute(): okhttp3.Response =
            okhttp3.Response.Builder()
              .request(request)
              .protocol(okhttp3.Protocol.HTTP_1_1)
              .code(200)
              .message("OK")
              .body(okhttp3.ResponseBody.create(null, byteArrayOf(1, 2, 3)))
              .build()
          override fun enqueue(responseCallback: okhttp3.Callback) {
            responseCallback.onResponse(this, execute())
          }
          override fun cancel() = Unit
          override fun isExecuted(): Boolean = false
          override fun isCanceled(): Boolean = false
          override fun timeout(): okio.Timeout = okio.Timeout.NONE
          override fun clone(): okhttp3.Call = this
        }
      }
      val customAgent = "ElvCustomDrmAgent/2.1"
      val widevineDrm = ParsedDrmConfig(
        scheme = DrmSchemeKind.WIDEVINE,
        licenseUrl = "https://drm.example.test/wv",
        licenseHeaders = mapOf(
          "User-Agent" to customAgent,
          "X-Drm-Tenant" to "tenant-42",
        ),
      )
      val source = createMediaSource(
        request = LoadRequest(
          url = "https://cdn.example.test/live/ch1.mpd",
          headers = mapOf("User-Agent" to "StreamAgent/1.0"),
          live = true,
          startMs = null,
          softwareAudio = false,
          drm = widevineDrm,
        ),
        gate = ConnectionGate { it.run() },
        generation = 1L,
        prepareSerial = 200L,
        lowRam = false,
        client = capturingClient,
      )

      // Extract the DRM callback wired onto the DashMediaSource and execute a synthetic license request
      val drmManagerField = source.javaClass.getDeclaredField("drmSessionManager").apply {
        isAccessible = true
      }
      val drmManager = drmManagerField.get(source)!!
      val callbackField = drmManager.javaClass.getDeclaredField("callback").apply {
        isAccessible = true
      }
      val callback = callbackField.get(drmManager) as androidx.media3.exoplayer.drm.HttpMediaDrmCallback
      val keyReq = androidx.media3.exoplayer.drm.ExoMediaDrm.KeyRequest(
        byteArrayOf(0x01, 0x02),
        "https://drm.example.test/wv",
      )
      callback.executeKeyRequest(C.WIDEVINE_UUID, keyReq)

      assertEquals(1, capturedRequests.size)
      val req = capturedRequests.single()
      assertEquals(listOf(customAgent), req.headers("User-Agent"))
      assertEquals("tenant-42", req.header("X-Drm-Tenant"))
    } finally {
      if (previousAgent == null) {
        System.clearProperty("http.agent")
      } else {
        System.setProperty("http.agent", previousAgent)
      }
    }
  }
}

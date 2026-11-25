package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ByteArrayDataSource
import androidx.media3.datasource.DataSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class DrmConfigBuilderTest {
  private val sampleKidHex = "00112233445566778899aabbccddeeff"
  private val sampleKeyHex = "ffeeddccbbaa99887766554433221100"
  private val sampleKidB64Url = "ABEiM0RVZne" + "Imaq7zN3u_w"
  private val sampleKeyB64Url = "_-7dzLuqmYh" + "3ZlVEMyIRAA"

  @Test
  fun `buildClearKeyJwkJson converts 32-char hex and base64url pairs to unpadded EME JWK JSON (#272)`() {
    val fromHex = buildClearKeyJwkJson(listOf(DrmClearKeyPair(sampleKidHex, sampleKeyHex)))
    assertEquals(
      """{"keys":[{"kty":"oct","k":"$sampleKeyB64Url","kid":"$sampleKidB64Url"}],"type":"temporary"}""",
      fromHex,
    )
    assertFalse("JWK must never contain base64 padding", fromHex!!.contains("="))

    val fromB64 = buildClearKeyJwkJson(
      listOf(DrmClearKeyPair("$sampleKidB64Url==", sampleKeyB64Url)),
    )
    assertEquals(fromHex, fromB64)

    // Invalid lengths, non-hex/non-base64url, and injection attempts return null
    assertNull(buildClearKeyJwkJson(emptyList()))
    assertNull(buildClearKeyJwkJson(listOf(DrmClearKeyPair("short", sampleKeyHex))))
    assertNull(buildClearKeyJwkJson(listOf(DrmClearKeyPair(sampleKidHex, "not-valid-key!\"}"))))
  }

  @Test
  fun `parseDrmConfig validates schemes, http(s)-only licenseUrl, clearKeys, headers, and never leaks secrets in toString (#272)`() {
    val clearKeyInline = parseDrmConfig(
      mapOf(
        "scheme" to "org.w3.clearkey",
        "clearKeys" to listOf(mapOf("kid" to sampleKidHex, "key" to sampleKeyHex)),
        "multiSession" to true,
      ),
    )
    assertNotNull(clearKeyInline)
    assertEquals(DrmSchemeKind.CLEARKEY, clearKeyInline!!.scheme)
    assertEquals(1, clearKeyInline.clearKeys.size)
    assertTrue(clearKeyInline.multiSession)
    val clearKeyText = clearKeyInline.toString()
    assertFalse(clearKeyText.contains(sampleKidHex))
    assertFalse(clearKeyText.contains(sampleKeyHex))
    assertFalse(clearKeyInline.clearKeys[0].toString().contains(sampleKeyHex))

    val widevine = parseDrmConfig(
      mapOf(
        "scheme" to "com.widevine.alpha",
        "licenseUrl" to "https://drm.example.test/wv?token=secret99",
        "licenseHeaders" to mapOf("Authorization" to "Bearer topsecret", "Bad Header" to "ignored"),
        "multiSession" to false,
      ),
    )
    assertNotNull(widevine)
    assertEquals(DrmSchemeKind.WIDEVINE, widevine!!.scheme)
    assertEquals("https://drm.example.test/wv?token=secret99", widevine.licenseUrl)
    assertEquals(mapOf("Authorization" to "Bearer topsecret"), widevine.licenseHeaders)
    val wvText = widevine.toString()
    for (secret in listOf("drm.example.test", "secret99", "topsecret", "Bearer")) {
      assertFalse("toString must never leak $secret: $wvText", wvText.contains(secret))
    }

    val playReady = parseDrmConfig(
      mapOf(
        "scheme" to "playready",
        "licenseUrl" to "http://drm.example.test/pr",
      ),
    )
    assertNotNull(playReady)
    assertEquals(DrmSchemeKind.PLAYREADY, playReady!!.scheme)

    // Reject disallowed license URL schemes (file://, content://, javascript:, data:)
    for (badUrl in listOf(
      "file:///etc/passwd",
      "content://provider/license",
      "javascript:alert(1)",
      "data:application/json,{}",
      "ftp://drm.example.test/wv",
    )) {
      assertNull(
        "must reject licenseUrl=$badUrl",
        parseDrmConfig(mapOf("scheme" to "widevine", "licenseUrl" to badUrl)),
      )
    }

    // Reject unknown schemes or empty configs
    assertNull(parseDrmConfig(mapOf("scheme" to "fairplay", "licenseUrl" to "https://drm.example.test/fp")))
    assertNull(parseDrmConfig(mapOf("scheme" to "widevine")))
    assertNull(parseDrmConfig(mapOf("scheme" to "clearkey")))
    assertNull(parseDrmConfig(null))
  }

  @Test
  fun `buildDrmSessionManagerProvider creates LocalMediaDrmCallback for inline ClearKey and HttpMediaDrmCallback for remote DRM (#272)`() {
    val dummyFactory = DataSource.Factory { ByteArrayDataSource(ByteArray(0)) }
    val item = MediaItem.Builder().setUri("https://cdn.example.test/live.mpd").build()

    val inlineClearKey = parseDrmConfig(
      mapOf(
        "scheme" to "clearkey",
        "clearKeys" to listOf(mapOf("kid" to sampleKidHex, "key" to sampleKeyHex)),
      ),
    )!!
    val clearKeyProvider = buildDrmSessionManagerProvider(inlineClearKey, dummyFactory)
    assertNotNull(clearKeyProvider)
    assertNotNull(clearKeyProvider!!.get(item))

    val remoteWidevine = parseDrmConfig(
      mapOf(
        "scheme" to "widevine",
        "licenseUrl" to "https://drm.example.test/widevine",
        "licenseHeaders" to mapOf("X-Custom" to "val"),
        "multiSession" to true,
      ),
    )!!
    val wvProvider = buildDrmSessionManagerProvider(remoteWidevine, dummyFactory)
    assertNotNull(wvProvider)
    assertNotNull(wvProvider!!.get(item))

    val remotePlayReady = parseDrmConfig(
      mapOf(
        "scheme" to "playready",
        "licenseUrl" to "https://drm.example.test/playready",
      ),
    )!!
    val prProvider = buildDrmSessionManagerProvider(remotePlayReady, dummyFactory)
    assertNotNull(prProvider)
    assertNotNull(prProvider!!.get(item))
  }

  @Test
  fun `probeWidevineSecurityLevel returns L1, L3, or unavailable safely without throwing (#272)`() {
    assertEquals(
      "L1",
      probeWidevineSecurityLevel(isSupported = { it == C.WIDEVINE_UUID }, readSecurityLevel = { "L1" }),
    )
    assertEquals(
      "L3",
      probeWidevineSecurityLevel(isSupported = { it == C.WIDEVINE_UUID }, readSecurityLevel = { "l3" }),
    )
    assertEquals(
      "unavailable",
      probeWidevineSecurityLevel(isSupported = { false }, readSecurityLevel = { "L1" }),
    )
    assertEquals(
      "unavailable",
      probeWidevineSecurityLevel(
        isSupported = { true },
        readSecurityLevel = { throw RuntimeException("MediaDrm unavailable") },
      ),
    )
    assertEquals(
      "unavailable",
      probeWidevineSecurityLevel(isSupported = { true }, readSecurityLevel = { "" }),
    )

    val caps = probeDrmCapabilities(
      isSupported = { it == C.WIDEVINE_UUID || it == C.CLEARKEY_UUID },
      readSecurityLevel = { "L1" },
    )
    assertEquals("L1", caps["widevineSecurityLevel"])
    assertEquals(true, caps["clearKeySupported"])
  }
}

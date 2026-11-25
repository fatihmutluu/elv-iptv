package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.exoplayer.drm.DefaultDrmSessionManager
import androidx.media3.exoplayer.drm.DrmSessionManagerProvider
import androidx.media3.exoplayer.drm.FrameworkMediaDrm
import androidx.media3.exoplayer.drm.HttpMediaDrmCallback
import androidx.media3.exoplayer.drm.LocalMediaDrmCallback
import java.nio.charset.StandardCharsets
import java.util.Locale
import java.util.UUID

private const val CLEARKEY_KEY_BYTES = 16
private const val CLEARKEY_HEX_LEN = CLEARKEY_KEY_BYTES * 2
private const val MAX_CLEARKEY_PAIRS = 64
private const val B64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

private val B64URL_DECODE_TABLE = IntArray(128) { -1 }.apply {
  for (i in B64URL_ALPHABET.indices) {
    this[B64URL_ALPHABET[i].code] = i
  }
}

/** Supported Media3 DRM schemes (`#272`). */
internal enum class DrmSchemeKind(val wireName: String, val uuid: UUID) {
  CLEARKEY("clearkey", C.CLEARKEY_UUID),
  WIDEVINE("widevine", C.WIDEVINE_UUID),
  PLAYREADY("playready", C.PLAYREADY_UUID),
}

/** One validated ClearKey `(kid, key)` pair (`#272`). Never logs key material. */
internal data class DrmClearKeyPair(
  val kid: String,
  val key: String,
) {
  override fun toString(): String = "DrmClearKeyPair(redacted)"
}

/**
 * Validated play-time DRM configuration parsed from a `LoadCommand` (`#272`).
 * Never persisted and never prints license URLs, headers, or keys in [toString].
 */
internal data class ParsedDrmConfig(
  val scheme: DrmSchemeKind,
  val licenseUrl: String? = null,
  val licenseHeaders: Map<String, String> = emptyMap(),
  val clearKeys: List<DrmClearKeyPair> = emptyList(),
  val multiSession: Boolean = false,
) {
  override fun toString(): String =
    "ParsedDrmConfig(scheme=${scheme.wireName}, hasLicenseUrl=${licenseUrl != null}, " +
      "licenseHeaders=${licenseHeaders.size}, clearKeys=${clearKeys.size}, multiSession=$multiSession)"
}

private fun parseDrmScheme(raw: Any?): DrmSchemeKind? =
  when ((raw as? String)?.trim()?.lowercase(Locale.ROOT)) {
    "clearkey", "org.w3.clearkey", "e2719d58-a985-b3c9-781a-b030af78d30e" -> DrmSchemeKind.CLEARKEY
    "widevine", "com.widevine.alpha", "edef8ba9-79d6-4ace-a3c8-27dcd51d21ed" -> DrmSchemeKind.WIDEVINE
    "playready", "com.microsoft.playready", "9a04f079-9840-4286-ab92-e65be0885f95" -> DrmSchemeKind.PLAYREADY
    else -> null
  }

private fun hexNibble(c: Char): Int = when (c) {
  in '0'..'9' -> c - '0'
  in 'a'..'f' -> c - 'a' + 10
  in 'A'..'F' -> c - 'A' + 10
  else -> -1
}

private fun decodeHex16(raw: String): ByteArray? {
  if (raw.length != CLEARKEY_HEX_LEN) return null
  val out = ByteArray(CLEARKEY_KEY_BYTES)
  for (i in 0 until CLEARKEY_KEY_BYTES) {
    val hi = hexNibble(raw[i * 2])
    val lo = hexNibble(raw[i * 2 + 1])
    if (hi < 0 || lo < 0) return null
    out[i] = ((hi shl 4) or lo).toByte()
  }
  return out
}

private fun decodeBase64Url16(raw: String): ByteArray? {
  val unpadded = when {
    raw.endsWith("==") -> raw.substring(0, raw.length - 2)
    raw.endsWith("=") -> return null
    else -> raw
  }
  if (unpadded.length != 22) return null
  val out = ByteArray(CLEARKEY_KEY_BYTES)
  var outIdx = 0
  var acc = 0
  var bits = 0
  for (i in unpadded.indices) {
    val code = unpadded[i].code
    if (code >= 128) return null
    val value = B64URL_DECODE_TABLE[code]
    if (value < 0) return null
    acc = (acc shl 6) or value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[outIdx++] = ((acc shr bits) and 0xFF).toByte()
    }
  }
  // Remaining 4 unused low bits on a 16-byte (128-bit -> 22*6 = 132-bit) base64url payload must be zero
  if (outIdx != CLEARKEY_KEY_BYTES || (acc and ((1 shl bits) - 1)) != 0) return null
  return out
}

private fun encodeBase64UrlNoPad(bytes: ByteArray): String {
  val sb = StringBuilder(((bytes.size + 2) / 3) * 4)
  var i = 0
  while (i < bytes.size) {
    val b0 = bytes[i].toInt() and 0xFF
    val rem = bytes.size - i
    if (rem >= 3) {
      val b1 = bytes[i + 1].toInt() and 0xFF
      val b2 = bytes[i + 2].toInt() and 0xFF
      sb.append(B64URL_ALPHABET[b0 shr 2])
      sb.append(B64URL_ALPHABET[((b0 and 0x03) shl 4) or (b1 shr 4)])
      sb.append(B64URL_ALPHABET[((b1 and 0x0F) shl 2) or (b2 shr 6)])
      sb.append(B64URL_ALPHABET[b2 and 0x3F])
      i += 3
    } else if (rem == 2) {
      val b1 = bytes[i + 1].toInt() and 0xFF
      sb.append(B64URL_ALPHABET[b0 shr 2])
      sb.append(B64URL_ALPHABET[((b0 and 0x03) shl 4) or (b1 shr 4)])
      sb.append(B64URL_ALPHABET[(b1 and 0x0F) shl 2])
      i += 2
    } else {
      sb.append(B64URL_ALPHABET[b0 shr 2])
      sb.append(B64URL_ALPHABET[(b0 and 0x03) shl 4])
      i += 1
    }
  }
  return sb.toString()
}

/**
 * Normalizes a 32-char hex or base64url 16-byte ClearKey `kid`/`key` into canonical unpadded RFC 4648 base64url,
 * or returns `null` if invalid (`#272`).
 */
internal fun normalizeClearKeyComponent(raw: String): String? {
  val trimmed = raw.trim()
  if (trimmed.isEmpty()) return null
  val bytes = decodeHex16(trimmed) ?: decodeBase64Url16(trimmed) ?: return null
  return encodeBase64UrlNoPad(bytes)
}

/**
 * Builds an RFC/EME ClearKey JWK JSON payload (`{"keys":[...],"type":"temporary"}`) with unpadded base64url
 * `k` and `kid` values from [pairs], or returns `null` if [pairs] is empty or contains invalid key material (`#272`).
 */
internal fun buildClearKeyJwkJson(pairs: List<DrmClearKeyPair>): String? {
  if (pairs.isEmpty()) return null
  val normalized = ArrayList<Pair<String, String>>(pairs.size)
  for (pair in pairs) {
    val kid = normalizeClearKeyComponent(pair.kid) ?: return null
    val key = normalizeClearKeyComponent(pair.key) ?: return null
    normalized += kid to key
  }
  return buildString {
    append("{\"keys\":[")
    for (idx in normalized.indices) {
      if (idx > 0) append(',')
      val (kid, key) = normalized[idx]
      append("{\"kty\":\"oct\",\"k\":\"")
      append(key)
      append("\",\"kid\":\"")
      append(kid)
      append("\"}")
    }
    append("],\"type\":\"temporary\"}")
  }
}

/**
 * Parses and strictly validates a JS `LoadCommand.drm` map (`#272`):
 * - Allows only `http://`/`https://` `licenseUrl` values (never `file://`, `content://`, `data:`, etc.).
 * - Sanitizes `licenseHeaders` names/values.
 * - Strictly validates ClearKey hex/base64url `kid`/`key` pairs.
 */
internal fun parseDrmConfig(raw: Any?): ParsedDrmConfig? {
  val map = raw as? Map<*, *> ?: return null
  val scheme = parseDrmScheme(map["scheme"]) ?: return null
  val rawLicenseUrl = (map["licenseUrl"] as? String)?.trim()?.takeIf { it.isNotEmpty() }
  val licenseUrl = if (rawLicenseUrl != null && isAllowedPlaybackUrl(rawLicenseUrl)) rawLicenseUrl else null
  val rawHeaders = map["licenseHeaders"] as? Map<*, *>
  val licenseHeaders = LinkedHashMap<String, String>()
  if (rawHeaders != null) {
    for ((k, v) in rawHeaders) {
      val name = (k as? String)?.trim() ?: continue
      val value = v as? String ?: continue
      if (!isValidHeaderName(name)) continue
      licenseHeaders[name] = sanitizeHeaderValue(value)
    }
  }
  val clearKeys = ArrayList<DrmClearKeyPair>()
  if (scheme == DrmSchemeKind.CLEARKEY) {
    val rawPairs = map["clearKeys"] as? List<*>
    if (rawPairs != null) {
      for (entry in rawPairs) {
        if (clearKeys.size >= MAX_CLEARKEY_PAIRS) break
        val entryMap = entry as? Map<*, *> ?: continue
        val kid = entryMap["kid"] as? String ?: continue
        val key = entryMap["key"] as? String ?: continue
        val normKid = normalizeClearKeyComponent(kid) ?: continue
        val normKey = normalizeClearKeyComponent(key) ?: continue
        clearKeys += DrmClearKeyPair(kid = normKid, key = normKey)
      }
    }
  }
  val hasValidClearKeys = scheme == DrmSchemeKind.CLEARKEY && clearKeys.isNotEmpty()
  if (!hasValidClearKeys && licenseUrl == null) return null
  val multiSession = map["multiSession"] as? Boolean ?: false
  return ParsedDrmConfig(
    scheme = scheme,
    licenseUrl = licenseUrl,
    licenseHeaders = licenseHeaders,
    clearKeys = clearKeys,
    multiSession = multiSession,
  )
}

/**
 * Builds a Media3 [DrmSessionManagerProvider] for [drm] using [LocalMediaDrmCallback] for inline ClearKey pairs
 * or [HttpMediaDrmCallback] over [httpDataSourceFactory] for remote ClearKey / Widevine / PlayReady (`#272`).
 */
@OptIn(UnstableApi::class)
internal fun buildDrmSessionManagerProvider(
  drm: ParsedDrmConfig,
  httpDataSourceFactory: DataSource.Factory,
): DrmSessionManagerProvider? {
  if (drm.scheme == DrmSchemeKind.CLEARKEY && drm.clearKeys.isNotEmpty()) {
    val jwk = buildClearKeyJwkJson(drm.clearKeys) ?: return null
    val callback = LocalMediaDrmCallback(jwk.toByteArray(StandardCharsets.UTF_8))
    val manager = DefaultDrmSessionManager.Builder()
      .setUuidAndExoMediaDrmProvider(C.CLEARKEY_UUID, FrameworkMediaDrm.DEFAULT_PROVIDER)
      .setMultiSession(drm.multiSession)
      .build(callback)
    return DrmSessionManagerProvider { manager }
  }
  val url = drm.licenseUrl ?: return null
  val callback = HttpMediaDrmCallback(url, httpDataSourceFactory)
  for ((name, value) in drm.licenseHeaders) {
    if (name.equals("User-Agent", ignoreCase = true)) continue
    callback.setKeyRequestProperty(name, value)
  }
  val manager = DefaultDrmSessionManager.Builder()
    .setUuidAndExoMediaDrmProvider(drm.scheme.uuid, FrameworkMediaDrm.DEFAULT_PROVIDER)
    .setMultiSession(drm.multiSession)
    .build(callback)
  return DrmSessionManagerProvider { manager }
}

@OptIn(UnstableApi::class)
private fun readPlatformWidevineSecurityLevel(): String? {
  val drm = FrameworkMediaDrm.newInstance(C.WIDEVINE_UUID)
  return try {
    drm.getPropertyString("securityLevel")
  } finally {
    runCatching { drm.release() }
  }
}

/**
 * Safely probes Widevine hardware/software security level via [FrameworkMediaDrm], always releasing the native
 * DRM handle in `finally` (`#272`). Returns `"L1"`, `"L3"`, or `"unavailable"`.
 */
@OptIn(UnstableApi::class)
internal fun probeWidevineSecurityLevel(
  isSupported: (UUID) -> Boolean = FrameworkMediaDrm::isCryptoSchemeSupported,
  readSecurityLevel: () -> String? = ::readPlatformWidevineSecurityLevel,
): String {
  val supported = runCatching { isSupported(C.WIDEVINE_UUID) }.getOrDefault(false)
  if (!supported) return "unavailable"
  val level = runCatching { readSecurityLevel() }.getOrNull()?.trim()?.uppercase(Locale.ROOT)
  return when (level) {
    "L1" -> "L1"
    "L3" -> "L3"
    else -> "unavailable"
  }
}

/** Returns `{ widevineSecurityLevel, clearKeySupported }` for the JS capability bridge (`#272`). */
@OptIn(UnstableApi::class)
internal fun probeDrmCapabilities(
  isSupported: (UUID) -> Boolean = FrameworkMediaDrm::isCryptoSchemeSupported,
  readSecurityLevel: () -> String? = ::readPlatformWidevineSecurityLevel,
): Map<String, Any> {
  val widevineLevel = probeWidevineSecurityLevel(isSupported, readSecurityLevel)
  val clearKeySupported = runCatching { isSupported(C.CLEARKEY_UUID) }.getOrDefault(false)
  return mapOf(
    "widevineSecurityLevel" to widevineLevel,
    "clearKeySupported" to clearKeySupported,
  )
}

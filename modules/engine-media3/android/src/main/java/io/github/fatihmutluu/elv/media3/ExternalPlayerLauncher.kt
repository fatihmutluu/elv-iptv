package io.github.fatihmutluu.elv.media3

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import java.util.Locale

/** Distinct `startActivityForResult` request code for external video player handoff (#406). */
internal const val REQUEST_CODE_EXTERNAL_PLAYER = 0x4550

private const val DEFAULT_VIDEO_MIME_TYPE = "video/*"
private const val MAX_TITLE_LENGTH = 256
private const val MAX_MIME_LENGTH = 128
private const val MAX_PACKAGE_NAME_LENGTH = 128
private val SAFE_MIME_RE = Regex("^[a-z0-9!#$&^_.+-]+/(?:\\*|[a-z0-9!#$&^_.+-]+)$")
private val SAFE_PACKAGE_RE = Regex("^[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z][a-zA-Z0-9_]*)+$")

/** Validated request payload for launching an external Android video player (#406). Never logs URL or headers. */
internal data class ExternalPlayerRequest(
  val url: String,
  val mimeType: String = DEFAULT_VIDEO_MIME_TYPE,
  val title: String? = null,
  val startPositionMs: Long = 0L,
  val headers: Map<String, String> = emptyMap(),
  val chooserTitle: String? = null,
  val packageName: String? = null,
) {
  /** Redacts URL and header values so credentials or tokens never leak into logs or crash reports. */
  override fun toString(): String =
    "ExternalPlayerRequest(mimeType=$mimeType, hasTitle=${title != null}, " +
      "startPositionMs=$startPositionMs, headers=${headers.size}, hasPackage=${packageName != null})"
}

/** Normalized return result from an external Android video player activity (#406). */
internal data class ExternalPlayerResult(
  val launched: Boolean,
  val positionMs: Long? = null,
  val durationMs: Long? = null,
  val completed: Boolean = false,
) {
  fun toBridgeMap(): Map<String, Any?> = mapOf(
    "launched" to launched,
    "positionMs" to positionMs?.toDouble(),
    "durationMs" to durationMs?.toDouble(),
    "completed" to completed,
  )
}

/**
 * Pure intent builder and activity-result parser for Android external video player handoff (`#406`).
 * Follows the standard `ACTION_VIEW` + `return_result` / `position` / `duration` / `end_by` extras contract
 * without ever logging stream URLs or request headers.
 */
internal object ExternalPlayerLauncher {
  private fun stripControlChars(raw: String): String =
    buildString(raw.length) {
      for (c in raw) {
        if (c.code <= 0x1f || c.code == 0x7f) continue
        append(c)
      }
    }.trim()

  private fun hasControlChars(raw: String): Boolean =
    raw.any { it.code <= 0x1f || it.code == 0x7f }

  private fun sanitizeMimeType(raw: String?): String {
    val clean = raw?.let(::stripControlChars)?.substringBefore(';')?.trim()?.lowercase(Locale.ROOT)
      ?: return DEFAULT_VIDEO_MIME_TYPE
    if (clean.isEmpty() || clean.length > MAX_MIME_LENGTH || !SAFE_MIME_RE.matches(clean)) {
      return DEFAULT_VIDEO_MIME_TYPE
    }
    return clean
  }

  private fun sanitizePackageName(raw: String?): String? {
    if (raw == null || hasControlChars(raw)) return null
    val trimmed = raw.trim()
    if (trimmed.isEmpty() || trimmed.length > MAX_PACKAGE_NAME_LENGTH) return null
    return trimmed.takeIf { SAFE_PACKAGE_RE.matches(it) }
  }

  private fun sanitizeHeaders(raw: Map<String, String>): Map<String, String> {
    if (raw.isEmpty()) return emptyMap()
    val out = LinkedHashMap<String, String>(raw.size)
    for ((k, v) in raw) {
      if (hasControlChars(k) || hasControlChars(v)) continue
      val cleanKey = k.trim()
      if (cleanKey.isEmpty()) continue
      out[cleanKey] = v
    }
    return out
  }

  private fun finiteNonNegLongOrZero(raw: Any?): Long =
    when (raw) {
      is Double -> if (raw.isFinite() && raw >= 0.0) raw.toLong() else 0L
      is Float -> if (raw.isFinite() && raw >= 0f) raw.toLong() else 0L
      is Number -> raw.toLong().coerceAtLeast(0L)
      else -> 0L
    }

  /** Parses and validates a JS request map for `launchExternalPlayer`, returning `null` if the URL is disallowed. */
  fun parseRequest(raw: Map<String, Any?>): ExternalPlayerRequest? {
    val rawUrl = raw["url"] as? String ?: return null
    if (!isAllowedPlaybackUrl(rawUrl)) return null
    val url = rawUrl.trim()
    val mimeType = sanitizeMimeType(raw["mimeType"] as? String)
    val title = (raw["title"] as? String)?.let(::stripControlChars)?.take(MAX_TITLE_LENGTH)?.takeIf { it.isNotEmpty() }
    val chooserTitle = (raw["chooserTitle"] as? String)?.let(::stripControlChars)?.take(MAX_TITLE_LENGTH)?.takeIf { it.isNotEmpty() }
    val packageName = sanitizePackageName(raw["packageName"] as? String)
    val startPositionMs = finiteNonNegLongOrZero(raw["startPositionMs"])
    val rawHeaders = raw["headers"] as? Map<*, *>
    val headers = LinkedHashMap<String, String>()
    rawHeaders?.entries?.forEach { (k, v) ->
      if (k is String && v is String && !hasControlChars(k) && !hasControlChars(v)) {
        val cleanKey = k.trim()
        if (cleanKey.isNotEmpty()) headers[cleanKey] = v
      }
    }
    return ExternalPlayerRequest(
      url = url,
      mimeType = mimeType,
      title = title,
      startPositionMs = startPositionMs,
      headers = headers,
      chooserTitle = chooserTitle,
      packageName = packageName,
    )
  }

  /**
   * Builds an `ACTION_VIEW` intent (wrapped in `Intent.createChooser` when [packageName] is omitted) carrying
   * `title`, clamped `position`, `return_result = true`, and optional alternating key/value `headers` array.
   * Avoids `FLAG_ACTIVITY_NO_HISTORY` and `FLAG_ACTIVITY_NEW_TASK` so playback results return cleanly.
   * Returns `null` if [url] fails the `http`/`https` allowlist.
   */
  fun buildExternalPlayerIntent(
    url: String,
    mimeType: String?,
    title: String?,
    startPositionMs: Long,
    headers: Map<String, String> = emptyMap(),
    chooserTitle: String? = null,
    packageName: String? = null,
  ): Intent? {
    if (!isAllowedPlaybackUrl(url)) return null
    val trimmedUrl = url.trim()
    val resolvedMime = sanitizeMimeType(mimeType)
    val cleanTitle = title?.let(::stripControlChars)?.take(MAX_TITLE_LENGTH)?.takeIf { it.isNotEmpty() }
    val clampedPosition = startPositionMs.coerceIn(0L, Int.MAX_VALUE.toLong()).toInt()
    val cleanHeaders = sanitizeHeaders(headers)
    val validPackage = sanitizePackageName(packageName)

    val viewIntent = Intent(Intent.ACTION_VIEW).apply {
      setDataAndType(Uri.parse(trimmedUrl), resolvedMime)
      if (cleanTitle != null) putExtra("title", cleanTitle)
      putExtra("position", clampedPosition)
      putExtra("return_result", true)
      if (cleanHeaders.isNotEmpty()) {
        val headerPairs = ArrayList<String>(cleanHeaders.size * 2)
        for ((k, v) in cleanHeaders) {
          headerPairs.add(k)
          headerPairs.add(v)
        }
        putExtra("headers", headerPairs.toTypedArray())
      }
      if (validPackage != null) {
        setPackage(validPackage)
      }
    }

    if (validPackage != null) return viewIntent
    val cleanChooserTitle = chooserTitle?.let(::stripControlChars)?.take(MAX_TITLE_LENGTH)?.takeIf { it.isNotEmpty() }
    return Intent.createChooser(viewIntent, cleanChooserTitle)
  }

  /** Builds a launch intent from a validated [ExternalPlayerRequest]. */
  fun buildExternalPlayerIntent(request: ExternalPlayerRequest): Intent? =
    buildExternalPlayerIntent(
      url = request.url,
      mimeType = request.mimeType,
      title = request.title,
      startPositionMs = request.startPositionMs,
      headers = request.headers,
      chooserTitle = request.chooserTitle,
      packageName = request.packageName,
    )

  @Suppress("DEPRECATION")
  private fun readNumericLongExtra(extras: Bundle, key: String): Long? {
    if (!extras.containsKey(key)) return null
    return when (val raw = extras.get(key)) {
      is Int -> raw.toLong()
      is Long -> raw
      is Double -> if (raw.isFinite()) raw.toLong() else null
      is Float -> if (raw.isFinite()) raw.toLong() else null
      else -> null
    }
  }

  /**
   * Parses returned external-player extras (`position` / `extra_position`, `duration` / `extra_duration`,
   * and `end_by`), safely dropping negative/invalid values and clamping `positionMs <= durationMs`.
   */
  fun parseExternalPlayerResult(@Suppress("UNUSED_PARAMETER") resultCode: Int, data: Intent?): ExternalPlayerResult {
    val extras = data?.extras
      ?: return ExternalPlayerResult(launched = true, positionMs = null, durationMs = null, completed = false)
    val rawDuration = readNumericLongExtra(extras, "duration") ?: readNumericLongExtra(extras, "extra_duration")
    val durationMs = rawDuration?.takeIf { it > 0L }
    val rawPosition = readNumericLongExtra(extras, "position") ?: readNumericLongExtra(extras, "extra_position")
    val validPosition = rawPosition?.takeIf { it >= 0L }
    val clampedPosition = if (validPosition != null && durationMs != null) {
      validPosition.coerceAtMost(durationMs)
    } else {
      validPosition
    }
    val endBy = extras.getString("end_by")?.trim()
    val completed = endBy != null && endBy.equals("playback_completion", ignoreCase = true)
    return ExternalPlayerResult(
      launched = true,
      positionMs = clampedPosition,
      durationMs = durationMs,
      completed = completed,
    )
  }
}

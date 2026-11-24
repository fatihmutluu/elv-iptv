package io.github.fatihmutluu.elv.tvhomechannels

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URI
import java.net.URL
import java.security.MessageDigest

/**
 * Bounded, SSRF-safe SHA-256 logo disk cache stored under `cacheDir/tv_channel_logos/`
 * and exposed to Android TV launchers exclusively via `FileProvider` read-only grants (`#273`).
 */
class TvChannelLogoCache(
  private val context: Context,
) {
  private val logoDir: File = File(context.cacheDir, LOGO_DIR_NAME)
  private val authority: String = "${context.packageName}.tvchannels.fileprovider"

  /**
   * Resolves a remote logo URL to a `FileProvider` `content://` URI with read permission granted
   * to Android TV launcher packages. Must be called from a background IO thread.
   */
  fun resolveLogoUri(rawUrl: String): Uri? {
    if (!TvChannelSecurity.isSafeLogoUrl(rawUrl)) return null
    ensureDir()

    val hash = sha256Hex(rawUrl)
    findCachedFile(hash)?.let { cached ->
      cached.setLastModified(System.currentTimeMillis())
      return exposeAndGrant(cached)
    }

    val fetched = fetchBoundedImage(rawUrl) ?: return null
    val targetFile = File(logoDir, "$hash${fetched.extension}")
    if (!writeAtomically(targetFile, fetched.bytes)) return null

    pruneOldestFiles()
    return exposeAndGrant(targetFile)
  }

  /** Deletes all cached launcher logo files cleanly. */
  fun clearCache() {
    runCatching {
      logoDir.listFiles()?.forEach { file ->
        runCatching { file.delete() }
      }
    }
  }

  private data class FetchedImage(
    val bytes: ByteArray,
    val extension: String,
  )

  private fun fetchBoundedImage(initialUrl: String): FetchedImage? {
    var currentUrl = initialUrl
    for (hop in 0..TvChannelSecurity.MAX_REDIRECT_HOPS) {
      if (!TvChannelSecurity.isSafeLogoUrl(currentUrl)) return null
      val parsedUri = runCatching { URI(currentUrl) }.getOrNull() ?: return null
      val host = parsedUri.host?.removePrefix("[")?.removeSuffix("]") ?: return null

      // DNS rebinding guard: reject if any resolved address is private/loopback/link-local/ULA.
      val addresses = runCatching { InetAddress.getAllByName(host) }.getOrNull() ?: return null
      if (addresses.isEmpty() || addresses.any { TvChannelSecurity.isBlockedInetAddress(it) }) {
        return null
      }

      val conn = runCatching {
        URL(currentUrl).openConnection() as? HttpURLConnection
      }.getOrNull() ?: return null

      try {
        conn.instanceFollowRedirects = false
        conn.connectTimeout = CONNECT_TIMEOUT_MS
        conn.readTimeout = READ_TIMEOUT_MS
        conn.requestMethod = "GET"
        conn.setRequestProperty("Accept", "image/png, image/jpeg, image/webp, image/gif;q=0.8")

        val status = conn.responseCode
        if (status in REDIRECT_STATUS_CODES) {
          if (hop >= TvChannelSecurity.MAX_REDIRECT_HOPS) return null
          val location = conn.getHeaderField("Location")?.trim() ?: return null
          val nextUrl = runCatching { parsedUri.resolve(location).toString() }.getOrNull() ?: return null
          currentUrl = nextUrl
          continue
        }

        if (status != HttpURLConnection.HTTP_OK) return null
        val contentType = conn.contentType
        if (!TvChannelSecurity.isSafeImageContentType(contentType)) return null

        val declaredLength = conn.contentLengthLong
        if (declaredLength > TvChannelSecurity.MAX_LOGO_BYTES) return null

        val bytes = readBoundedStream(conn) ?: return null
        return FetchedImage(
          bytes = bytes,
          extension = TvChannelSecurity.extensionForImageContentType(contentType),
        )
      } catch (_: Exception) {
        return null
      } finally {
        runCatching { conn.disconnect() }
      }
    }
    return null
  }

  private fun readBoundedStream(conn: HttpURLConnection): ByteArray? {
    val maxBytes = TvChannelSecurity.MAX_LOGO_BYTES
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8 * 1024)
    var total = 0
    conn.inputStream.use { input ->
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        if (read == 0) continue
        total += read
        if (total > maxBytes) return null
        output.write(buffer, 0, read)
      }
    }
    if (total <= 0) return null
    return output.toByteArray()
  }

  private fun findCachedFile(hash: String): File? {
    for (ext in KNOWN_EXTENSIONS) {
      val candidate = File(logoDir, "$hash$ext")
      if (candidate.isFile && candidate.length() in 1L..TvChannelSecurity.MAX_LOGO_BYTES.toLong()) {
        return candidate
      }
    }
    return null
  }

  private fun writeAtomically(target: File, data: ByteArray): Boolean {
    var tempFile: File? = null
    return try {
      ensureDir()
      tempFile = File.createTempFile("logo_", ".tmp", logoDir)
      tempFile.writeBytes(data)
      if (target.exists()) target.delete()
      if (!tempFile.renameTo(target)) {
        tempFile.copyTo(target, overwrite = true)
        tempFile.delete()
      }
      true
    } catch (_: Exception) {
      runCatching { tempFile?.delete() }
      false
    }
  }

  private fun pruneOldestFiles() {
    runCatching {
      val files = logoDir.listFiles { file ->
        file.isFile && !file.name.endsWith(".tmp")
      } ?: return
      if (files.size <= TvChannelSecurity.MAX_CACHED_LOGOS) return
      files.sortBy { it.lastModified() }
      val excess = files.size - TvChannelSecurity.MAX_CACHED_LOGOS
      for (i in 0 until excess) {
        runCatching { files[i].delete() }
      }
    }
  }

  private fun exposeAndGrant(file: File): Uri? {
    val uri = runCatching {
      FileProvider.getUriForFile(context, authority, file)
    }.getOrNull() ?: return null
    grantLauncherReadPermission(uri)
    return uri
  }

  private fun grantLauncherReadPermission(uri: Uri) {
    val packages = LinkedHashSet<String>(KNOWN_LAUNCHER_PACKAGES)
    val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER)
    runCatching {
      @Suppress("DEPRECATION")
      context.packageManager.queryIntentActivities(launcherIntent, 0)
        .mapNotNull { it.activityInfo?.packageName }
        .filterTo(packages) { it.isNotEmpty() }
    }
    for (pkg in packages) {
      runCatching {
        context.grantUriPermission(pkg, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
    }
  }

  private fun ensureDir() {
    if (!logoDir.exists()) {
      logoDir.mkdirs()
    }
  }

  private fun sha256Hex(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    val out = StringBuilder(digest.size * 2)
    for (byte in digest) {
      val v = byte.toInt() and 0xFF
      out.append(HEX_CHARS[v ushr 4])
      out.append(HEX_CHARS[v and 0x0F])
    }
    return out.toString()
  }

  companion object {
    private const val LOGO_DIR_NAME = "tv_channel_logos"
    private const val CONNECT_TIMEOUT_MS = 5_000
    private const val READ_TIMEOUT_MS = 5_000
    private val HEX_CHARS = "0123456789abcdef".toCharArray()
    private val KNOWN_EXTENSIONS = listOf(".png", ".jpg", ".webp", ".gif")
    private val REDIRECT_STATUS_CODES = setOf(301, 302, 303, 307, 308)
    private val KNOWN_LAUNCHER_PACKAGES = listOf(
      "com.google.android.tvlauncher",
      "com.google.android.apps.tv.launcherx",
    )
  }
}

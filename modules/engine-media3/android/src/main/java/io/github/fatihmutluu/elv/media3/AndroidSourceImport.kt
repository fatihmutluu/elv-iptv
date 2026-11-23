package io.github.fatihmutluu.elv.media3

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/** Maximum local playlist size accepted by the zero-permission SAF picker (64 MiB, #51). */
internal const val MAX_LOCAL_PLAYLIST_BYTES = 64 * 1024 * 1024

internal const val PICK_PLAYLIST_REQUEST_CODE = 0x454C

internal class PlaylistTooLargeException(val limitBytes: Int) :
  IOException("Local playlist exceeds $limitBytes byte limit")

internal data class PickedPlaylistDocument(
  val name: String,
  val base64: String,
) {
  fun toBridgeMap(): Map<String, String> = mapOf("name" to name, "base64" to base64)
}

/**
 * Reads plain text from the system clipboard without requesting any storage or runtime permissions (#51).
 * Returns `null` when clipboard is empty, unavailable, or blocked by OS background restrictions.
 */
internal fun readClipboardTextFromContext(context: Context): String? =
  runCatching {
    val manager = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    if (!manager.hasPrimaryClip()) return null
    val clip = manager.primaryClip ?: return null
    if (clip.itemCount <= 0) return null
    clip.getItemAt(0)?.coerceToText(context)?.toString()?.takeIf { it.isNotEmpty() }
  }.getOrNull()

/** Builds a zero-permission Storage Access Framework `ACTION_OPEN_DOCUMENT` intent for M3U/gzip playlists (#51). */
internal fun createPlaylistPickerIntent(): Intent =
  Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = "*/*"
    putExtra(
      Intent.EXTRA_MIME_TYPES,
      arrayOf(
        "audio/x-mpegurl",
        "application/vnd.apple.mpegurl",
        "application/x-mpegurl",
        "audio/mpegurl",
        "application/gzip",
        "application/x-gzip",
        "text/plain",
        "application/octet-stream",
      ),
    )
  }

/** Reads at most [maxBytes] from [input], throwing [PlaylistTooLargeException] if the stream exceeds the cap. */
internal fun readBoundedBytes(input: InputStream, maxBytes: Int = MAX_LOCAL_PLAYLIST_BYTES): ByteArray {
  val out = ByteArrayOutputStream()
  val buf = ByteArray(16 * 1024)
  var total = 0
  while (true) {
    val read = input.read(buf)
    if (read <= 0) break
    total += read
    if (total > maxBytes) throw PlaylistTooLargeException(maxBytes)
    out.write(buf, 0, read)
  }
  return out.toByteArray()
}

internal fun resolveDocumentDisplayName(context: Context, uri: Uri): String {
  val queried = runCatching {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
      val idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
      if (idx >= 0 && cursor.moveToFirst()) cursor.getString(idx)?.trim() else null
    }
  }.getOrNull()
  if (!queried.isNullOrEmpty()) return queried
  val fallback = uri.lastPathSegment?.substringAfterLast('/')?.trim()
  return if (!fallback.isNullOrEmpty()) fallback else "playlist.m3u"
}

/** Reads a SAF document URI with a strict [maxBytes] cap and encodes it as base64 for JS transport (#51). */
internal fun readBoundedPlaylistDocument(
  context: Context,
  uri: Uri,
  maxBytes: Int = MAX_LOCAL_PLAYLIST_BYTES,
): PickedPlaylistDocument? {
  val bytes = context.contentResolver.openInputStream(uri)?.use { stream ->
    readBoundedBytes(stream, maxBytes)
  } ?: return null
  val name = resolveDocumentDisplayName(context, uri)
  return PickedPlaylistDocument(name = name, base64 = Base64.encodeToString(bytes, Base64.NO_WRAP))
}

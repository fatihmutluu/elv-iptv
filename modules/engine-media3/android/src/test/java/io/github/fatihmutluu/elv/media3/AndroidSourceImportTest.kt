package io.github.fatihmutluu.elv.media3

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import java.io.ByteArrayInputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class AndroidSourceImportTest {
  @Test
  fun `readClipboardTextFromContext reads plain text and returns null when empty (#51)`() {
    val ctx = RuntimeEnvironment.getApplication()
    val clipboard = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("url", "https://example.test/playlist.m3u"))
    assertEquals("https://example.test/playlist.m3u", readClipboardTextFromContext(ctx))

    clipboard.setPrimaryClip(ClipData.newPlainText("empty", ""))
    assertNull(readClipboardTextFromContext(ctx))
  }

  @Test
  fun `createPlaylistPickerIntent builds zero-permission SAF ACTION_OPEN_DOCUMENT intent (#51)`() {
    val intent = createPlaylistPickerIntent()
    assertEquals(Intent.ACTION_OPEN_DOCUMENT, intent.action)
    assertTrue(intent.hasCategory(Intent.CATEGORY_OPENABLE))
    val mimes = intent.getStringArrayExtra(Intent.EXTRA_MIME_TYPES)
    assertTrue(mimes != null && mimes.contains("audio/x-mpegurl"))
    assertTrue(mimes != null && mimes.contains("application/gzip"))
  }

  @Test
  fun `readBoundedBytes reads up to cap and throws PlaylistTooLargeException beyond cap (#51)`() {
    val payload = "#EXTM3U\n#EXTINF:-1,One\nhttp://a/1.ts\n".toByteArray()
    assertArrayEquals(payload, readBoundedBytes(ByteArrayInputStream(payload), maxBytes = payload.size))

    var threw = false
    try {
      readBoundedBytes(ByteArrayInputStream(payload), maxBytes = payload.size - 1)
    } catch (_: PlaylistTooLargeException) {
      threw = true
    }
    assertTrue(threw)
  }
}

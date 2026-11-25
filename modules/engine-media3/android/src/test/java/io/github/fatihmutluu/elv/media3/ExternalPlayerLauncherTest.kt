package io.github.fatihmutluu.elv.media3

import android.app.Activity
import android.content.Intent
import android.net.Uri
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ExternalPlayerLauncherTest {
  @Test
  fun `request code is distinct from playlist picker request code`() {
    assertNotEquals(PICK_PLAYLIST_REQUEST_CODE, REQUEST_CODE_EXTERNAL_PLAYER)
    assertTrue(REQUEST_CODE_EXTERNAL_PLAYER in 1..65535)
  }

  @Test
  fun `buildExternalPlayerIntent creates chooser intent with standard video extras and avoids no-history flag`() {
    val chooser = ExternalPlayerLauncher.buildExternalPlayerIntent(
      url = "https://cdn.example.test/vod/secret-token/movie.mkv",
      mimeType = "video/x-matroska",
      title = "Sample Movie",
      startPositionMs = 95_000L,
      headers = linkedMapOf(
        "User-Agent" to "ELV/1.0",
        "Authorization" to "Bearer secret-val",
      ),
      chooserTitle = "Play with",
    )
    assertNotNull(chooser)
    assertEquals(Intent.ACTION_CHOOSER, chooser!!.action)
    assertEquals("Play with", chooser.getStringExtra(Intent.EXTRA_TITLE))

    @Suppress("DEPRECATION")
    val inner = chooser.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
    assertNotNull(inner)
    assertEquals(Intent.ACTION_VIEW, inner!!.action)
    assertEquals(Uri.parse("https://cdn.example.test/vod/secret-token/movie.mkv"), inner.data)
    assertEquals("video/x-matroska", inner.type)
    assertEquals("Sample Movie", inner.getStringExtra("title"))
    assertEquals(95_000, inner.getIntExtra("position", -1))
    assertTrue(inner.getBooleanExtra("return_result", false))
    assertArrayEquals(
      arrayOf("User-Agent", "ELV/1.0", "Authorization", "Bearer secret-val"),
      inner.getStringArrayExtra("headers"),
    )
    assertEquals(0, inner.flags and Intent.FLAG_ACTIVITY_NO_HISTORY)
    assertEquals(0, inner.flags and Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  @Test
  fun `buildExternalPlayerIntent clamps position bounds and supports explicit package without chooser`() {
    val direct = ExternalPlayerLauncher.buildExternalPlayerIntent(
      url = "http://cdn.example.test/live/ch1.ts",
      mimeType = null,
      title = null,
      startPositionMs = -500L,
      headers = emptyMap(),
      chooserTitle = "Ignored when explicit package",
      packageName = "com.example.externalplayer",
    )
    assertNotNull(direct)
    assertEquals(Intent.ACTION_VIEW, direct!!.action)
    assertEquals("com.example.externalplayer", direct.`package`)
    assertEquals("video/*", direct.type)
    assertEquals(0, direct.getIntExtra("position", -1))
    assertNull(direct.getStringArrayExtra("headers"))

    val hugePos = ExternalPlayerLauncher.buildExternalPlayerIntent(
      url = "https://cdn.example.test/vod/long.mp4",
      mimeType = "video/mp4",
      title = "Long",
      startPositionMs = Long.MAX_VALUE,
      headers = emptyMap(),
      chooserTitle = null,
      packageName = "com.example.secondplayer",
    )
    assertNotNull(hugePos)
    assertEquals(Int.MAX_VALUE, hugePos!!.getIntExtra("position", -1))
  }

  @Test
  fun `buildExternalPlayerIntent rejects disallowed URLs and redacts request toString`() {
    assertNull(
      ExternalPlayerLauncher.buildExternalPlayerIntent(
        url = "file:///etc/passwd",
        mimeType = "video/*",
        title = "Bad",
        startPositionMs = 0L,
        headers = emptyMap(),
        chooserTitle = null,
      ),
    )
    assertNull(
      ExternalPlayerLauncher.buildExternalPlayerIntent(
        url = "javascript:alert(1)",
        mimeType = "video/*",
        title = "Bad",
        startPositionMs = 0L,
        headers = emptyMap(),
        chooserTitle = null,
      ),
    )
    assertNull(
      ExternalPlayerLauncher.buildExternalPlayerIntent(
        url = "   ",
        mimeType = "video/*",
        title = "Bad",
        startPositionMs = 0L,
        headers = emptyMap(),
        chooserTitle = null,
      ),
    )

    val parsed = ExternalPlayerLauncher.parseRequest(
      mapOf(
        "url" to "https://user:pass@cdn.example.test/secret/stream.ts",
        "headers" to mapOf("Authorization" to "Bearer top-secret"),
        "title" to "Live Channel",
      ),
    )
    assertNotNull(parsed)
    val redacted = parsed!!.toString()
    assertFalse("URL must never appear in toString", redacted.contains("pass"))
    assertFalse("URL host must never appear in toString", redacted.contains("cdn.example.test"))
    assertFalse("Header secret must never appear in toString", redacted.contains("top-secret"))
  }

  @Test
  fun `parseExternalPlayerResult reads Int and Long extras, end_by completion, and clamps invalid values`() {
    val intData = Intent().apply {
      putExtra("position", 120_000)
      putExtra("duration", 360_000)
      putExtra("end_by", "user")
    }
    val intResult = ExternalPlayerLauncher.parseExternalPlayerResult(Activity.RESULT_OK, intData)
    assertEquals(
      ExternalPlayerResult(launched = true, positionMs = 120_000L, durationMs = 360_000L, completed = false),
      intResult,
    )

    val longCompletedData = Intent().apply {
      putExtra("position", 500_000L)
      putExtra("duration", 450_000L)
      putExtra("end_by", "playback_completion")
    }
    val completedResult = ExternalPlayerLauncher.parseExternalPlayerResult(Activity.RESULT_OK, longCompletedData)
    assertEquals(
      ExternalPlayerResult(launched = true, positionMs = 450_000L, durationMs = 450_000L, completed = true),
      completedResult,
    )

    val vlcStyleData = Intent().apply {
      putExtra("extra_position", 45_000L)
      putExtra("extra_duration", 90_000L)
    }
    val vlcResult = ExternalPlayerLauncher.parseExternalPlayerResult(Activity.RESULT_OK, vlcStyleData)
    assertEquals(
      ExternalPlayerResult(launched = true, positionMs = 45_000L, durationMs = 90_000L, completed = false),
      vlcResult,
    )

    val invalidData = Intent().apply {
      putExtra("position", -42)
      putExtra("duration", 0)
      putExtra("end_by", "error")
    }
    val invalidResult = ExternalPlayerLauncher.parseExternalPlayerResult(Activity.RESULT_OK, invalidData)
    assertEquals(
      ExternalPlayerResult(launched = true, positionMs = null, durationMs = null, completed = false),
      invalidResult,
    )

    val canceledResult = ExternalPlayerLauncher.parseExternalPlayerResult(Activity.RESULT_CANCELED, null)
    assertEquals(
      ExternalPlayerResult(launched = true, positionMs = null, durationMs = null, completed = false),
      canceledResult,
    )
  }
}

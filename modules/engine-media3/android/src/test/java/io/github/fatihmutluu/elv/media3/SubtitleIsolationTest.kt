package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import androidx.media3.exoplayer.source.MergingMediaSource
import java.io.File
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit.SECONDS
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class SubtitleIsolationTest {
  private fun readRequestHead(socket: java.net.Socket): String {
    socket.soTimeout = 5_000
    val head = StringBuilder()
    val input = socket.getInputStream()
    while (!head.endsWith("\r\n\r\n")) {
      val b = input.read()
      if (b < 0) break
      head.append(b.toChar())
    }
    return head.toString()
  }

  @Test
  fun `primary stream Authorization, Cookie, User-Agent and Referer never appear on external subtitle requests (#308)`() {
    val streamHeads = LinkedBlockingQueue<String>()
    val subHeads = LinkedBlockingQueue<String>()
    val srtBody = "1\r\n00:00:01,000 --> 00:00:04,000\r\nIsolated subtitle line\r\n"

    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { streamServer ->
      ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { subServer ->
        val streamThread = thread(isDaemon = true) {
          streamServer.accept().use { client ->
            streamHeads.put(readRequestHead(client))
            val resp = "HTTP/1.1 200 OK\r\n" +
              "Set-Cookie: jar_secret=from_stream; Path=/\r\n" +
              "Content-Length: 2\r\n\r\nok"
            client.getOutputStream().write(resp.toByteArray())
          }
        }
        val subThread = thread(isDaemon = true) {
          subServer.accept().use { client ->
            subHeads.put(readRequestHead(client))
            val bytes = srtBody.toByteArray(Charsets.UTF_8)
            val resp = "HTTP/1.1 200 OK\r\nContent-Type: application/x-subrip\r\nContent-Length: ${bytes.size}\r\n\r\n"
            client.getOutputStream().write(resp.toByteArray())
            client.getOutputStream().write(bytes)
          }
        }

        val streamUrl = "http://127.0.0.1:${streamServer.localPort}/live/secret/1001.ts"
        val subUrl = "http://127.0.0.1:${subServer.localPort}/subs/en.srt"

        // 1) Open primary stream request with full credentials and Set-Cookie jar poisoning attempt
        val primaryClient = engineHttpClient()
        val primaryHeaders = mapOf(
          "Authorization" to "Bearer secret",
          "Cookie" to "sid=123",
          "User-Agent" to "PrimaryStreamAgent/9.9",
          "Referer" to "http://provider.secret/panel",
          "X-Provider-Secret" to "top-secret-value",
        )
        val (primarySource, _) = streamDataSource(primaryHeaders, primaryClient, streamUrl)
        try {
          primarySource.open(DataSpec(Uri.parse(streamUrl)))
        } finally {
          primarySource.close()
        }

        // 2) Fetch external subtitle via StreamHttp.subtitleDataSourceFactory (zero subtitle headers)
        val subFactory = StreamHttp.subtitleDataSourceFactory(
          subtitleHeaders = emptyMap(),
          allowLegacyTls = false,
          context = RuntimeEnvironment.getApplication(),
        )
        val subSource = subFactory.createDataSource()
        val readBuf = ByteArray(256)
        val readBytes: Int
        try {
          subSource.open(DataSpec(Uri.parse(subUrl)))
          readBytes = subSource.read(readBuf, 0, readBuf.size)
        } finally {
          subSource.close()
        }

        streamThread.join(5_000)
        subThread.join(5_000)

        val streamHead = streamHeads.poll(5, SECONDS)!!
        val subHead = subHeads.poll(5, SECONDS)!!

        // Verify primary stream DID send its headers
        assertTrue(streamHead.contains("Bearer secret"))
        assertTrue(streamHead.contains("sid=123"))
        assertTrue(streamHead.contains("PrimaryStreamAgent/9.9"))
        assertTrue(streamHead.contains("provider.secret"))

        // Verify external subtitle request received ZERO primary stream headers or cookies
        assertFalse("Authorization leaked to subtitle request: $subHead", subHead.contains("Bearer secret"))
        assertFalse("Authorization header present: $subHead", subHead.lowercase().contains("authorization:"))
        assertFalse("Cookie leaked to subtitle request: $subHead", subHead.contains("sid=123"))
        assertFalse("Stream jar cookie leaked: $subHead", subHead.contains("jar_secret"))
        assertFalse("Cookie header present: $subHead", subHead.lowercase().contains("cookie:"))
        assertFalse("Primary User-Agent leaked: $subHead", subHead.contains("PrimaryStreamAgent"))
        assertFalse("Primary Referer leaked: $subHead", subHead.contains("provider.secret"))
        assertFalse("Custom stream header leaked: $subHead", subHead.contains("top-secret-value"))

        assertTrue("Subtitle payload must be read cleanly", readBytes > 0)
        assertTrue(String(readBuf, 0, readBytes, Charsets.UTF_8).contains("Isolated subtitle line"))
      }
    }
  }

  @Test
  fun `external subtitle headers stay scoped to initial origin and strip Authorization and Cookie on cross-origin redirects (#308)`() {
    val originHeads = LinkedBlockingQueue<String>()
    val redirectHeads = LinkedBlockingQueue<String>()

    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { redirectTarget ->
      ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { originServer ->
        val originUrl = "http://127.0.0.1:${originServer.localPort}/subs/track.vtt"
        val redirectUrl = "http://127.0.0.1:${redirectTarget.localPort}/cdn/track.vtt"

        val originThread = thread(isDaemon = true) {
          originServer.accept().use { client ->
            originHeads.put(readRequestHead(client))
            val resp = "HTTP/1.1 302 Found\r\nLocation: $redirectUrl\r\nContent-Length: 0\r\n\r\n"
            client.getOutputStream().write(resp.toByteArray())
          }
        }
        val targetThread = thread(isDaemon = true) {
          redirectTarget.accept().use { client ->
            redirectHeads.put(readRequestHead(client))
            val body = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nRedirected cue\n".toByteArray()
            val resp = "HTTP/1.1 200 OK\r\nContent-Length: ${body.size}\r\n\r\n"
            client.getOutputStream().write(resp.toByteArray())
            client.getOutputStream().write(body)
          }
        }

        val factory = StreamHttp.subtitleDataSourceFactory(
          subtitleHeaders = mapOf(
            "Authorization" to "Bearer sub-only-token",
            "Cookie" to "sub_session=xyz",
            "X-Sub-Custom" to "safe-header",
          ),
          allowLegacyTls = false,
          context = RuntimeEnvironment.getApplication(),
        )
        val loader = ExternalSubtitleLoader(
          context = RuntimeEnvironment.getApplication(),
          dataSourceFactoryProvider = { _, _ -> factory },
        )
        try {
          val cues = loader.loadSync(
            ExternalSubtitleConfig(
              id = "s1",
              uri = originUrl,
              mimeType = MimeTypes.TEXT_VTT,
            )
          )
          assertEquals(1, cues.size)
          assertEquals("Redirected cue", cues.single().text)
        } finally {
          loader.dispose()
        }

        originThread.join(5_000)
        targetThread.join(5_000)
      }
    }

    val firstHead = originHeads.poll(5, SECONDS)!!
    val secondHead = redirectHeads.poll(5, SECONDS)!!

    assertTrue("Origin subtitle request sends declared subtitle Authorization", firstHead.contains("Bearer sub-only-token"))
    assertTrue("Origin subtitle request sends declared subtitle Cookie", firstHead.contains("sub_session=xyz"))
    assertFalse("Subtitle Authorization leaked across redirect: $secondHead", secondHead.contains("sub-only-token"))
    assertFalse("Subtitle Cookie leaked across redirect: $secondHead", secondHead.contains("sub_session=xyz"))
    assertTrue("Non-sensitive subtitle header preserved across redirect", secondHead.contains("X-Sub-Custom: safe-header"))
  }

  @Test
  fun `allowlists only http, https, file, content schemes, caps URI at 4096 chars, and reads local file safely (#308)`() {
    assertTrue(isAllowedExternalSubtitleUri("http://subs.example/a.srt"))
    assertTrue(isAllowedExternalSubtitleUri("https://subs.example/a.vtt"))
    assertTrue(isAllowedExternalSubtitleUri("file:///storage/emulated/0/Download/movie.srt"))
    assertTrue(isAllowedExternalSubtitleUri("content://com.android.providers.downloads/document/1"))

    assertFalse(isAllowedExternalSubtitleUri(""))
    assertFalse(isAllowedExternalSubtitleUri("javascript:alert(1)"))
    assertFalse(isAllowedExternalSubtitleUri("ftp://subs.example/a.srt"))
    assertFalse(isAllowedExternalSubtitleUri("data:text/vtt;base64,V0VCVlRU"))
    assertFalse(isAllowedExternalSubtitleUri("file://"))
    assertFalse(isAllowedExternalSubtitleUri("content://"))
    assertFalse(isAllowedExternalSubtitleUri("https://subs.example/a.srt\r\nX-Evil: 1"))
    assertFalse(isAllowedExternalSubtitleUri("https://subs.example/" + "a".repeat(MAX_EXTERNAL_SUBTITLE_URI_LENGTH)))

    // Reject disallowed scheme inside IsolatedSubtitleDataSource too
    val factory = StreamHttp.subtitleDataSourceFactory(context = RuntimeEnvironment.getApplication())
    val ds = factory.createDataSource()
    try {
      ds.open(DataSpec(Uri.parse("data:text/plain,evil")))
      fail("Expected IOException for disallowed scheme")
    } catch (_: IOException) {
      // expected
    } finally {
      ds.close()
    }

    // Local file:// read through isolated subtitle loader
    val tempFile = File.createTempFile("elv-sub-", ".srt")
    try {
      tempFile.writeText("1\n00:00:02,000 --> 00:00:05,500\nLocal SRT cue\n")
      val loader = ExternalSubtitleLoader(context = RuntimeEnvironment.getApplication())
      try {
        val fileUri = "file://" + tempFile.toURI().rawPath
        val cues = loader.loadSync(ExternalSubtitleConfig(id = "local-1", uri = fileUri))
        assertEquals(1, cues.size)
        assertEquals(2_000L, cues[0].startMs)
        assertEquals(5_500L, cues[0].endMs)
        assertEquals("Local SRT cue", cues[0].text)
      } finally {
        loader.dispose()
      }
    } finally {
      tempFile.delete()
    }

    // parseExternalSubtitleConfig strips control chars, caps URI, and hides URI/headers from toString()
    val parsed = parseExternalSubtitleConfig(
      mapOf(
        "id" to "tr-1",
        "uri" to "https://subs.example/secret-token/movie.ass",
        "label" to "Turkish ASS",
        "language" to "tr",
        "headers" to mapOf("Authorization" to "Bearer hidden-sub"),
      )
    )
    assertNotNull(parsed)
    assertEquals("ext:tr-1", parsed!!.trackId)
    assertEquals(MimeTypes.TEXT_SSA, parsed.mimeType)
    assertFalse(parsed.toString().contains("secret-token"))
    assertFalse(parsed.toString().contains("hidden-sub"))
    assertNull(parseExternalSubtitleConfig(mapOf("id" to "bad", "uri" to "ftp://bad/a.srt")))

    // createMediaSource attaches external subtitles via MergingMediaSource with isolated DataSource.Factory
    var providerCalls = 0
    val merged = createMediaSource(
      request = LoadRequest(
        url = "http://127.0.0.1:7878/movie/1.mp4",
        headers = mapOf("Authorization" to "Bearer primary-secret"),
        live = false,
        startMs = null,
        softwareAudio = false,
        externalSubtitles = listOf(parsed),
      ),
      gate = ConnectionGate { it.run() },
      generation = 1L,
      prepareSerial = 77L,
      lowRam = false,
      client = engineHttpClient(),
      context = RuntimeEnvironment.getApplication(),
      subtitleDataSourceFactoryProvider = { sub, _ ->
        providerCalls += 1
        assertEquals("ext:tr-1", sub.trackId)
        StreamHttp.subtitleDataSourceFactory(sub.headers, false, RuntimeEnvironment.getApplication())
      },
    )
    assertTrue("Expected MergingMediaSource when externalSubtitles present", merged is MergingMediaSource)
    assertEquals("77", merged.mediaItem.mediaId)
    assertEquals(1, providerCalls)
  }
}

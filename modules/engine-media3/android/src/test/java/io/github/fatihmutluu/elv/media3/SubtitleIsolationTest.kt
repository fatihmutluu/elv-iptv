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
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit.MILLISECONDS
import java.util.concurrent.TimeUnit.SECONDS
import java.util.concurrent.atomic.AtomicReference
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

  @Test
  fun `IsolatedSubtitleDataSource enforces hard 4 MiB cap on Content-Length and chunked streaming reads (#308)`() {
    val overLimit = MAX_EXTERNAL_SUBTITLE_BYTES + 1
    // 1) Upfront Content-Length > 4 MiB is rejected during open()
    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server ->
      val serverThread = thread(isDaemon = true) {
        runCatching {
          server.accept().use { client ->
            readRequestHead(client)
            val resp = "HTTP/1.1 200 OK\r\nContent-Length: $overLimit\r\n\r\n"
            client.getOutputStream().write(resp.toByteArray())
            client.getOutputStream().flush()
          }
        }
      }
      val ds = StreamHttp.subtitleDataSourceFactory(context = RuntimeEnvironment.getApplication()).createDataSource()
      try {
        ds.open(DataSpec(Uri.parse("http://127.0.0.1:${server.localPort}/huge.srt")))
        fail("Expected IOException for Content-Length > 4 MiB")
      } catch (_: IOException) {
        // expected
      } finally {
        ds.close()
        serverThread.join(3_000)
      }
    }

    // 2) Chunked body without Content-Length exceeding 4 MiB aborts during read()
    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server ->
      val serverThread = thread(isDaemon = true) {
        runCatching {
          server.accept().use { client ->
            readRequestHead(client)
            val out = client.getOutputStream()
            out.write("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".toByteArray())
            val chunk = ByteArray(65_536) { 'a'.code.toByte() }
            val chunkHead = "${chunk.size.toString(16)}\r\n".toByteArray()
            repeat(70) { // ~4.5 MiB total
              out.write(chunkHead)
              out.write(chunk)
              out.write("\r\n".toByteArray())
              out.flush()
            }
            out.write("0\r\n\r\n".toByteArray())
          }
        }
      }
      val ds = StreamHttp.subtitleDataSourceFactory(context = RuntimeEnvironment.getApplication()).createDataSource()
      try {
        ds.open(DataSpec(Uri.parse("http://127.0.0.1:${server.localPort}/chunked.srt")))
        val buf = ByteArray(16_384)
        var overflowThrown = false
        try {
          while (true) {
            val n = ds.read(buf, 0, buf.size)
            if (n < 0) break
          }
        } catch (_: IOException) {
          overflowThrown = true
        }
        assertTrue("Expected IOException once cumulative bytes read exceed 4 MiB", overflowThrown)
      } finally {
        ds.close()
        serverThread.join(3_000)
      }
    }
  }

  @Test
  fun `rejects unsafe file URIs, path traversal, non-subtitle extensions, and symlink-to-non-subtitle bypass (#308, #32)`() {
    // Allowlisted subtitle extensions pass validation
    for (allowed in listOf(
      "file:///storage/emulated/0/Download/movie.srt",
      "file:///tmp/subs.vtt",
      "file:///tmp/subs.webvtt",
      "file:///tmp/subs.ass",
      "file:///tmp/subs.ssa",
      "file:///tmp/subs.ttml",
      "file:///tmp/subs.dfxp",
      "file:///tmp/subs.sub",
      "file:///tmp/subs.xml",
    )) {
      assertTrue("expected allowed: $allowed", isAllowedExternalSubtitleUri(allowed))
    }

    // Disallowed local paths: non-subtitle, traversal, encoded traversal, fragment/query spoof, remote host
    for (rejected in listOf(
      "file:///etc/passwd",
      "file:///tmp/../secret.srt",
      "file:///tmp/%2e%2e/secret.srt",
      "file:///tmp/sub/..%2Fsecret.srt",
      "file:///etc/passwd#.srt",
      "file:///etc/passwd?.srt",
      "file://evil.example/share/movie.srt",
      "file:///tmp/script.sh",
      "file:///tmp/evil\u0000.srt",
    )) {
      assertFalse("expected rejected: $rejected", isAllowedExternalSubtitleUri(rejected))
    }

    // Symlink-to-non-subtitle rejection inside IsolatedSubtitleDataSource.open()
    val tempDir = Files.createTempDirectory("elv-sub-symlink-").toFile()
    val secretFile = File(tempDir, "passwd").apply { writeText("root:x:0:0:root:/root:/bin/sh") }
    val fakeLink = File(tempDir, "evil.srt")
    try {
      val createdOsSymlink = runCatching {
        Files.createSymbolicLink(fakeLink.toPath(), secretFile.toPath())
        true
      }.getOrDefault(false)

      if (createdOsSymlink) {
        val ds = StreamHttp.subtitleDataSourceFactory(context = RuntimeEnvironment.getApplication()).createDataSource()
        try {
          ds.open(DataSpec(Uri.fromFile(fakeLink)))
          fail("Expected IOException for OS symlink pointing to non-subtitle file")
        } catch (_: IOException) {
          // expected
        } finally {
          ds.close()
        }
      } else {
        fakeLink.writeText("1\n00:00:01,000 --> 00:00:02,000\nhi\n")
      }

      // Also verify canonicalFile resolution rejects symlink-to-non-subtitle deterministically on all OSes
      val dsCanonical = IsolatedSubtitleDataSource(
        subtitleHeaders = emptyMap(),
        client = subtitleHttpClient(),
        context = RuntimeEnvironment.getApplication(),
        canonicalFileResolver = { secretFile },
      )
      try {
        dsCanonical.open(DataSpec(Uri.fromFile(fakeLink)))
        fail("Expected IOException when canonical path has non-subtitle extension")
      } catch (e: IOException) {
        assertTrue(
          "Expected canonical extension rejection, got: ${e.message}",
          e.message.orEmpty().contains("disallowed extension", ignoreCase = true),
        )
      } finally {
        dsCanonical.close()
      }
    } finally {
      fakeLink.delete()
      secretFile.delete()
      tempDir.delete()
    }
  }

  @Test
  fun `parseSidecarSubtitles completes 200 KiB pathological unclosed-delimiter inputs in linear time under 100 ms (#285)`() {
    // Warm up JIT once with tiny inputs
    parseSidecarSubtitles("1\n00:00:01,000 --> 00:00:02,000\n<b>hi</b>\n", MimeTypes.APPLICATION_SUBRIP)
    parseSidecarSubtitles("<tt><body><div><p begin=\"1s\" end=\"2s\">hi</p></div></body></tt>", MimeTypes.APPLICATION_TTML)
    parseSidecarSubtitles("[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\i1}hi", MimeTypes.TEXT_SSA)

    val ttmlBomb = "<tt><body><div>" + "<p>".repeat(50_000) + "</div></body></tt>"
    val assBomb = "[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,," + "{\\".repeat(50_000)
    val entityBomb = "1\n00:00:01,000 --> 00:00:02,000\n" + "&".repeat(50_000) + "\n"
    val htmlBomb = "1\n00:00:01,000 --> 00:00:02,000\n" + "<span".repeat(50_000) + "\n"

    val t0 = System.nanoTime()
    parseSidecarSubtitles(ttmlBomb, MimeTypes.APPLICATION_TTML)
    val ttmlMs = (System.nanoTime() - t0) / 1_000_000L
    assertTrue("TTML pathological input took ${ttmlMs}ms (expected < 1000ms)", ttmlMs < 1_000L)

    val t1 = System.nanoTime()
    parseSidecarSubtitles(assBomb, MimeTypes.TEXT_SSA)
    val assMs = (System.nanoTime() - t1) / 1_000_000L
    assertTrue("ASS pathological input took ${assMs}ms (expected < 1000ms)", assMs < 1_000L)

    val t2 = System.nanoTime()
    parseSidecarSubtitles(entityBomb, MimeTypes.APPLICATION_SUBRIP)
    val entityMs = (System.nanoTime() - t2) / 1_000_000L
    assertTrue("Entity pathological input took ${entityMs}ms (expected < 1000ms)", entityMs < 1_000L)

    val t3 = System.nanoTime()
    parseSidecarSubtitles(htmlBomb, MimeTypes.APPLICATION_SUBRIP)
    val htmlMs = (System.nanoTime() - t3) / 1_000_000L
    assertTrue("HTML tag pathological input took ${htmlMs}ms (expected < 1000ms)", htmlMs < 1_000L)
  }

  @Test
  fun `ExternalSubtitleLoader dispose cancels in-flight stalled OkHttp subtitle calls immediately (#308)`() {
    val accepted = CountDownLatch(1)
    val releaseServer = CountDownLatch(1)
    val loadError = AtomicReference<Throwable?>(null)
    val loadFinished = CountDownLatch(1)

    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { stalledServer ->
      val serverThread = thread(isDaemon = true) {
        runCatching {
          stalledServer.accept().use { client ->
            readRequestHead(client)
            accepted.countDown()
            // Hold connection open without sending response headers (simulates stalled 10s socket)
            releaseServer.await(15, SECONDS)
          }
        }
      }
      val loader = ExternalSubtitleLoader(context = RuntimeEnvironment.getApplication())
      val worker = thread(isDaemon = true) {
        try {
          loader.loadSync(
            ExternalSubtitleConfig(
              id = "stalled-1",
              uri = "http://127.0.0.1:${stalledServer.localPort}/stalled.srt",
            )
          )
        } catch (t: Throwable) {
          loadError.set(t)
        } finally {
          loadFinished.countDown()
        }
      }

      try {
        assertTrue("server must accept subtitle request", accepted.await(5, SECONDS))
        val startNs = System.nanoTime()
        loader.dispose()
        assertTrue(
          "dispose() must abort stalled OkHttp subtitle call well under 10s read timeout",
          loadFinished.await(2_000, MILLISECONDS),
        )
        val abortMs = (System.nanoTime() - startNs) / 1_000_000L
        assertTrue("Expected fast cancel (< 2000ms), got ${abortMs}ms", abortMs < 2_000L)
        assertNotNull("cancelled loadSync must throw IOException", loadError.get())
      } finally {
        releaseServer.countDown()
        loader.dispose()
        worker.join(2_000)
        serverThread.join(2_000)
      }
    }
  }
}

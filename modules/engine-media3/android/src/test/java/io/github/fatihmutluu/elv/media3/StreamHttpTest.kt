package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit.SECONDS
import kotlin.concurrent.thread
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class StreamHttpTest {
  private val platformAgent = "Dalvik/2.1.0 (Linux; U; Android 16; elv_tv Build/test)"
  private var savedAgent: String? = null

  @Before
  fun setAgent() {
    savedAgent = System.getProperty("http.agent")
    System.setProperty("http.agent", platformAgent)
  }

  @After
  fun restoreAgent() {
    if (savedAgent == null) System.clearProperty("http.agent") else System.setProperty("http.agent", savedAgent!!)
  }

  /** The request head the server received for one request with [headers]; the server then hangs up. */
  private fun requestHead(headers: Map<String, String>): String {
    val heads = LinkedBlockingQueue<String>()
    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { server ->
      val accepter = thread(isDaemon = true) {
        server.accept().use { client ->
          client.soTimeout = 5_000
          val head = StringBuilder()
          val input = client.getInputStream()
          while (!head.endsWith("\r\n\r\n")) {
            val next = input.read()
            if (next < 0) break
            head.append(next.toChar())
          }
          heads.put(head.toString())
        }
      }
      val (source, _) = streamDataSource(headers, engineHttpClient())
      try {
        source.open(DataSpec(Uri.parse("http://127.0.0.1:${server.localPort}/live/demo/demo/1001.ts")))
      } catch (_: IOException) {
      } finally {
        source.close()
      }
      accepter.join(5_000)
    }
    val head = heads.poll(5, SECONDS)
    assertNotNull("no request arrived", head)
    return head!!
  }

  private fun agents(head: String): List<String> =
    head.split("\r\n").filter { it.startsWith("User-Agent:", ignoreCase = true) }.map { it.substringAfter(':').trim() }

  @Test
  fun `a request without its own User-Agent sends the platform's`() {
    assertEquals(listOf(platformAgent), agents(requestHead(mapOf("Referer" to "http://r/"))))
  }

  @Test
  fun `a source's own User-Agent, in any case or duplicated, is sent once and sanitized`() {
    val head = requestHead(
      mapOf(
        "user-agent" to "Provider/1.0\r\nInjected: 1",
        "User-Agent" to "Duplicate/2.0",
        "X-Custom" to "ok\u0000value\nline2",
        "X-Turkish" to "Kanal\u0131",
        "Bad Header Name" to "dropped",
      )
    )
    assertEquals(listOf("Provider/1.0Injected: 1"), agents(head))
    assertFalse(head.contains("okhttp"))
    assertFalse(head.contains("Duplicate/2.0"))
    assertTrue(head.contains("X-Custom: okvalueline2"))
    assertTrue(head.contains("X-Turkish: Kanal"))
    assertFalse(head.contains("Bad Header Name"))
  }

  @Test
  fun `each engine has its own dispatcher over the shared pool and the stream timeouts`() {
    val one = engineHttpClient()
    val two = engineHttpClient()
    assertNotSame(one.dispatcher, two.dispatcher)
    assertEquals(64, one.dispatcher.maxRequests)
    assertEquals(16, one.dispatcher.maxRequestsPerHost)
    assertSame(one.connectionPool, two.connectionPool)
    assertEquals(CONNECT_TIMEOUT_MS.toInt(), one.connectTimeoutMillis)
    assertEquals(READ_TIMEOUT_MS.toInt(), one.readTimeoutMillis)
    assertTrue(one.followSslRedirects)
  }

  @Test
  fun `strips Authorization, Cookie and Proxy-Authorization on cross-origin redirects while keeping same-origin (I1)`() {
    val originHeads = LinkedBlockingQueue<String>()
    val redirectHeads = LinkedBlockingQueue<String>()
    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { target ->
      val targetReader = thread(isDaemon = true) {
        target.accept().use { client ->
          client.soTimeout = 5_000
          val head = StringBuilder()
          val input = client.getInputStream()
          while (!head.endsWith("\r\n\r\n")) {
            val next = input.read()
            if (next < 0) break
            head.append(next.toChar())
          }
          redirectHeads.put(head.toString())
          client.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".toByteArray())
        }
      }
      ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { origin ->
        val originUrl = "http://127.0.0.1:${origin.localPort}/live/demo/demo/1001.ts"
        val redirectUrl = "http://127.0.0.1:${target.localPort}/cdn/segment.ts"
        val originReader = thread(isDaemon = true) {
          origin.accept().use { client ->
            client.soTimeout = 5_000
            val head = StringBuilder()
            val input = client.getInputStream()
            while (!head.endsWith("\r\n\r\n")) {
              val next = input.read()
              if (next < 0) break
              head.append(next.toChar())
            }
            originHeads.put(head.toString())
            val resp = "HTTP/1.1 302 Found\r\nLocation: $redirectUrl\r\nContent-Length: 0\r\n\r\n"
            client.getOutputStream().write(resp.toByteArray())
          }
        }
        val headers = mapOf(
          "Authorization" to "Bearer secret-token",
          "Cookie" to "sid=secret-cookie",
          "Proxy-Authorization" to "Basic c2VjcmV0",
          "X-Api-Key" to "secret-api-key",
          "x-auth-token" to "secret-auth-token",
          "User-Agent" to "Provider/1.0",
        )
        val (source, _) = streamDataSource(headers, engineHttpClient(), originUrl)
        try {
          source.open(DataSpec(Uri.parse(originUrl)))
        } finally {
          source.close()
        }
        originReader.join(5_000)
        targetReader.join(5_000)
      }
    }
    val first = originHeads.poll(5, SECONDS)!!
    val second = redirectHeads.poll(5, SECONDS)!!
    assertTrue(first.contains("Bearer secret-token"))
    assertTrue(first.contains("sid=secret-cookie"))
    assertTrue(first.contains("Basic c2VjcmV0"))
    assertTrue(first.contains("secret-api-key"))
    assertTrue(first.contains("secret-auth-token"))
    assertFalse("Authorization leaked to redirect origin", second.contains("secret-token"))
    assertFalse("Cookie leaked to redirect origin", second.contains("secret-cookie"))
    assertFalse("Proxy-Authorization leaked to redirect origin", second.contains("c2VjcmV0"))
    assertFalse("X-Api-Key leaked to redirect origin", second.contains("secret-api-key"))
    assertFalse("X-Auth-Token leaked to redirect origin", second.contains("secret-auth-token"))
    assertEquals(listOf("Provider/1.0"), agents(second))
  }

  @Test
  fun `strips sensitive headers on cross-origin segment requests and https-to-http downgrades (I1)`() {
    val heads = LinkedBlockingQueue<String>()
    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { cdn ->
      val reader = thread(isDaemon = true) {
        repeat(2) {
          cdn.accept().use { client ->
            client.soTimeout = 5_000
            val head = StringBuilder()
            val input = client.getInputStream()
            while (!head.endsWith("\r\n\r\n")) {
              val next = input.read()
              if (next < 0) break
              head.append(next.toChar())
            }
            heads.put(head.toString())
            client.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".toByteArray())
          }
        }
      }
      val headers = mapOf(
        "authorization" to "Bearer top-secret",
        "cookie" to "auth=1",
        "proxy-authorization" to "Basic abc",
      )
      // 1) Cross-host HLS segment request against provider manifest origin
      val (crossHost, _) = streamDataSource(headers, engineHttpClient(), "http://provider.example:8080/live/1.m3u8")
      try {
        crossHost.open(DataSpec(Uri.parse("http://127.0.0.1:${cdn.localPort}/seg1.ts")))
      } finally {
        crossHost.close()
      }
      // 2) Same host & port number, but https -> http scheme downgrade
      val (downgrade, _) = streamDataSource(headers, engineHttpClient(), "https://127.0.0.1:${cdn.localPort}/live/1.m3u8")
      try {
        downgrade.open(DataSpec(Uri.parse("http://127.0.0.1:${cdn.localPort}/seg1.ts")))
      } finally {
        downgrade.close()
      }
      reader.join(5_000)
    }
    repeat(2) {
      val head = heads.poll(5, SECONDS)!!
      assertFalse(head.lowercase().contains("authorization:"))
      assertFalse(head.lowercase().contains("cookie:"))
    }
  }
}

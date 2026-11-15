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
  fun `a source's own User-Agent, in any case, is sent once instead`() {
    val head = requestHead(mapOf("user-agent" to "Provider/1.0"))
    assertEquals(listOf("Provider/1.0"), agents(head))
    assertFalse(head.contains("okhttp"))
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
}

package io.github.fatihmutluu.elv.lanpairing

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.BufferedReader
import java.io.InputStreamReader
import java.net.InetAddress
import java.net.Socket
import java.nio.charset.StandardCharsets
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class LanPairingHttpServerTest {
  private val token = "a".repeat(32)
  private val html = "<!DOCTYPE html><html><body>Pair Form</body></html>"
  private var activeServer: LanPairingHttpServer? = null

  @After
  fun tearDown() {
    activeServer?.stop()
    activeServer = null
  }

  private data class RawHttpResponse(
    val statusCode: Int,
    val headers: Map<String, String>,
    val body: String,
  )

  private fun sendRawRequest(port: Int, rawRequest: String): RawHttpResponse {
    Socket("127.0.0.1", port).use { socket ->
      socket.soTimeout = 3_000
      val out = socket.getOutputStream()
      out.write(rawRequest.toByteArray(StandardCharsets.UTF_8))
      out.flush()

      val reader = BufferedReader(InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))
      val statusLine = reader.readLine() ?: error("Empty HTTP response")
      val statusCode = statusLine.split(" ")[1].toInt()
      val headers = LinkedHashMap<String, String>()
      while (true) {
        val line = reader.readLine() ?: break
        if (line.isEmpty()) break
        val idx = line.indexOf(':')
        if (idx > 0) {
          headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
        }
      }
      val body = reader.readText()
      return RawHttpResponse(statusCode, headers, body)
    }
  }

  @Test
  fun getReturnsHtmlWithNoStoreAndNosniffHeaders() {
    val server = LanPairingHttpServer(
      token = token,
      html = html,
      ttlMs = 30_000,
      bindAddress = InetAddress.getLoopbackAddress(),
      advertisedHost = "127.0.0.1",
      onSubmission = { _, _ -> },
    )
    activeServer = server
    val info = server.start()

    val res = sendRawRequest(
      info.port,
      "GET /pair/$token HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\nConnection: close\r\n\r\n",
    )

    assertEquals(200, res.statusCode)
    assertEquals("no-store", res.headers["cache-control"])
    assertEquals("nosniff", res.headers["x-content-type-options"])
    assertEquals(html, res.body)
    assertTrue(server.isRunning)
  }

  @Test
  fun invalidTokenReturns404AndLocksOutAfterFiveAttempts() {
    val server = LanPairingHttpServer(
      token = token,
      html = html,
      ttlMs = 30_000,
      maxFailedAttempts = 5,
      bindAddress = InetAddress.getLoopbackAddress(),
      advertisedHost = "127.0.0.1",
      onSubmission = { _, _ -> },
    )
    activeServer = server
    val info = server.start()

    for (attempt in 1..5) {
      val res = sendRawRequest(
        info.port,
        "GET /pair/deadbeefdeadbeefdeadbeefdeadbeef HTTP/1.1\r\nHost: 127.0.0.1:${info.port}\r\nConnection: close\r\n\r\n",
      )
      assertEquals("Attempt $attempt should return 404", 404, res.statusCode)
      assertEquals("no-store", res.headers["cache-control"])
    }

    assertFalse("Server must close immediately on 5th failed attempt", server.isRunning)
  }

  @Test
  fun rejectsWrongHostAndCrossOriginPosts() {
    val submitted = AtomicReference<String?>(null)
    val server = LanPairingHttpServer(
      token = token,
      html = html,
      ttlMs = 30_000,
      bindAddress = InetAddress.getLoopbackAddress(),
      advertisedHost = "127.0.0.1",
      onSubmission = { body, _ -> submitted.set(body) },
    )
    activeServer = server
    val info = server.start()

    val badHost = sendRawRequest(
      info.port,
      "GET /pair/$token HTTP/1.1\r\nHost: evil.example:${info.port}\r\nConnection: close\r\n\r\n",
    )
    assertEquals(403, badHost.statusCode)

    val payload = """{"kind":"m3u","url":"https://example.com/list.m3u"}"""
    val badOrigin = sendRawRequest(
      info.port,
      "POST /pair/$token HTTP/1.1\r\n" +
        "Host: 127.0.0.1:${info.port}\r\n" +
        "Origin: https://evil.example\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: ${payload.toByteArray().size}\r\n" +
        "Connection: close\r\n\r\n$payload",
    )
    assertEquals(403, badOrigin.statusCode)
    assertNull(submitted.get())
  }

  @Test
  fun oversizedBodyReturns413WithoutEmittingSubmission() {
    val submitted = AtomicReference<String?>(null)
    val server = LanPairingHttpServer(
      token = token,
      html = html,
      ttlMs = 30_000,
      maxBodyBytes = 256,
      bindAddress = InetAddress.getLoopbackAddress(),
      advertisedHost = "127.0.0.1",
      onSubmission = { body, _ -> submitted.set(body) },
    )
    activeServer = server
    val info = server.start()

    val bigBody = "a".repeat(512)
    val res = sendRawRequest(
      info.port,
      "POST /pair/$token HTTP/1.1\r\n" +
        "Host: 127.0.0.1:${info.port}\r\n" +
        "Origin: http://127.0.0.1:${info.port}\r\n" +
        "Content-Type: application/json\r\n" +
        "Content-Length: ${bigBody.length}\r\n" +
        "Connection: close\r\n\r\n$bigBody",
    )

    assertEquals(413, res.statusCode)
    assertNull(submitted.get())
    assertTrue(server.isRunning)
  }

  @Test
  fun validPostEmitsBodyAndShutsDownServerImmediately() {
    val latch = CountDownLatch(1)
    val receivedBody = AtomicReference<String?>(null)
    val receivedType = AtomicReference<String?>(null)
    val server = LanPairingHttpServer(
      token = token,
      html = html,
      ttlMs = 30_000,
      bindAddress = InetAddress.getLoopbackAddress(),
      advertisedHost = "127.0.0.1",
      onSubmission = { body, contentType ->
        receivedBody.set(body)
        receivedType.set(contentType)
        latch.countDown()
      },
    )
    activeServer = server
    val info = server.start()

    val payload = """{"kind":"m3u","name":"TV","url":"https://example.com/list.m3u"}"""
    val res = sendRawRequest(
      info.port,
      "POST /pair/$token HTTP/1.1\r\n" +
        "Host: 127.0.0.1:${info.port}\r\n" +
        "Origin: http://127.0.0.1:${info.port}\r\n" +
        "Content-Type: application/json; charset=utf-8\r\n" +
        "Content-Length: ${payload.toByteArray(StandardCharsets.UTF_8).size}\r\n" +
        "Connection: close\r\n\r\n$payload",
    )

    assertEquals(200, res.statusCode)
    assertEquals("no-store", res.headers["cache-control"])
    assertTrue("Submission callback should fire", latch.await(2, TimeUnit.SECONDS))
    assertEquals(payload, receivedBody.get())
    assertEquals("application/json; charset=utf-8", receivedType.get())

    // Wait briefly for server.stop() to finish in finally block.
    val deadline = System.currentTimeMillis() + 1_000
    while (server.isRunning && System.currentTimeMillis() < deadline) {
      Thread.sleep(10)
    }
    assertFalse("Server must shut down immediately after first valid POST", server.isRunning)
  }

  @Test
  fun privateLanAddressValidationMatchesProtocolRules() {
    assertTrue(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("10.0.0.1")))
    assertTrue(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("172.16.0.1")))
    assertTrue(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("172.31.255.254")))
    assertTrue(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("192.168.1.10")))
    assertTrue(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("127.0.0.1")))
    assertTrue(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("::1")))
    assertTrue(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("fc00::1")))
    assertTrue(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("fd12::1")))
    assertTrue(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("fe80::1")))

    assertFalse(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("8.8.8.8")))
    assertFalse(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("172.15.0.1")))
    assertFalse(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("172.32.0.1")))
    assertFalse(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("100.64.0.1")))
    assertFalse(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("169.254.169.254")))
    assertFalse(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("224.0.0.1")))
    assertFalse(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("2001:db8::1")))
    assertFalse(LanPairingHttpServer.isPrivateLanAddress(InetAddress.getByName("ff02::1")))

    assertNotNull(LanPairingHttpServer.constantTimeEquals("abc", "abc"))
    assertTrue(LanPairingHttpServer.constantTimeEquals(token, token))
    assertFalse(LanPairingHttpServer.constantTimeEquals(token, token.dropLast(1) + "0"))
    assertFalse(LanPairingHttpServer.constantTimeEquals("abc", "abcd"))
  }
}

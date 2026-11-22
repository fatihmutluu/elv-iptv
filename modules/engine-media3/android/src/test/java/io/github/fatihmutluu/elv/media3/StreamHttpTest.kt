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
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
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
    assertEquals(WRITE_TIMEOUT_MS.toInt(), one.writeTimeoutMillis)
    assertEquals(10_000L, WRITE_TIMEOUT_MS)
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

  @Test
  fun `OriginCookieJar enforces exact origin, path matching, Secure guard, Max-Age precedence, and bounded eviction (#171)`() {
    var clock = 1_790_812_800_000L // 2026-10-01T00:00:00Z
    val jar = OriginCookieJar(maxCookies = 3, nowMs = { clock })

    // Domain widening ignored; default path -> /live/hd; Secure enforced
    jar.store(
      "https://panel.example:443/live/hd/index.m3u8".toHttpUrl(),
      listOf(
        "sid=abc; Domain=.example; Path=/; Secure",
        "hd=1",
        "exp=ok; Path=/live; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      ),
    )

    assertEquals("hd=1; exp=ok; sid=abc", jar.headerFor("https://panel.example/live/hd/seg1.ts".toHttpUrl()))
    assertEquals("exp=ok; sid=abc", jar.headerFor("https://panel.example/live/sd/seg1.ts".toHttpUrl()))
    assertEquals("sid=abc", jar.headerFor("https://panel.example/live2/seg1.ts".toHttpUrl()))

    // Cross-origin & http downgrade NEVER echo
    assertNull(jar.headerFor("https://cdn.panel.example/live/hd/seg1.ts".toHttpUrl()))
    assertNull(jar.headerFor("https://panel.example:8443/live/hd/seg1.ts".toHttpUrl()))
    assertNull(jar.headerFor("http://panel.example/live/hd/seg1.ts".toHttpUrl()))

    // Secure cookie stored on http:// is NEVER echoed on http://
    val httpJar = OriginCookieJar(nowMs = { clock })
    httpJar.store(
      "http://panel.example/live/1".toHttpUrl(),
      listOf("bad=1; Path=/; Secure", "plain=yes; Path=/"),
    )
    assertEquals("plain=yes", httpJar.headerFor("http://panel.example/live/2".toHttpUrl()))

    // Bounded cap evicts oldest (sid was first; adding extra evicts sid)
    jar.store("https://panel.example/live/hd/index.m3u8".toHttpUrl(), listOf("extra=4; Path=/"))
    assertEquals(3, jar.size())
    assertEquals("hd=1; exp=ok; extra=4", jar.headerFor("https://panel.example/live/hd/seg1.ts".toHttpUrl()))

    // Max-Age=0 deletes immediately even with future Expires
    jar.store(
      "https://panel.example/live/hd/index.m3u8".toHttpUrl(),
      listOf("exp=gone; Path=/live; Max-Age=0; Expires=Wed, 21 Oct 2030 07:28:00 GMT"),
    )
    assertEquals("hd=1; extra=4", jar.headerFor("https://panel.example/live/hd/seg1.ts".toHttpUrl()))

    // Past Expires and advancing past expiry drops cookies
    val expJar = OriginCookieJar(nowMs = { clock })
    expJar.store(
      "https://panel.example/a".toHttpUrl(),
      listOf("imf=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT"),
    )
    assertEquals("imf=1", expJar.headerFor("https://panel.example/a".toHttpUrl()))
    clock = parseHttpDateMs("Wed, 21 Oct 2026 07:28:00 GMT")!!
    assertNull(expJar.headerFor("https://panel.example/a".toHttpUrl()))
  }

  @Test
  fun `echoes 302 Set-Cookie on matching-origin redirects and segments while never leaking cross-origin or Secure over http (#171)`() {
    val originHeads = LinkedBlockingQueue<String>()
    val cdnHeads = LinkedBlockingQueue<String>()

    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { cdn ->
      ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { origin ->
        val originBase = "http://127.0.0.1:${origin.localPort}"
        val cdnBase = "http://127.0.0.1:${cdn.localPort}"

        val originServer = thread(isDaemon = true) {
          // 1) /live/start -> 302 with Set-Cookie to same-origin /live/playlist.m3u8
          // 2) /live/playlist.m3u8 -> 200 OK
          // 3) /live/seg1.ts -> 200 OK (separate DataSource open on same engineHttpClient)
          repeat(3) { idx ->
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
              val resp = if (idx == 0) {
                "HTTP/1.1 302 Found\r\n" +
                  "Location: $originBase/live/playlist.m3u8\r\n" +
                  "Set-Cookie: tok=edge123; Path=/live\r\n" +
                  "Set-Cookie: sec=secret; Path=/; Secure\r\n" +
                  "Content-Length: 0\r\n\r\n"
              } else {
                "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
              }
              client.getOutputStream().write(resp.toByteArray())
            }
          }
        }

        val cdnServer = thread(isDaemon = true) {
          cdn.accept().use { client ->
            client.soTimeout = 5_000
            val head = StringBuilder()
            val input = client.getInputStream()
            while (!head.endsWith("\r\n\r\n")) {
              val next = input.read()
              if (next < 0) break
              head.append(next.toChar())
            }
            cdnHeads.put(head.toString())
            client.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".toByteArray())
          }
        }

        val client = engineHttpClient()
        val (manifestSource, _) = streamDataSource(emptyMap(), client, "$originBase/live/start")
        try {
          manifestSource.open(DataSpec(Uri.parse("$originBase/live/start")))
        } finally {
          manifestSource.close()
        }

        // Subsequent segment on same origin receives tok=edge123, never sec=secret
        val (segSource, _) = streamDataSource(emptyMap(), client, "$originBase/live/start")
        try {
          segSource.open(DataSpec(Uri.parse("$originBase/live/seg1.ts")))
        } finally {
          segSource.close()
        }

        // Cross-origin CDN segment on same client NEVER receives origin's tok=edge123
        val (cdnSource, _) = streamDataSource(emptyMap(), client, "$originBase/live/start")
        try {
          cdnSource.open(DataSpec(Uri.parse("$cdnBase/live/seg1.ts")))
        } finally {
          cdnSource.close()
        }

        originServer.join(5_000)
        cdnServer.join(5_000)
      }
    }

    originHeads.poll(5, SECONDS)!! // initial /live/start
    val redirectHead = originHeads.poll(5, SECONDS)!!
    val segmentHead = originHeads.poll(5, SECONDS)!!
    val cdnHead = cdnHeads.poll(5, SECONDS)!!

    assertTrue("Expected tok=edge123 on redirect hop: $redirectHead", redirectHead.contains("tok=edge123"))
    assertFalse("Secure cookie leaked over http on redirect: $redirectHead", redirectHead.contains("sec=secret"))
    assertTrue("Expected tok=edge123 on same-origin segment: $segmentHead", segmentHead.contains("tok=edge123"))
    assertFalse("Secure cookie leaked over http on segment: $segmentHead", segmentHead.contains("sec=secret"))
    assertFalse("Origin cookie leaked cross-origin to CDN: $cdnHead", cdnHead.contains("tok=edge123"))
  }

  @Test
  fun `clamps huge and over-64-bit Max-Age values without signed Long overflow (#171)`() {
    val clock = 1_790_812_800_000L
    val jar = OriginCookieJar(nowMs = { clock })
    val url = "https://panel.example/live/1".toHttpUrl()
    jar.store(
      url,
      listOf(
        "longmax=ok; Path=/; Max-Age=${Long.MAX_VALUE}",
        "over64=ok; Path=/; Max-Age=999999999999999999999999999999",
        "negover64=drop; Path=/; Max-Age=-999999999999999999999999999999",
      ),
    )
    assertEquals("longmax=ok; over64=ok", jar.headerFor(url))
  }

  @Test
  fun `multi-hop redirects prevent cross-origin bounce, path escape, Max-Age=0 carry-over, and Secure downgrade leaks (#171)`() {
    val originHeads = LinkedBlockingQueue<String>()
    val cdnHeads = LinkedBlockingQueue<String>()

    ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { cdn ->
      ServerSocket(0, 50, InetAddress.getLoopbackAddress()).use { origin ->
        val originBase = "http://127.0.0.1:${origin.localPort}"
        val cdnBase = "http://127.0.0.1:${cdn.localPort}"

        val originServer = thread(isDaemon = true) {
          // 1) /secret/start -> 302 Set-Cookie(sec_p=1; Path=/secret), Set-Cookie(del=1; Path=/) -> /secret/step2
          // 2) /secret/step2 -> 302 Set-Cookie(del=; Path=/; Max-Age=0) -> /public/step3
          // 3) /public/step3 -> 302 -> cdn/hop1
          // 4) /final (bounce back from cdn/hop2) -> 200 OK
          repeat(4) { idx ->
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
              val resp = when (idx) {
                0 -> "HTTP/1.1 302 Found\r\n" +
                  "Location: $originBase/secret/step2\r\n" +
                  "Set-Cookie: sec_p=1; Path=/secret\r\n" +
                  "Set-Cookie: del=1; Path=/\r\n" +
                  "Content-Length: 0\r\n\r\n"
                1 -> "HTTP/1.1 302 Found\r\n" +
                  "Location: $originBase/public/step3\r\n" +
                  "Set-Cookie: del=; Path=/; Max-Age=0\r\n" +
                  "Content-Length: 0\r\n\r\n"
                2 -> "HTTP/1.1 302 Found\r\nLocation: $cdnBase/hop1\r\nContent-Length: 0\r\n\r\n"
                else -> "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
              }
              client.getOutputStream().write(resp.toByteArray())
            }
          }
        }

        val cdnServer = thread(isDaemon = true) {
          // 1) /hop1 -> 302 Set-Cookie(cdn_tok=99; Path=/) -> /hop2
          // 2) /hop2 -> 302 -> origin/final (cross-origin bounce back to A!)
          repeat(2) { idx ->
            cdn.accept().use { client ->
              client.soTimeout = 5_000
              val head = StringBuilder()
              val input = client.getInputStream()
              while (!head.endsWith("\r\n\r\n")) {
                val next = input.read()
                if (next < 0) break
                head.append(next.toChar())
              }
              cdnHeads.put(head.toString())
              val resp = if (idx == 0) {
                "HTTP/1.1 302 Found\r\n" +
                  "Location: $cdnBase/hop2\r\n" +
                  "Set-Cookie: cdn_tok=99; Path=/\r\n" +
                  "Content-Length: 0\r\n\r\n"
              } else {
                "HTTP/1.1 302 Found\r\nLocation: $originBase/final\r\nContent-Length: 0\r\n\r\n"
              }
              client.getOutputStream().write(resp.toByteArray())
            }
          }
        }

        val client = engineHttpClient()
        val headers = mapOf("Authorization" to "Bearer secret-auth", "Cookie" to "caller=keep")
        val (source, _) = streamDataSource(headers, client, "$originBase/secret/start")
        try {
          source.open(DataSpec(Uri.parse("$originBase/secret/start")))
        } finally {
          source.close()
        }
        originServer.join(5_000)
        cdnServer.join(5_000)
      }
    }

    originHeads.poll(5, SECONDS)!! // /secret/start
    val secretStep2 = originHeads.poll(5, SECONDS)!!
    val publicStep3 = originHeads.poll(5, SECONDS)!!
    val bounceFinal = originHeads.poll(5, SECONDS)!!
    val cdnHop1 = cdnHeads.poll(5, SECONDS)!!
    val cdnHop2 = cdnHeads.poll(5, SECONDS)!!

    // /secret/step2 has caller=keep + sec_p=1 + del=1
    assertTrue(secretStep2.contains("caller=keep"))
    assertTrue(secretStep2.contains("sec_p=1"))
    assertTrue(secretStep2.contains("del=1"))
    // /public/step3: sec_p=1 (Path=/secret) does NOT escape; del=1 (Max-Age=0) is GONE; caller=keep preserved
    assertTrue(publicStep3.contains("caller=keep"))
    assertFalse("Path=/secret cookie escaped to /public: $publicStep3", publicStep3.contains("sec_p=1"))
    assertFalse("Max-Age=0 deleted cookie carried over: $publicStep3", publicStep3.contains("del=1"))
    // cdn/hop1: stripped caller auth & cookies
    assertFalse(cdnHop1.contains("secret-auth"))
    assertFalse(cdnHop1.contains("caller=keep"))
    // cdn/hop2: carries ONLY cdn_tok=99
    assertTrue(cdnHop2.contains("cdn_tok=99"))
    assertFalse(cdnHop2.contains("caller=keep"))
    // origin/final (bounce A -> B -> B -> A): cdn_tok=99 NEVER leaks to A, caller creds/cookie stay stripped!
    assertFalse("CDN jar cookie leaked on bounce-back to A: $bounceFinal", bounceFinal.contains("cdn_tok=99"))
    assertFalse("Caller Authorization restored on bounce-back: $bounceFinal", bounceFinal.contains("secret-auth"))
    assertFalse("Caller Cookie restored on bounce-back: $bounceFinal", bounceFinal.contains("caller=keep"))

    // Secure downgrade chain: http://A -> https://A -> https://A -> http://A via scopeHopRequest
    val jar = OriginCookieJar()
    val httpOrigin = StreamOrigin("http://panel.example/start".toHttpUrl())
    val state = CallRedirectState(httpOrigin, "caller=1")
    jar.store("https://panel.example/s1".toHttpUrl(), listOf("sec=topsecret; Path=/; Secure"))
    val httpsHop = scopeHopRequest(
      Request.Builder().url("https://panel.example/s2").header("Cookie", "caller=1").build(),
      state,
      jar,
    )
    assertEquals("sec=topsecret", httpsHop.header("Cookie"))
    // Simulate OkHttp carrying Cookie: sec=topsecret onto the downgrade redirect back to http://panel.example/end
    val downgradeHop = scopeHopRequest(
      httpsHop.newBuilder().url("http://panel.example/end").build(),
      state,
      jar,
    )
    assertNull("Secure cookie leaked on https->http downgrade", downgradeHop.header("Cookie"))
  }
}

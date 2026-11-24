package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSpec
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.ServerSocket
import java.net.UnknownHostException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit.SECONDS
import kotlin.concurrent.thread
import okhttp3.ConnectionSpec
import okhttp3.Dns
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class ScopedDnsTest {
  private val ipv4 = InetAddress.getByName("203.0.113.10")
  private val ipv4Alt = InetAddress.getByName("203.0.113.20")
  private val ipv6 = InetAddress.getByName("2001:db8::1")
  private val ipv6Alt = InetAddress.getByName("2001:db8::2")
  private val ipv4Loopback = InetAddress.getByName("127.0.0.1")

  private fun fakeDns(lookupFn: (String) -> List<InetAddress>): Dns = object : Dns {
    override fun lookup(hostname: String): List<InetAddress> = lookupFn(hostname)
  }

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
  fun `ScopedDns filters IPv4 and IPv6 addresses and throws UnknownHostException when requested family is absent (#172)`() {
    val dualDelegate = fakeDns { listOf(ipv4, ipv6, ipv4Alt, ipv6Alt) }
    val ipv6OnlyDelegate = fakeDns { listOf(ipv6) }
    val ipv4OnlyDelegate = fakeDns { listOf(ipv4) }

    val systemDns = ScopedDns(delegate = dualDelegate, dnsFamily = DnsFamilyPreference.SYSTEM)
    assertEquals(listOf(ipv4, ipv6, ipv4Alt, ipv6Alt), systemDns.lookup("stream.provider.test"))

    val ipv4Dns = ScopedDns(delegate = dualDelegate, dnsFamily = DnsFamilyPreference.IPV4)
    val v4Results = ipv4Dns.lookup("stream.provider.test")
    assertEquals(listOf(ipv4, ipv4Alt), v4Results)
    assertTrue(v4Results.all { it is Inet4Address })

    val ipv6Dns = ScopedDns(delegate = dualDelegate, dnsFamily = DnsFamilyPreference.IPV6)
    val v6Results = ipv6Dns.lookup("stream.provider.test")
    assertEquals(listOf(ipv6, ipv6Alt), v6Results)
    assertTrue(v6Results.all { it is Inet6Address })

    try {
      ScopedDns(delegate = ipv6OnlyDelegate, dnsFamily = DnsFamilyPreference.IPV4).lookup("v6only.provider.test")
      fail("Expected UnknownHostException when IPv4 address is absent")
    } catch (e: UnknownHostException) {
      assertTrue(e.message.orEmpty().contains("No IPv4 addresses for v6only.provider.test"))
    }

    try {
      ScopedDns(delegate = ipv4OnlyDelegate, dnsFamily = DnsFamilyPreference.IPV6).lookup("v4only.provider.test")
      fail("Expected UnknownHostException when IPv6 address is absent")
    } catch (e: UnknownHostException) {
      assertTrue(e.message.orEmpty().contains("No IPv6 addresses for v4only.provider.test"))
    }
  }

  @Test
  fun `ScopedDns applies literal hostOverride strictly to overrideTargetHost and delegates cross-origin hosts (#172)`() {
    val delegatedHosts = mutableListOf<String>()
    val delegate = fakeDns { hostname ->
      delegatedHosts += hostname
      listOf(ipv4Alt, ipv6Alt)
    }

    val v4Scoped = ScopedDns(
      delegate = delegate,
      dnsFamily = DnsFamilyPreference.IPV6,
      hostOverride = "203.0.113.10",
      overrideTargetHost = "stream.provider.test",
    )
    // Exact host (case-insensitive) gets hostOverride without touching delegate
    assertEquals(listOf(ipv4), v4Scoped.lookup("stream.provider.test"))
    assertEquals(listOf(ipv4), v4Scoped.lookup("STREAM.PROVIDER.TEST"))
    assertTrue("delegate must not be called for overridden target host", delegatedHosts.isEmpty())

    // Cross-origin redirect host delegates to real DNS and honors dnsFamily (IPV6)
    assertEquals(listOf(ipv6Alt), v4Scoped.lookup("cdn.other.test"))
    assertEquals(listOf("cdn.other.test"), delegatedHosts)

    // IPv6 override (bracketed uppercase input) normalizes cleanly
    val v6Scoped = ScopedDns(
      delegate = delegate,
      dnsFamily = DnsFamilyPreference.SYSTEM,
      hostOverride = "[2001:DB8::1]",
      overrideTargetHost = "stream.provider.test",
    )
    assertEquals(listOf(ipv6), v6Scoped.lookup("stream.provider.test"))

    // Malformed non-IP override passed directly to ScopedDns is ignored safely (falls back to delegate)
    val malformedScoped = ScopedDns(
      delegate = delegate,
      dnsFamily = DnsFamilyPreference.IPV4,
      hostOverride = "evil.redirect.test",
      overrideTargetHost = "stream.provider.test",
    )
    assertEquals(listOf(ipv4Alt), malformedScoped.lookup("stream.provider.test"))
    assertEquals(listOf("cdn.other.test", "stream.provider.test"), delegatedHosts)
  }

  @Test
  fun `networkScopedClient shares base pool, dispatcher, TLS verifier, and avoids derivation on defaults (#172)`() {
    val base = engineHttpClient()

    assertSame(
      base,
      networkScopedClient(
        base = base,
        allowLegacyTls = false,
        dnsFamily = DnsFamilyPreference.SYSTEM,
        hostOverride = null,
        initialUrl = "https://stream.provider.test/live/1.ts",
      ),
    )

    // Invalid hostOverride with default TLS/DNS also returns base without deriving
    assertSame(
      base,
      networkScopedClient(
        base = base,
        allowLegacyTls = false,
        dnsFamily = DnsFamilyPreference.SYSTEM,
        hostOverride = "not-an-ip.test",
        initialUrl = "https://stream.provider.test/live/1.ts",
      ),
    )

    val combined = networkScopedClient(
      base = base,
      allowLegacyTls = true,
      dnsFamily = DnsFamilyPreference.IPV4,
      hostOverride = "203.0.113.10",
      initialUrl = "https://stream.provider.test:8443/live/1.ts",
    )
    assertNotSame(base, combined)
    assertEquals(listOf(ConnectionSpec.MODERN_TLS, ConnectionSpec.CLEARTEXT), base.connectionSpecs)
    assertEquals(listOf(ConnectionSpec.COMPATIBLE_TLS, ConnectionSpec.CLEARTEXT), combined.connectionSpecs)
    assertSame(base.connectionPool, combined.connectionPool)
    assertSame(base.dispatcher, combined.dispatcher)
    assertSame(base.hostnameVerifier, combined.hostnameVerifier)
    assertSame(base.sslSocketFactory, combined.sslSocketFactory)
    assertEquals(base.interceptors, combined.interceptors)
    assertEquals(base.networkInterceptors, combined.networkInterceptors)
    assertTrue(combined.dns is ScopedDns)
    assertEquals(listOf(ipv4), combined.dns.lookup("stream.provider.test"))
  }

  @Test
  fun `networkScopedClient routes origin via hostOverride with original Host header and delegates cross-origin redirects (#172)`() {
    val originHeads = LinkedBlockingQueue<String>()
    val redirectHeads = LinkedBlockingQueue<String>()
    val delegateLookups = LinkedBlockingQueue<String>()

    ServerSocket(0, 50, ipv4Loopback).use { redirectServer ->
      ServerSocket(0, 50, ipv4Loopback).use { originServer ->
        val originUrl = "http://stream.provider.test:${originServer.localPort}/live/1.ts"
        val redirectUrl = "http://cdn.other.test:${redirectServer.localPort}/seg.ts"

        val originThread = thread(isDaemon = true) {
          originServer.accept().use { client ->
            originHeads.put(readRequestHead(client))
            val resp = "HTTP/1.1 302 Found\r\nLocation: $redirectUrl\r\nContent-Length: 0\r\n\r\n"
            client.getOutputStream().write(resp.toByteArray())
          }
        }
        val redirectThread = thread(isDaemon = true) {
          redirectServer.accept().use { client ->
            redirectHeads.put(readRequestHead(client))
            client.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".toByteArray())
          }
        }

        val baseWithFakeDns = engineHttpClient().newBuilder()
          .dns(
            fakeDns { hostname ->
              delegateLookups.put(hostname)
              listOf(ipv4Loopback)
            }
          )
          .build()

        val scopedClient = networkScopedClient(
          base = baseWithFakeDns,
          allowLegacyTls = false,
          dnsFamily = DnsFamilyPreference.IPV4,
          hostOverride = "127.0.0.1",
          initialUrl = originUrl,
        )

        val (source, _) = streamDataSource(emptyMap(), scopedClient, originUrl)
        try {
          source.open(DataSpec(Uri.parse(originUrl)))
        } finally {
          source.close()
        }

        originThread.join(5_000)
        redirectThread.join(5_000)

        val firstHead = originHeads.poll(5, SECONDS)!!
        val secondHead = redirectHeads.poll(5, SECONDS)!!

        assertTrue(
          "Origin request must preserve original Host header: $firstHead",
          firstHead.contains("Host: stream.provider.test:${originServer.localPort}"),
        )
        assertTrue(
          "Redirect request must send redirect Host header: $secondHead",
          secondHead.contains("Host: cdn.other.test:${redirectServer.localPort}"),
        )
        // Delegate DNS was called ONLY for the cross-origin redirect host, NOT for the overridden origin host!
        assertEquals(listOf("cdn.other.test"), delegateLookups.toList())
      }
    }
  }

  @Test
  fun `Media3Engine wires networkScopedClient so hostOverride connects to loopback while keeping original Host header (#172)`() {
    val arrived = CountDownLatch(1)
    val receivedHead = LinkedBlockingQueue<String>()

    ServerSocket(0, 50, ipv4Loopback).use { server ->
      val serverThread = thread(isDaemon = true) {
        runCatching {
          server.accept().use { client ->
            receivedHead.put(readRequestHead(client))
            arrived.countDown()
            client.getOutputStream().write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".toByteArray())
          }
        }
      }

      val engine = Media3Engine(RuntimeEnvironment.getApplication())
      try {
        engine.load(
          1,
          LoadRequest(
            url = "http://stream.provider.test:${server.localPort}/live/1.ts",
            headers = emptyMap(),
            live = true,
            startMs = null,
            softwareAudio = false,
            dnsFamily = DnsFamilyPreference.IPV4,
            hostOverride = "127.0.0.1",
          ),
        )
        assertTrue("Media3Engine must reach loopback via hostOverride", arrived.await(5, SECONDS))
        val head = receivedHead.poll(5, SECONDS)!!
        assertTrue(
          "Expected original Host header stream.provider.test, got: $head",
          head.contains("Host: stream.provider.test:${server.localPort}"),
        )
        assertFalse(head.contains("127.0.0.1"))
      } finally {
        engine.dispose()
        serverThread.join(5_000)
      }
    }
  }
}

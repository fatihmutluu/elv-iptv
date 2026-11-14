package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.Executors
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeUnit.SECONDS
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The media boundary over real sockets and the engine's own HTTP data sources: a server that accepts, reads the
 * request and never answers (a provider that is slow to start a stream).
 */
@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class MediaBoundaryTest {
  /** One accepted request: when it arrived and how many earlier connections were still open at that moment. */
  private data class Accepted(val atNs: Long, val othersOpen: Int)

  private class WithholdingServer : AutoCloseable {
    private val server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
    private val clients = mutableListOf<Socket>()
    val accepted = LinkedBlockingQueue<Accepted>()
    private val loop = thread(name = "withholding-server") {
      try {
        while (true) {
          val client = server.accept()
          readHead(client)
          val atNs = System.nanoTime()
          accepted.put(Accepted(atNs, clients.count(::isOpen)))
          clients += client
        }
      } catch (_: IOException) {
      }
    }

    fun url(path: String) = "http://127.0.0.1:${server.localPort}/live/demo/demo/$path"

    private fun readHead(client: Socket) {
      client.soTimeout = 5_000
      val input = client.getInputStream()
      var tail = 0
      while (tail != 0x0d0a0d0a) {
        val next = input.read()
        if (next < 0) return
        tail = (tail shl 8) or next
      }
    }

    /** A FIN or reset the client sent is already queued here, so a closed connection answers at once. */
    private fun isOpen(client: Socket): Boolean =
      try {
        client.soTimeout = 300
        client.getInputStream().read() >= 0
      } catch (_: SocketTimeoutException) {
        true
      } catch (_: IOException) {
        false
      }

    override fun close() {
      server.close()
      clients.forEach { it.close() }
      loop.join(5_000)
    }
  }

  private val client = engineHttpClient()

  private fun request(url: String) =
    LoadRequest(url = url, headers = emptyMap(), live = true, startMs = null, softwareAudio = false)

  /** What a Media3 loader does with one request: open it, then close it whatever happened. */
  private fun load(source: DataSource, url: String) {
    try {
      source.open(DataSpec(Uri.parse(url)))
    } catch (_: IOException) {
    } finally {
      source.close()
    }
  }

  @Test
  fun `a superseded request still waiting for its answer is closed before the next media's request arrives`() {
    WithholdingServer().use { server ->
      val gate = ConnectionGate(Executors.newSingleThreadExecutor())
      gate.beginMedia(1)
      val slow = server.url("1001.ts")
      val first = thread { load(requestSources(request(slow), gate, 1, client)(RequestKind.PROGRESSIVE), slow) }
      assertNotNull("the first request never arrived", server.accepted.poll(5, SECONDS))

      val begun = System.nanoTime()
      gate.beginMedia(2)
      val next = server.url("1002.ts")
      val second = thread { load(requestSources(request(next), gate, 2, client)(RequestKind.PROGRESSIVE), next) }
      val arrived = server.accepted.poll(15, SECONDS)
      assertNotNull("the next media's request never arrived", arrived)
      val afterMs = TimeUnit.NANOSECONDS.toMillis(arrived!!.atNs - begun)
      assertEquals("connections still open when the next media's request arrived", 0, arrived.othersOpen)
      assertTrue("the next request came $afterMs ms after the new media, not at once", afterMs < 900)

      gate.beginMedia(3)
      first.join(10_000)
      second.join(10_000)
    }
  }
}

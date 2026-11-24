package io.github.fatihmutluu.elv.lanpairing

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.Inet6Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets
import java.util.Collections
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** Active LAN pairing server endpoint metadata returned when the listener binds. */
data class LanPairingServerInfo(
  val host: String,
  val port: Int,
  val url: String,
  val expiresAtMs: Long,
)

/**
 * Ephemeral single-use HTTP/1.1 server for phone-to-TV LAN pairing (`#50`).
 * Enforces private-LAN/loopback peer validation, exact `Host` & same-origin `Origin` checks,
 * constant-time token path matching, body size caps, failed-attempt lockout, and immediate teardown
 * after the first valid POST submission or TTL expiry. Never logs request bodies, headers, or URLs.
 */
class LanPairingHttpServer(
  private val token: String,
  html: String,
  private val ttlMs: Long,
  private val maxBodyBytes: Int = DEFAULT_MAX_BODY_BYTES,
  private val maxFailedAttempts: Int = DEFAULT_MAX_FAILED_ATTEMPTS,
  private val bindAddress: InetAddress? = null,
  private val advertisedHost: String? = null,
  private val clientTimeoutMs: Int = DEFAULT_CLIENT_TIMEOUT_MS,
  private val onSubmission: (body: String, contentType: String?) -> Unit,
) {
  private val htmlBytes: ByteArray = html.toByteArray(StandardCharsets.UTF_8)
  private val running = AtomicBoolean(false)
  private val submitted = AtomicBoolean(false)
  private val failedAttempts = AtomicInteger(0)
  private val activeClientSockets = Collections.newSetFromMap(ConcurrentHashMap<Socket, Boolean>())

  @Volatile
  private var serverSocket: ServerSocket? = null

  @Volatile
  private var acceptExecutor = createAcceptExecutor()

  @Volatile
  private var workerExecutor = createWorkerExecutor()

  @Volatile
  private var timerExecutor: ScheduledExecutorService? = null

  @Volatile
  private var boundHost: String = ""

  @Volatile
  private var boundPort: Int = 0

  val isRunning: Boolean
    get() = running.get()

  /** Binds an ephemeral local socket, schedules TTL teardown, and begins accepting connections. */
  fun start(): LanPairingServerInfo {
    require(TOKEN_REGEX.matches(token)) { "Invalid pairing token" }
    require(ttlMs in MIN_TTL_MS..MAX_TTL_MS) { "Invalid pairing TTL" }
    require(maxBodyBytes in 256..HARD_MAX_BODY_BYTES) { "Invalid maxBodyBytes" }
    require(maxFailedAttempts in 1..20) { "Invalid maxFailedAttempts" }
    check(running.compareAndSet(false, true)) { "Server already started" }

    val host = advertisedHost ?: discoverPreferredLanIpv4()
    if (host == null) {
      running.set(false)
      throw IllegalStateException("No private LAN IPv4 address available")
    }

    val socket = try {
      if (bindAddress != null) {
        ServerSocket(0, 16, bindAddress)
      } else {
        ServerSocket(0, 16)
      }
    } catch (t: Throwable) {
      running.set(false)
      throw t
    }

    serverSocket = socket
    boundHost = host
    boundPort = socket.localPort
    val expiresAtMs = System.currentTimeMillis() + ttlMs
    val authorityHost = formatHostForAuthority(host)
    val url = "http://$authorityHost:$boundPort/pair/$token"

    val scheduler = Executors.newSingleThreadScheduledExecutor { r ->
      Thread(r, "elv-lan-pairing-ttl").apply { isDaemon = true }
    }
    timerExecutor = scheduler
    scheduler.schedule({ stop() }, ttlMs, TimeUnit.MILLISECONDS)

    acceptExecutor.execute { acceptLoop(socket) }
    return LanPairingServerInfo(
      host = host,
      port = boundPort,
      url = url,
      expiresAtMs = expiresAtMs,
    )
  }

  /** Idempotently closes the listening socket and shuts down background threads. */
  fun stop() {
    if (!running.compareAndSet(true, false)) {
      closeQuietly()
      return
    }
    closeQuietly()
  }

  private fun closeQuietly() {
    val sock = serverSocket
    serverSocket = null
    try {
      sock?.close()
    } catch (_: Throwable) {
      // Ignore close errors during teardown.
    }
    timerExecutor?.shutdownNow()
    timerExecutor = null
    acceptExecutor.shutdownNow()
    workerExecutor.shutdownNow()
    for (client in activeClientSockets) {
      runCatching { client.close() }
    }
    activeClientSockets.clear()
  }

  private fun acceptLoop(socket: ServerSocket) {
    while (running.get() && !socket.isClosed) {
      val client = try {
        socket.accept()
      } catch (_: SocketException) {
        break
      } catch (_: Throwable) {
        if (!running.get() || socket.isClosed) break
        continue
      }
      if (!running.get()) {
        runCatching { client.close() }
        break
      }
      try {
        workerExecutor.execute { handleClient(client) }
      } catch (_: RejectedExecutionException) {
        runCatching { client.close() }
      }
    }
  }

  private fun handleClient(client: Socket) {
    activeClientSockets.add(client)
    try {
      client.use { socket ->
        try {
          val deadlineNanos = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(clientTimeoutMs.toLong())
          applyRemainingTimeout(socket, deadlineNanos)
          val output = socket.getOutputStream()

          if (!isPrivateLanAddress(socket.inetAddress)) {
            writeResponse(output, 403, "Forbidden", "text/plain; charset=utf-8", "Forbidden".toByteArray())
            recordFailure()
            return
          }

          val input = socket.getInputStream()
          val parsed = readRequestHeaders(socket, input, deadlineNanos)
          if (parsed == null) {
            writeResponse(output, 400, "Bad Request", "text/plain; charset=utf-8", "Bad Request".toByteArray())
            recordFailure()
            return
          }
          if (parsed.headersTooLarge) {
            writeResponse(
              output,
              431,
              "Request Header Fields Too Large",
              "text/plain; charset=utf-8",
              "Headers Too Large".toByteArray(),
            )
            recordFailure()
            return
          }

          if (!isValidHostHeader(parsed.headers["host"], boundHost, boundPort)) {
            writeResponse(output, 403, "Forbidden", "text/plain; charset=utf-8", "Forbidden".toByteArray())
            recordFailure()
            return
          }

          if (!isValidPairingPath(parsed.path, token)) {
            writeResponse(output, 404, "Not Found", "text/plain; charset=utf-8", "Not Found".toByteArray())
            recordFailure()
            return
          }

          when (parsed.method) {
            "GET" -> {
              writeResponse(output, 200, "OK", "text/html; charset=utf-8", htmlBytes, includeHtmlCsp = true)
            }
            "POST" -> handlePost(parsed, socket, input, output, deadlineNanos)
            else -> {
              writeResponse(
                output,
                405,
                "Method Not Allowed",
                "text/plain; charset=utf-8",
                "Method Not Allowed".toByteArray(),
              )
              recordFailure()
            }
          }
        } catch (_: Throwable) {
          // Never log request contents or socket errors that could contain peer data.
        }
      }
    } finally {
      activeClientSockets.remove(client)
    }
  }

  private fun handlePost(
    parsed: ParsedRequest,
    socket: Socket,
    input: InputStream,
    output: OutputStream,
    deadlineNanos: Long,
  ) {
    if (!isValidOriginHeader(parsed.headers["origin"], boundHost, boundPort)) {
      writeResponse(output, 403, "Forbidden", "text/plain; charset=utf-8", "Forbidden".toByteArray())
      recordFailure()
      return
    }

    if (parsed.headers.containsKey("transfer-encoding")) {
      writeResponse(output, 411, "Length Required", "text/plain; charset=utf-8", "Length Required".toByteArray())
      recordFailure()
      return
    }

    val rawLength = parsed.headers["content-length"]
    val contentLength = rawLength?.trim()?.toIntOrNull()
    if (contentLength == null || contentLength < 0) {
      writeResponse(output, 411, "Length Required", "text/plain; charset=utf-8", "Length Required".toByteArray())
      recordFailure()
      return
    }
    if (contentLength == 0) {
      writeResponse(
        output,
        400,
        "Bad Request",
        "application/json; charset=utf-8",
        INVALID_PAYLOAD_JSON,
      )
      recordFailure()
      return
    }
    if (contentLength > maxBodyBytes) {
      writeResponse(
        output,
        413,
        "Payload Too Large",
        "text/plain; charset=utf-8",
        "Payload Too Large".toByteArray(),
      )
      recordFailure()
      return
    }

    val bodyBytes = readExactBody(socket, input, parsed.initialBodyBytes, contentLength, deadlineNanos)
    if (bodyBytes == null) {
      writeResponse(output, 400, "Bad Request", "text/plain; charset=utf-8", "Incomplete Body".toByteArray())
      recordFailure()
      return
    }

    val bodyText = decodeUtf8Strict(bodyBytes)
    val contentType = parsed.headers["content-type"]
    if (bodyText == null || !LanPairingPayloadValidator.isValidSubmissionPayload(bodyText, contentType)) {
      writeResponse(
        output,
        400,
        "Bad Request",
        "application/json; charset=utf-8",
        INVALID_PAYLOAD_JSON,
      )
      recordFailure()
      return
    }

    if (!submitted.compareAndSet(false, true)) {
      writeResponse(output, 410, "Gone", "text/plain; charset=utf-8", "Expired".toByteArray())
      stop()
      return
    }

    val okPayload = """{"ok":true}""".toByteArray(StandardCharsets.UTF_8)
    writeResponse(output, 200, "OK", "application/json; charset=utf-8", okPayload)

    try {
      onSubmission(bodyText, contentType)
    } finally {
      stop()
    }
  }

  private fun recordFailure() {
    if (failedAttempts.incrementAndGet() >= maxFailedAttempts) {
      stop()
    }
  }

  private data class ParsedRequest(
    val method: String,
    val path: String,
    val headers: Map<String, String>,
    val initialBodyBytes: ByteArray,
    val headersTooLarge: Boolean = false,
  )

  private fun applyRemainingTimeout(socket: Socket, deadlineNanos: Long) {
    val remainingNanos = deadlineNanos - System.nanoTime()
    if (remainingNanos <= 0L) {
      throw SocketTimeoutException("Request deadline exceeded")
    }
    val remainingMs = TimeUnit.NANOSECONDS.toMillis(remainingNanos).coerceAtLeast(1L)
    socket.soTimeout = remainingMs.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
  }

  private fun decodeUtf8Strict(bytes: ByteArray): String? {
    return runCatching {
      StandardCharsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT)
        .decode(ByteBuffer.wrap(bytes))
        .toString()
    }.getOrNull()
  }

  private fun readRequestHeaders(
    socket: Socket,
    input: InputStream,
    deadlineNanos: Long,
  ): ParsedRequest? {
    val buffer = ByteArrayOutputStream()
    val chunk = ByteArray(1024)
    var headerEndIndex = -1

    while (headerEndIndex == -1) {
      applyRemainingTimeout(socket, deadlineNanos)
      val read = input.read(chunk)
      if (read <= 0) return null
      if (System.nanoTime() > deadlineNanos) {
        throw SocketTimeoutException("Request header deadline exceeded")
      }
      buffer.write(chunk, 0, read)
      val current = buffer.toByteArray()
      headerEndIndex = findHeaderDelimiter(current)
      if (headerEndIndex == -1 && current.size > MAX_HEADER_BYTES) {
        return ParsedRequest("", "", emptyMap(), ByteArray(0), headersTooLarge = true)
      }
    }

    val allBytes = buffer.toByteArray()
    if (headerEndIndex > MAX_HEADER_BYTES) {
      return ParsedRequest("", "", emptyMap(), ByteArray(0), headersTooLarge = true)
    }

    val headerText = String(allBytes, 0, headerEndIndex, StandardCharsets.ISO_8859_1)
    val bodyStart = headerEndIndex + 4
    val initialBody = if (bodyStart < allBytes.size) {
      allBytes.copyOfRange(bodyStart, allBytes.size)
    } else {
      ByteArray(0)
    }

    val lines = headerText.split("\r\n")
    if (lines.isEmpty()) return null
    val requestLineParts = lines[0].split(" ")
    if (requestLineParts.size != 3) return null
    val method = requestLineParts[0].trim().uppercase(Locale.US)
    val target = requestLineParts[1].trim()
    val version = requestLineParts[2].trim()
    if (!version.startsWith("HTTP/1.")) return null

    val headers = LinkedHashMap<String, String>()
    for (i in 1 until lines.size) {
      val line = lines[i]
      if (line.isEmpty()) continue
      val colon = line.indexOf(':')
      if (colon <= 0) return null
      val name = line.substring(0, colon).trim().lowercase(Locale.US)
      val value = line.substring(colon + 1).trim()
      if ((name == "host" || name == "content-length") && headers.containsKey(name)) {
        return null
      }
      headers[name] = value
    }

    return ParsedRequest(method, target, headers, initialBody)
  }

  private fun readExactBody(
    socket: Socket,
    input: InputStream,
    initial: ByteArray,
    contentLength: Int,
    deadlineNanos: Long,
  ): ByteArray? {
    if (initial.size >= contentLength) {
      return initial.copyOfRange(0, contentLength)
    }
    val out = ByteArray(contentLength)
    System.arraycopy(initial, 0, out, 0, initial.size)
    var offset = initial.size
    while (offset < contentLength) {
      applyRemainingTimeout(socket, deadlineNanos)
      val read = input.read(out, offset, contentLength - offset)
      if (read <= 0) return null
      if (System.nanoTime() > deadlineNanos) {
        throw SocketTimeoutException("Request body deadline exceeded")
      }
      offset += read
    }
    return out
  }

  private fun writeResponse(
    output: OutputStream,
    status: Int,
    reason: String,
    contentType: String,
    body: ByteArray,
    includeHtmlCsp: Boolean = false,
  ) {
    val sb = StringBuilder(256)
    sb.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n")
    sb.append("Content-Type: ").append(contentType).append("\r\n")
    sb.append("Content-Length: ").append(body.size).append("\r\n")
    sb.append("Cache-Control: no-store\r\n")
    sb.append("Pragma: no-cache\r\n")
    sb.append("X-Content-Type-Options: nosniff\r\n")
    sb.append("X-Frame-Options: DENY\r\n")
    sb.append("Referrer-Policy: no-referrer\r\n")
    if (includeHtmlCsp) {
      sb.append(
        "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; " +
          "script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'\r\n",
      )
    }
    sb.append("Connection: close\r\n\r\n")
    output.write(sb.toString().toByteArray(StandardCharsets.ISO_8859_1))
    output.write(body)
    output.flush()
  }

  companion object {
    const val DEFAULT_MAX_BODY_BYTES = 16_384
    const val DEFAULT_MAX_FAILED_ATTEMPTS = 5
    const val DEFAULT_CLIENT_TIMEOUT_MS = 5_000
    const val MAX_CONCURRENT_CLIENTS = 4
    private const val HARD_MAX_BODY_BYTES = 65_536
    private const val MAX_HEADER_BYTES = 8_192
    private const val MIN_TTL_MS = 1_000L
    private const val MAX_TTL_MS = 600_000L
    private val TOKEN_REGEX = Regex("^[0-9a-fA-F]{32,128}$")
    private val INVALID_PAYLOAD_JSON = """{"error":"invalid-payload"}""".toByteArray(StandardCharsets.UTF_8)

    private fun createAcceptExecutor() = Executors.newSingleThreadExecutor { r ->
      Thread(r, "elv-lan-pairing-accept").apply { isDaemon = true }
    }

    private fun createWorkerExecutor(): ThreadPoolExecutor {
      val seq = AtomicInteger(1)
      return ThreadPoolExecutor(
        0,
        MAX_CONCURRENT_CLIENTS,
        10L,
        TimeUnit.SECONDS,
        SynchronousQueue(),
      ) { r ->
        Thread(r, "elv-lan-pairing-worker-${seq.getAndIncrement()}").apply { isDaemon = true }
      }
    }

    private fun findHeaderDelimiter(bytes: ByteArray): Int {
      for (i in 0..bytes.size - 4) {
        if (
          bytes[i] == '\r'.code.toByte() &&
          bytes[i + 1] == '\n'.code.toByte() &&
          bytes[i + 2] == '\r'.code.toByte() &&
          bytes[i + 3] == '\n'.code.toByte()
        ) {
          return i
        }
      }
      return -1
    }

    /** Constant-time string comparison without short-circuiting on first mismatch. */
    fun constantTimeEquals(a: String, b: String): Boolean {
      var diff = a.length xor b.length
      val len = maxOf(a.length, b.length)
      for (i in 0 until len) {
        val ca = if (i < a.length) a[i].code else 0
        val cb = if (i < b.length) b[i].code else 0
        diff = diff or (ca xor cb)
      }
      return diff == 0
    }

    /** Formats IPv4 or IPv6 hosts for HTTP authority (`[ipv6]` for raw IPv6 literals). */
    fun formatHostForAuthority(host: String): String {
      val trimmed = host.trim()
      return if (trimmed.contains(':') && !trimmed.startsWith('[')) {
        "[${trimmed.lowercase(Locale.US)}]"
      } else {
        trimmed.lowercase(Locale.US)
      }
    }

    /** Checks that `path` matches `/pair/<expectedToken>` in constant time. */
    fun isValidPairingPath(path: String, expectedToken: String): Boolean {
      val queryIdx = path.indexOf('?')
      val cleanPath = if (queryIdx >= 0) path.substring(0, queryIdx) else path
      val prefix = "/pair/"
      if (!cleanPath.startsWith(prefix)) return false
      val candidate = cleanPath.substring(prefix.length)
      return constantTimeEquals(candidate, expectedToken)
    }

    /** Validates exact `Host` header against `<expectedHost>:<expectedPort>` to prevent DNS rebinding. */
    fun isValidHostHeader(hostHeader: String?, expectedHost: String, expectedPort: Int): Boolean {
      if (hostHeader.isNullOrBlank()) return false
      val candidate = hostHeader.trim().lowercase(Locale.US)
      val formatted = formatHostForAuthority(expectedHost)
      if (candidate == "$formatted:$expectedPort") return true
      return expectedPort == 80 && candidate == formatted
    }

    /** Allows absent `Origin` or exact same-origin `http://<expectedHost>:<expectedPort>`. */
    fun isValidOriginHeader(originHeader: String?, expectedHost: String, expectedPort: Int): Boolean {
      if (originHeader == null) return true
      val candidate = originHeader.trim().lowercase(Locale.US)
      if (candidate.isEmpty()) return false
      val formatted = formatHostForAuthority(expectedHost)
      if (candidate == "http://$formatted:$expectedPort") return true
      return expectedPort == 80 && candidate == "http://$formatted"
    }

    /** Validates RFC1918 IPv4, IPv4-mapped IPv6 private/loopback, IPv6 ULA, IPv6 link-local, or loopback. */
    fun isPrivateLanAddress(address: InetAddress?): Boolean {
      if (address == null) return false
      val bytes = address.address
      if (address is Inet4Address && bytes.size == 4) {
        return isPrivateOrLoopbackIpv4Bytes(bytes[0], bytes[1])
      }
      if (address is Inet6Address && bytes.size == 16) {
        // Loopback ::1
        var prefixZero = true
        for (i in 0..14) {
          if (bytes[i].toInt() != 0) {
            prefixZero = false
            break
          }
        }
        if (prefixZero && bytes[15].toInt() == 1) return true

        // IPv4-mapped ::ffff:0:0/96
        var mappedPrefix = true
        for (i in 0..9) {
          if (bytes[i].toInt() != 0) {
            mappedPrefix = false
            break
          }
        }
        if (mappedPrefix && (bytes[10].toInt() and 0xff) == 0xff && (bytes[11].toInt() and 0xff) == 0xff) {
          return isPrivateOrLoopbackIpv4Bytes(bytes[12], bytes[13])
        }

        val b0 = bytes[0].toInt() and 0xff
        val b1 = bytes[1].toInt() and 0xff
        // IPv6 ULA fc00::/7
        if ((b0 and 0xfe) == 0xfc) return true
        // IPv6 link-local fe80::/10
        if (b0 == 0xfe && (b1 and 0xc0) == 0x80) return true
      }
      return false
    }

    private fun isPrivateOrLoopbackIpv4Bytes(b0Raw: Byte, b1Raw: Byte): Boolean {
      val b0 = b0Raw.toInt() and 0xff
      val b1 = b1Raw.toInt() and 0xff
      if (b0 == 10) return true
      if (b0 == 172 && b1 in 16..31) return true
      if (b0 == 192 && b1 == 168) return true
      if (b0 == 127) return true
      return false
    }

    private fun isRfc1918Ipv4(address: Inet4Address): Boolean {
      val bytes = address.address
      if (bytes.size != 4) return false
      val b0 = bytes[0].toInt() and 0xff
      val b1 = bytes[1].toInt() and 0xff
      return b0 == 10 || (b0 == 172 && b1 in 16..31) || (b0 == 192 && b1 == 168)
    }

    /** Discovers the preferred non-loopback RFC1918 IPv4 address (`wlan` > `eth`/`en` > other). */
    fun discoverPreferredLanIpv4(): String? {
      val interfaces = try {
        NetworkInterface.getNetworkInterfaces()?.toList() ?: emptyList()
      } catch (_: Throwable) {
        return null
      }
      var bestPriority = Int.MAX_VALUE
      var bestIp: String? = null
      for (iface in interfaces) {
        val active = try {
          iface.isUp && !iface.isLoopback && !iface.isVirtual
        } catch (_: Throwable) {
          false
        }
        if (!active) continue

        val name = (iface.name ?: "").lowercase(Locale.US)
        val priority = when {
          name.startsWith("wlan") || name.startsWith("wifi") -> 0
          name.startsWith("eth") || name.startsWith("en") -> 1
          else -> 2
        }

        val addrs = iface.inetAddresses?.toList() ?: emptyList()
        for (addr in addrs) {
          if (addr is Inet4Address && !addr.isLoopbackAddress && !addr.isLinkLocalAddress && isRfc1918Ipv4(addr)) {
            if (priority < bestPriority) {
              bestPriority = priority
              bestIp = addr.hostAddress
            }
          }
        }
      }
      return bestIp
    }
  }
}

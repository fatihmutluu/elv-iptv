package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Dispatcher
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Connect timeout of a stream request, per address. Well under the 8,000 ms start timeout, so a connect that hangs
 * (an unreachable provider) fails while the service still waits for the first frame and a retry fits that window.
 */
internal const val CONNECT_TIMEOUT_MS = 3_500L

/**
 * Longest silence while reading a response, its status line included. Above the 8,000 ms start timeout, so the
 * service's own timers (4 s stall window, 8 s start timeout, 4 s per rung) decide a silent stream's recovery and a
 * socket timeout never races them, as Media3's 8,000 ms default did. It only ends a dead socket that no newer media
 * superseded: a newer media cancels the old calls at once.
 */
internal const val READ_TIMEOUT_MS = 10_000L

/** Calls one engine's client runs at once, in all and per host: the gate, not OkHttp, bounds the real connections. */
private const val MAX_REQUESTS = 64
private const val MAX_REQUESTS_PER_HOST = 16
private val SENSITIVE_HEADERS = listOf("Authorization", "Cookie", "Proxy-Authorization")

/** Origin `(scheme, host, effectivePort)` that sensitive stream headers are scoped to. */
internal data class StreamOrigin(val scheme: String, val host: String, val port: Int) {
  constructor(url: HttpUrl) : this(url.scheme, url.host, url.port)
}

private fun sanitizeForOrigin(request: Request, origin: StreamOrigin): Request {
  if (origin == StreamOrigin(request.url)) return request
  if (SENSITIVE_HEADERS.none { request.header(it) != null }) return request
  return request.newBuilder().apply { SENSITIVE_HEADERS.forEach(::removeHeader) }.build()
}

/**
 * The base of the engines' HTTP clients: React Native's OkHttp library (no second copy), one connection pool, the
 * stream timeouts, OkHttp's redirects (http and https both ways), and origin-scoped credential stripping on every hop.
 */
private val streamClient: OkHttpClient by lazy {
  OkHttpClient.Builder()
    .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .readTimeout(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .addNetworkInterceptor { chain ->
      val request = chain.request()
      val origin = request.tag(StreamOrigin::class.java)
      chain.proceed(if (origin != null) sanitizeForOrigin(request, origin) else request)
    }
    .build()
}

/**
 * One engine's client: the shared pool and timeouts with its own dispatcher, so OkHttp's default of five calls per
 * host only adds queueing and one engine never waits for another's calls.
 */
internal fun engineHttpClient(): OkHttpClient {
  val dispatcher = Dispatcher().apply {
    maxRequests = MAX_REQUESTS
    maxRequestsPerHost = MAX_REQUESTS_PER_HOST
  }
  return streamClient.newBuilder().dispatcher(dispatcher).build()
}

/**
 * The calls of one data source, so another thread can cancel the current one: OkHttp then closes its socket at once,
 * whether it is connecting, waiting for the status line or reading the body. A call made after [cancel] is cancelled
 * as soon as it exists.
 */
internal class CancellableCalls(
  private val client: Call.Factory,
  private val origin: StreamOrigin? = null,
) : Call.Factory {
  private var call: Call? = null
  private var cancelled = false

  @Synchronized
  override fun newCall(request: Request): Call {
    val bound = origin ?: StreamOrigin(request.url)
    val tagged = sanitizeForOrigin(request, bound).newBuilder().tag(StreamOrigin::class.java, bound).build()
    return client.newCall(tagged).also {
      call = it
      if (cancelled) it.cancel()
    }
  }

  @Synchronized
  fun cancel() {
    cancelled = true
    call?.cancel()
  }
}

/**
 * An OkHttp data source for one request over [client] that sends [headers] and the canceller of its calls. A
 * `User-Agent` entry, in any case, becomes the agent; without one it sends the platform's (`http.agent`), as Media3's
 * default data source did, since some providers refuse a library's agent. Sensitive headers are scoped to [originUrl].
 */
@OptIn(UnstableApi::class)
internal fun streamDataSource(
  headers: Map<String, String>,
  client: Call.Factory,
  originUrl: String? = null,
): Pair<DataSource, CancellableCalls> {
  val userAgentKey = headers.keys.firstOrNull { it.equals("User-Agent", ignoreCase = true) }
  val calls = CancellableCalls(client, originUrl?.toHttpUrlOrNull()?.let(::StreamOrigin))
  val source = OkHttpDataSource.Factory(calls)
    .setUserAgent(userAgentKey?.let { headers[it] } ?: System.getProperty("http.agent"))
    .setDefaultRequestProperties(headers.filterKeys { it != userAgentKey })
    .createDataSource()
  return source to calls
}

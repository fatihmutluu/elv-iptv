package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.okhttp.OkHttpDataSource
import java.util.concurrent.TimeUnit
import okhttp3.Call
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

/**
 * The engines' HTTP client: React Native's OkHttp library (no second copy), its own connection pool and dispatcher,
 * the stream timeouts, and OkHttp's redirects (http and https both ways).
 */
private val streamClient: OkHttpClient by lazy {
  OkHttpClient.Builder()
    .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .readTimeout(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .build()
}

/**
 * The calls of one data source, so another thread can cancel the current one: OkHttp then closes its socket at once,
 * whether it is connecting, waiting for the status line or reading the body. A call made after [cancel] is cancelled
 * as soon as it exists.
 */
internal class CancellableCalls(private val client: Call.Factory) : Call.Factory {
  private var call: Call? = null
  private var cancelled = false

  @Synchronized
  override fun newCall(request: Request): Call =
    client.newCall(request).also {
      call = it
      if (cancelled) it.cancel()
    }

  @Synchronized
  fun cancel() {
    cancelled = true
    call?.cancel()
  }
}

/**
 * An OkHttp data source for one request that sends [headers] (a `User-Agent` entry, in any case, becomes the agent),
 * and the canceller of its calls.
 */
@OptIn(UnstableApi::class)
internal fun streamDataSource(headers: Map<String, String>): Pair<DataSource, CancellableCalls> {
  val userAgentKey = headers.keys.firstOrNull { it.equals("User-Agent", ignoreCase = true) }
  val calls = CancellableCalls(streamClient)
  val source = OkHttpDataSource.Factory(calls)
    .setUserAgent(userAgentKey?.let { headers[it] })
    .setDefaultRequestProperties(headers.filterKeys { it != userAgentKey })
    .createDataSource()
  return source to calls
}

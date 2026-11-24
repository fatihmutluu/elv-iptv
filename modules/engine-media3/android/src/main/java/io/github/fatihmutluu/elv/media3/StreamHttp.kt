package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.ContentDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.FileDataSource
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.okhttp.OkHttpDataSource
import java.io.File
import java.io.IOException
import java.util.Locale
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.Call
import okhttp3.ConnectionPool
import okhttp3.ConnectionSpec
import okhttp3.Dispatcher
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request

/**
 * Connect timeout of a stream request, per address. Well under the 5,000 ms start timeout, so a connect that hangs
 * (an unreachable provider) fails while the service still waits for the first frame and a retry fits that window.
 */
internal const val CONNECT_TIMEOUT_MS = 3_500L

/**
 * Longest silence while reading a response, its status line included. Above the 5,000 ms live / 8,000 ms VOD start
 * timeout, so the service's own timers (4 s stall window, 5,000 ms start timeout, 2 s per rung) decide a silent
 * stream's recovery and a socket timeout never races them, as Media3's 8,000 ms default did. It only ends a dead
 * socket that no newer media superseded: a newer media cancels the old calls at once.
 */
internal const val READ_TIMEOUT_MS = 10_000L

/** Explicit socket write timeout so stalled TLS/HTTP uploads never rely on an unbounded or implicit default (#438). */
internal const val WRITE_TIMEOUT_MS = 10_000L

/** Calls one engine's client runs at once, in all and per host: the gate, not OkHttp, bounds the real connections. */
private const val MAX_REQUESTS = 64
private const val MAX_REQUESTS_PER_HOST = 16
internal const val DEFAULT_MAX_COOKIES = 128
private val SENSITIVE_HEADERS =
  listOf("Authorization", "Cookie", "Proxy-Authorization", "X-Api-Key", "X-Auth-Token")
private val MAX_AGE_RE = Regex("^-?\\d+$")
private val HTTP_DATE_MONTHS = mapOf(
  "jan" to 1, "feb" to 2, "mar" to 3, "apr" to 4, "may" to 5, "jun" to 6,
  "jul" to 7, "aug" to 8, "sep" to 9, "oct" to 10, "nov" to 11, "dec" to 12,
)
private val TIME_RE = Regex("^(\\d{1,2}):(\\d{2}):(\\d{2})$")
private val RFC850_DATE_RE = Regex("^(\\d{1,2})-([A-Za-z]{3})-(\\d{2,4})$")

private fun isValidHeaderName(name: String): Boolean {
  if (name.isEmpty()) return false
  for (c in name) {
    val valid =
      c in 'A'..'Z' ||
        c in 'a'..'z' ||
        c in '0'..'9' ||
        c in "!#$%&'*+-.^_`|~"
    if (!valid) return false
  }
  return true
}

private fun sanitizeHeaderValue(raw: String): String =
  buildString(raw.length) {
    for (c in raw) {
      if (c == '\t' || c in '\u0020'..'\u007e') append(c)
    }
  }.trim()

/** Origin `(scheme, host, effectivePort)` that sensitive stream headers and cookies are scoped to. */
internal data class StreamOrigin(val scheme: String, val host: String, val port: Int) {
  constructor(url: HttpUrl) : this(url.scheme, url.host, url.port)
}

private data class CookieKey(val origin: StreamOrigin, val path: String, val name: String)

private data class StoredCookie(
  val origin: StreamOrigin,
  val path: String,
  val name: String,
  val value: String,
  val secure: Boolean,
  val expiresAtMs: Long?,
  val createdAt: Long,
)

private fun defaultCookiePath(url: HttpUrl): String {
  val encodedPath = url.encodedPath
  val lastSlash = encodedPath.lastIndexOf('/')
  return if (lastSlash <= 0) "/" else encodedPath.substring(0, lastSlash)
}

private fun cookiePathMatches(requestPath: String, cookiePath: String): Boolean {
  val normReq = if (requestPath.startsWith('/')) requestPath else "/"
  if (normReq == cookiePath) return true
  if (!normReq.startsWith(cookiePath)) return false
  return cookiePath.endsWith('/') || normReq[cookiePath.length] == '/'
}

/** Pure UTC epoch-ms from civil date (Howard Hinnant's algorithm; locale- and timezone-independent). */
private fun utcEpochMs(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int): Long? {
  if (month !in 1..12 || day !in 1..31 || hour !in 0..23 || minute !in 0..59 || second !in 0..59) return null
  val y = if (month <= 2) year - 1 else year
  val era = (if (y >= 0) y else y - 399) / 400
  val yoe = y - era * 400
  val doy = (153 * (month + if (month > 2) -3 else 9) + 2) / 5 + day - 1
  val doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
  val days = era.toLong() * 146_097L + doe.toLong() - 719_468L
  return ((days * 86_400L) + hour * 3_600L + minute * 60L + second) * 1_000L
}

private fun expandTwoDigitYear(rawYear: Int): Int = when {
  rawYear in 0..69 -> 2000 + rawYear
  rawYear in 70..99 -> 1900 + rawYear
  else -> rawYear
}

/** Parses RFC 7231 IMF-fixdate, RFC 850, and ANSI C asctime HTTP dates to UTC epoch ms. */
internal fun parseHttpDateMs(raw: String): Long? {
  val tokens = raw.trim().replace(",", " ").split(Regex("\\s+")).filter { it.isNotEmpty() }
  if (tokens.size < 4) return null
  // Strip optional leading weekday (e.g. Wed, Sunday)
  val start = if (tokens[0].length >= 3 && tokens[0][0].isLetter() && HTTP_DATE_MONTHS[tokens[0].lowercase()] == null) 1 else 0
  if (tokens.size - start < 4) return null

  val t0 = tokens[start]
  val t1 = tokens[start + 1]
  val t2 = tokens[start + 2]
  val t3 = tokens[start + 3]

    val rfc850 = RFC850_DATE_RE.matchEntire(t0)
    if (rfc850 != null) {
      val d = rfc850.groupValues[1].toIntOrNull() ?: return null
      val m = HTTP_DATE_MONTHS[rfc850.groupValues[2].lowercase()] ?: return null
      val y = expandTwoDigitYear(rfc850.groupValues[3].toIntOrNull() ?: return null)
      val t = TIME_RE.matchEntire(t1) ?: return null
      return utcEpochMs(y, m, d, t.groupValues[1].toInt(), t.groupValues[2].toInt(), t.groupValues[3].toInt())
    }
    val imfDay = t0.toIntOrNull()
    val imfMonth = HTTP_DATE_MONTHS[t1.lowercase()]
    if (imfDay != null && imfMonth != null) {
      val y = expandTwoDigitYear(t2.toIntOrNull() ?: return null)
      val t = TIME_RE.matchEntire(t3) ?: return null
      return utcEpochMs(y, imfMonth, imfDay, t.groupValues[1].toInt(), t.groupValues[2].toInt(), t.groupValues[3].toInt())
    }
    val ascMonth = HTTP_DATE_MONTHS[t0.lowercase()]
    val ascDay = t1.toIntOrNull()
    if (ascMonth != null && ascDay != null) {
      val t = TIME_RE.matchEntire(t2) ?: return null
      val y = expandTwoDigitYear(t3.toIntOrNull() ?: return null)
      return utcEpochMs(y, ascMonth, ascDay, t.groupValues[1].toInt(), t.groupValues[2].toInt(), t.groupValues[3].toInt())
    }
    return null
}

/**
 * Bounded, in-memory, exact-origin RFC 6265 cookie jar (#171).
 * Keys cookies strictly by [StreamOrigin] (ignoring any `Domain` widening attribute), enforces `Path`, `Secure`,
 * `Max-Age` (precedence over `Expires`), and evicts expired or oldest entries beyond [maxCookies].
 */
internal class OriginCookieJar(
  maxCookies: Int = DEFAULT_MAX_COOKIES,
  private val nowMs: () -> Long = System::currentTimeMillis,
) {
  private val cap = maxCookies.coerceAtLeast(1)
  private val cookies = LinkedHashMap<CookieKey, StoredCookie>()
  private var seq = 0L

  @Synchronized
  fun store(url: HttpUrl, setCookieHeaders: List<String>) {
    if (setCookieHeaders.isEmpty()) return
    val origin = StreamOrigin(url)
    val defPath = defaultCookiePath(url)
    val now = nowMs()
    for (raw in setCookieHeaders) {
      storeOne(origin, defPath, raw, now)
    }
  }

  private fun storeOne(origin: StreamOrigin, defPath: String, rawHeader: String, now: Long) {
    val parts = rawHeader.split(';')
    val first = parts.firstOrNull() ?: return
    val eqIdx = first.indexOf('=')
    if (eqIdx <= 0) return

    val name = first.substring(0, eqIdx).trim()
    if (!isValidHeaderName(name)) return
    val value = sanitizeHeaderValue(first.substring(eqIdx + 1))

    var path = defPath
    var secure = false
    var hasMaxAge = false
    var maxAgeExpiresAt: Long? = null
    var expiresHeaderAt: Long? = null

    for (i in 1 until parts.size) {
      val attr = parts[i].trim()
      if (attr.isEmpty()) continue
      val attrEq = attr.indexOf('=')
      val attrName = (if (attrEq < 0) attr else attr.substring(0, attrEq)).trim().lowercase()
      val attrVal = if (attrEq < 0) "" else attr.substring(attrEq + 1).trim()
      when (attrName) {
        "secure" -> secure = true
        "path" -> path = if (attrVal.startsWith('/')) attrVal else defPath
        "max-age" -> if (MAX_AGE_RE.matches(attrVal)) {
          hasMaxAge = true
          maxAgeExpiresAt = parseMaxAgeExpiresAt(attrVal, now)
        }
        "expires" -> parseHttpDateMs(attrVal)?.let { expiresHeaderAt = it }
        // `Domain` is intentionally ignored to prevent cross-origin widening.
      }
    }

    val expiresAt = if (hasMaxAge) maxAgeExpiresAt else expiresHeaderAt
    val key = CookieKey(origin, path, name)
    if (expiresAt != null && expiresAt <= now) {
      cookies.remove(key)
      return
    }

    cookies.remove(key)
    cookies[key] = StoredCookie(origin, path, name, value, secure, expiresAt, ++seq)
    if (cookies.size > cap) {
      purgeExpired(now)
      val iter = cookies.entries.iterator()
      while (cookies.size > cap && iter.hasNext()) {
        iter.next()
        iter.remove()
      }
    }
  }

  private fun purgeExpired(now: Long) {
    val iter = cookies.entries.iterator()
    while (iter.hasNext()) {
      val exp = iter.next().value.expiresAtMs
      if (exp != null && exp <= now) iter.remove()
    }
  }

  @Synchronized
  fun headerFor(url: HttpUrl): String? {
    val origin = StreamOrigin(url)
    val isHttps = url.isHttps
    val reqPath = url.encodedPath
    val now = nowMs()
    val matched = ArrayList<StoredCookie>()
    val iter = cookies.entries.iterator()
    while (iter.hasNext()) {
      val entry = iter.next().value
      if (entry.expiresAtMs != null && entry.expiresAtMs <= now) {
        iter.remove()
        continue
      }
      if (entry.origin != origin) continue
      if (entry.secure && !isHttps) continue
      if (!cookiePathMatches(reqPath, entry.path)) continue
      matched.add(entry)
    }
    if (matched.isEmpty()) return null
    matched.sortWith(compareByDescending<StoredCookie> { it.path.length }.thenBy { it.createdAt })
    return matched.joinToString("; ") { "${it.name}=${it.value}" }
  }

  @Synchronized
  fun clear() {
    cookies.clear()
  }

  @Synchronized
  fun size(): Int = cookies.size
}

private fun parseMaxAgeExpiresAt(attrVal: String, now: Long): Long {
  if (attrVal.startsWith('-')) return Long.MIN_VALUE
  if (attrVal.all { it == '0' }) return Long.MIN_VALUE
  val delta = attrVal.toLongOrNull() ?: return Long.MAX_VALUE
  val maxDeltaSec = (Long.MAX_VALUE - now.coerceAtLeast(0L)) / 1_000L
  return if (delta >= maxDeltaSec) Long.MAX_VALUE else now + delta * 1_000L
}

private fun mergeCookieHeader(existing: String?, jarCookie: String): String {
  if (existing.isNullOrBlank()) return jarCookie
  val jarNames = HashSet<String>()
  for (part in jarCookie.split(';')) {
    val eq = part.indexOf('=')
    if (eq > 0) jarNames.add(part.substring(0, eq).trim())
  }
  val kept = ArrayList<String>()
  for (part in existing.split(';')) {
    val trimmed = part.trim()
    if (trimmed.isEmpty()) continue
    val eq = trimmed.indexOf('=')
    val name = if (eq > 0) trimmed.substring(0, eq).trim() else ""
    if (name.isNotEmpty() && name in jarNames) continue
    kept.add(trimmed)
  }
  return if (kept.isEmpty()) jarCookie else "${kept.joinToString("; ")}; $jarCookie"
}

/**
 * Per-call redirect state separating caller-supplied `Cookie` and sensitive headers from jar cookies (#171).
 * Once any hop leaves [initialOrigin], [leftOrigin] latches `true` so bounce-back redirects cannot restore caller credentials.
 */
internal class CallRedirectState(
  val initialOrigin: StreamOrigin,
  val callerCookie: String?,
) {
  @Volatile var leftOrigin: Boolean = false
}

/**
 * Sanitizes and scopes one network hop: strips any carried `Cookie` header unconditionally (so previous hops' jar
 * cookies never leak across cross-origin bounces, `Secure` downgrades, path escapes, or `Max-Age=0` deletions),
 * restores [CallRedirectState.callerCookie] only while same-origin and `!leftOrigin`, strips sensitive caller headers
 * once the call leaves `initialOrigin`, and merges `cookieJar.headerFor(request.url)`.
 */
internal fun scopeHopRequest(
  request: Request,
  state: CallRedirectState?,
  cookieJar: OriginCookieJar,
): Request {
  val targetOrigin = StreamOrigin(request.url)
  if (state != null && targetOrigin != state.initialOrigin) {
    state.leftOrigin = true
  }
  val leftOrigin = state != null && (state.leftOrigin || targetOrigin != state.initialOrigin)
  val builder = request.newBuilder().removeHeader("Cookie")
  if (leftOrigin) {
    SENSITIVE_HEADERS.forEach(builder::removeHeader)
  }
  val callerCookie = when {
    state == null -> null
    leftOrigin -> null
    else -> state.callerCookie
  }
  val jarCookie = cookieJar.headerFor(request.url)
  val finalCookie = when {
    jarCookie != null -> mergeCookieHeader(callerCookie, jarCookie)
    !callerCookie.isNullOrBlank() -> callerCookie
    else -> null
  }
  if (finalCookie != null) {
    builder.header("Cookie", finalCookie)
  }
  return builder.build()
}

private fun sanitizeForOrigin(request: Request, origin: StreamOrigin): Request {
  if (origin == StreamOrigin(request.url)) return request
  if (SENSITIVE_HEADERS.none { request.header(it) != null }) return request
  return request.newBuilder().apply { SENSITIVE_HEADERS.forEach(::removeHeader) }.build()
}

/** Default strict modern TLS + cleartext specs; never downgraded globally (#182). */
internal val MODERN_CONNECTION_SPECS: List<ConnectionSpec> =
  listOf(ConnectionSpec.MODERN_TLS, ConnectionSpec.CLEARTEXT)

/** Opt-in legacy TLS (TLS 1.0/1.1) + cleartext specs preserving full certificate verification (#182). */
internal val LEGACY_TLS_CONNECTION_SPECS: List<ConnectionSpec> =
  listOf(ConnectionSpec.COMPATIBLE_TLS, ConnectionSpec.CLEARTEXT)

/**
 * The base of the engines' HTTP clients: React Native's OkHttp library (no second copy), one connection pool, the
 * stream timeouts, and OkHttp's redirects (http and https both ways).
 */
private val streamClient: OkHttpClient by lazy {
  OkHttpClient.Builder()
    .connectionSpecs(MODERN_CONNECTION_SPECS)
    .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .readTimeout(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .writeTimeout(WRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .build()
}

/**
 * One engine's client: the shared pool and timeouts with its own dispatcher, exact-origin credential stripping, and
 * bounded per-session [OriginCookieJar] (#171). Uses [MODERN_CONNECTION_SPECS] unless [allowLegacyTls] is explicitly
 * opted in (#182).
 */
internal fun engineHttpClient(
  cookieJar: OriginCookieJar = OriginCookieJar(),
  allowLegacyTls: Boolean = false,
): OkHttpClient {
  val dispatcher = Dispatcher().apply {
    maxRequests = MAX_REQUESTS
    maxRequestsPerHost = MAX_REQUESTS_PER_HOST
  }
  return streamClient.newBuilder()
    .connectionSpecs(if (allowLegacyTls) LEGACY_TLS_CONNECTION_SPECS else MODERN_CONNECTION_SPECS)
    .dispatcher(dispatcher)
    .addInterceptor { chain ->
      val req = chain.request()
      if (req.tag(CallRedirectState::class.java) != null) {
        chain.proceed(req)
      } else {
        val origin = req.tag(StreamOrigin::class.java) ?: StreamOrigin(req.url)
        val callerCookie = if (origin == StreamOrigin(req.url)) req.header("Cookie") else null
        val state = CallRedirectState(origin, callerCookie)
        chain.proceed(req.newBuilder().tag(CallRedirectState::class.java, state).build())
      }
    }
    .addNetworkInterceptor { chain ->
      val raw = chain.request()
      val state = raw.tag(CallRedirectState::class.java)
      val outbound = scopeHopRequest(raw, state, cookieJar)
      val response = chain.proceed(outbound)
      cookieJar.store(outbound.url, response.headers("Set-Cookie"))
      response
    }
    .build()
}

/**
 * Derives an opt-in legacy TLS client from [base] sharing its dispatcher, cookie jar, and redirect interceptors
 * without mutating [base] or disabling certificate validation (#182).
 */
internal fun legacyTlsClient(base: OkHttpClient): OkHttpClient =
  base.newBuilder()
    .connectionSpecs(LEGACY_TLS_CONNECTION_SPECS)
    .build()

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
    val sanitized = sanitizeForOrigin(request, bound)
    val callerCookie = if (bound == StreamOrigin(sanitized.url)) sanitized.header("Cookie") else null
    val state = CallRedirectState(bound, callerCookie)
    val tagged = sanitized.newBuilder()
      .tag(StreamOrigin::class.java, bound)
      .tag(CallRedirectState::class.java, state)
      .build()
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
 * An OkHttp data source for one request over [client] that sends sanitized [headers] and the canceller of its calls. A
 * `User-Agent` entry, in any case, becomes the agent; without one it sends the platform's (`http.agent`), since some
 * providers refuse a library's agent. Sensitive headers are scoped to [originUrl].
 */
@OptIn(UnstableApi::class)
internal fun streamDataSource(
  headers: Map<String, String>,
  client: Call.Factory,
  originUrl: String? = null,
): Pair<DataSource, CancellableCalls> {
  val customAgent =
    headers.entries
      .firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }
      ?.value
      ?.let(::sanitizeHeaderValue)
      ?.takeIf { it.isNotEmpty() }
  val fallbackAgent = System.getProperty("http.agent")?.let(::sanitizeHeaderValue)?.takeIf { it.isNotEmpty() }
  val cleanHeaders = LinkedHashMap<String, String>()
  for ((rawName, rawValue) in headers) {
    val name = rawName.trim()
    if (name.equals("User-Agent", ignoreCase = true) || !isValidHeaderName(name)) continue
    cleanHeaders[name] = sanitizeHeaderValue(rawValue)
  }
  val calls = CancellableCalls(client, originUrl?.toHttpUrlOrNull()?.let(::StreamOrigin))
  val source = OkHttpDataSource.Factory(calls)
    .setUserAgent(customAgent ?: fallbackAgent)
    .setDefaultRequestProperties(cleanHeaders)
    .createDataSource()
  return source to calls
}

private const val SUBTITLE_MAX_REQUESTS = 16
private const val SUBTITLE_MAX_REQUESTS_PER_HOST = 4

/**
 * Dedicated base OkHttpClient for external sidecar subtitle fetches (#308): completely separate connection pool and
 * dispatcher from [streamClient], with zero inherited stream headers or cookies.
 */
private val isolatedSubtitleBaseClient: OkHttpClient by lazy {
  val dispatcher = Dispatcher().apply {
    maxRequests = SUBTITLE_MAX_REQUESTS
    maxRequestsPerHost = SUBTITLE_MAX_REQUESTS_PER_HOST
  }
  OkHttpClient.Builder()
    .connectionPool(ConnectionPool(4, 2, TimeUnit.MINUTES))
    .connectionSpecs(MODERN_CONNECTION_SPECS)
    .dispatcher(dispatcher)
    .connectTimeout(CONNECT_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .readTimeout(READ_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .writeTimeout(WRITE_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    .build()
}

/**
 * Builds an isolated per-subtitle [OkHttpClient] with its own empty [OriginCookieJar] and exact-origin redirect
 * credential stripping so primary stream credentials never leak onto external subtitle requests (#308).
 */
internal fun subtitleHttpClient(allowLegacyTls: Boolean = false): OkHttpClient {
  val cookieJar = OriginCookieJar()
  return isolatedSubtitleBaseClient.newBuilder()
    .connectionSpecs(if (allowLegacyTls) LEGACY_TLS_CONNECTION_SPECS else MODERN_CONNECTION_SPECS)
    .addInterceptor { chain ->
      val req = chain.request()
      if (req.tag(CallRedirectState::class.java) != null) {
        chain.proceed(req)
      } else {
        val origin = req.tag(StreamOrigin::class.java) ?: StreamOrigin(req.url)
        val callerCookie = if (origin == StreamOrigin(req.url)) req.header("Cookie") else null
        val state = CallRedirectState(origin, callerCookie)
        chain.proceed(req.newBuilder().tag(CallRedirectState::class.java, state).build())
      }
    }
    .addNetworkInterceptor { chain ->
      val raw = chain.request()
      val state = raw.tag(CallRedirectState::class.java)
      val outbound = scopeHopRequest(raw, state, cookieJar)
      val response = chain.proceed(outbound)
      cookieJar.store(outbound.url, response.headers("Set-Cookie"))
      response
    }
    .build()
}

/**
 * Scheme-allowlisting [DataSource] for external sidecar subtitles (#308):
 * - Routes `http://` and `https://` strictly through an isolated [subtitleHttpClient] with ONLY the headers explicitly
 *   declared on that subtitle track (never primary stream `Authorization`, `Cookie`, `User-Agent`, or `Referer`).
 * - Routes `file://` to [FileDataSource] and `content://` to [ContentDataSource].
 * - Rejects every other URI scheme (`data:`, `ftp:`, `javascript:`, etc.).
 */
@OptIn(UnstableApi::class)
internal class IsolatedSubtitleDataSource(
  subtitleHeaders: Map<String, String>,
  private val client: Call.Factory,
  private val context: Context?,
  private val maxBytes: Int = MAX_EXTERNAL_SUBTITLE_BYTES,
  private val canonicalFileResolver: (File) -> File = { it.canonicalFile },
) : DataSource {
  private val customAgent: String?
  private val cleanHeaders: Map<String, String>
  private val transferListeners = mutableListOf<TransferListener>()
  private val lifecycleLock = Any()
  private val cancelled = AtomicBoolean(false)
  @Volatile private var activeSource: DataSource? = null
  @Volatile private var activeCalls: CancellableCalls? = null
  private var bytesRead: Long = 0L

  init {
    customAgent =
      subtitleHeaders.entries
        .firstOrNull { it.key.equals("User-Agent", ignoreCase = true) }
        ?.value
        ?.let(::sanitizeHeaderValue)
        ?.takeIf { it.isNotEmpty() }
    val sanitized = LinkedHashMap<String, String>()
    for ((rawName, rawValue) in subtitleHeaders) {
      val name = rawName.trim()
      if (name.equals("User-Agent", ignoreCase = true) || !isValidHeaderName(name)) continue
      sanitized[name] = sanitizeHeaderValue(rawValue)
    }
    cleanHeaders = sanitized
  }

  override fun addTransferListener(transferListener: TransferListener) {
    transferListeners += transferListener
    activeSource?.addTransferListener(transferListener)
  }

  override fun open(dataSpec: DataSpec): Long {
    if (cancelled.get()) {
      throw IOException("External subtitle request cancelled")
    }
    val rawUri = dataSpec.uri.toString()
    if (!isAllowedExternalSubtitleUri(rawUri)) {
      throw IOException("Disallowed external subtitle URI")
    }
    val scheme = dataSpec.uri.normalizeScheme().scheme?.lowercase(Locale.ROOT)
    var effectiveSpec = dataSpec
    val (delegate, calls) = when (scheme) {
      "http", "https" -> {
        val origin = rawUri.toHttpUrlOrNull()?.let(::StreamOrigin)
        val cancellable = CancellableCalls(client, origin)
        val httpSource = OkHttpDataSource.Factory(cancellable)
          .setUserAgent(customAgent)
          .setDefaultRequestProperties(cleanHeaders)
          .createDataSource()
        httpSource to cancellable
      }
      "file" -> {
        val rawPath = dataSpec.uri.path
        if (rawPath.isNullOrBlank()) {
          throw IOException("Invalid local subtitle file URI")
        }
        val canonical = try {
          canonicalFileResolver(File(rawPath))
        } catch (e: IOException) {
          throw IOException("Unable to resolve local subtitle file", e)
        }
        if (!canonical.exists() || !canonical.isFile) {
          throw IOException("Local subtitle file does not exist or is not a regular file")
        }
        if (!hasAllowedLocalSubtitleExtension(canonical.path)) {
          throw IOException("Local subtitle canonical path has disallowed extension")
        }
        if (canonical.length() > maxBytes.toLong()) {
          throw IOException("Local subtitle file exceeds $maxBytes byte cap")
        }
        effectiveSpec = dataSpec.buildUpon().setUri(Uri.fromFile(canonical)).build()
        FileDataSource() to null
      }
      "content" -> {
        val appCtx = context?.applicationContext ?: context
          ?: throw IOException("content:// external subtitle requires Android Context")
        ContentDataSource(appCtx) to null
      }
      else -> throw IOException("Unsupported external subtitle URI scheme: $scheme")
    }
    for (listener in transferListeners) {
      delegate.addTransferListener(listener)
    }
    synchronized(lifecycleLock) {
      if (cancelled.get()) {
        calls?.cancel()
        throw IOException("External subtitle request cancelled")
      }
      activeSource = delegate
      activeCalls = calls
    }
    bytesRead = 0L
    val openedLength = delegate.open(effectiveSpec)
    val limit = maxBytes.toLong()
    val headerTooLarge = delegate.responseHeaders.entries.any { (name, values) ->
      name.equals("Content-Length", ignoreCase = true) &&
        values.any { (it.trim().toLongOrNull() ?: -1L) > limit }
    }
    if ((openedLength != C.LENGTH_UNSET.toLong() && openedLength > limit) || headerTooLarge) {
      close()
      throw IOException("External subtitle exceeds $maxBytes byte cap")
    }
    return openedLength
  }

  override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
    if (length == 0) return 0
    if (cancelled.get()) {
      throw IOException("External subtitle request cancelled")
    }
    val source = activeSource ?: return C.RESULT_END_OF_INPUT
    val limit = maxBytes.toLong()
    val remaining = (limit - bytesRead).coerceAtLeast(0L)
    val toRead = if (remaining < length.toLong()) {
      (remaining + 1L).coerceAtMost(length.toLong()).toInt()
    } else {
      length
    }
    val read = source.read(buffer, offset, toRead)
    if (read > 0) {
      bytesRead += read.toLong()
      if (bytesRead > limit) {
        close()
        throw IOException("External subtitle exceeds $maxBytes byte cap")
      }
    }
    return read
  }

  override fun getUri(): Uri? = activeSource?.uri

  override fun getResponseHeaders(): Map<String, List<String>> =
    activeSource?.responseHeaders ?: emptyMap()

  fun cancel() {
    cancelled.set(true)
    val calls: CancellableCalls?
    val source: DataSource?
    synchronized(lifecycleLock) {
      calls = activeCalls
      source = activeSource
    }
    calls?.cancel()
    runCatching { source?.close() }
  }

  override fun close() {
    val calls: CancellableCalls?
    val source: DataSource?
    synchronized(lifecycleLock) {
      calls = activeCalls
      source = activeSource
      activeCalls = null
      activeSource = null
    }
    calls?.cancel()
    source?.close()
  }
}

/** HTTP transport helpers for Media3 playback and isolated external subtitles (`#308`). */
internal object StreamHttp {
  /**
   * Returns a [DataSource.Factory] strictly isolated from the primary stream's OkHttpClient, headers, and cookie jar
   * (`#308`). Only [subtitleHeaders] explicitly declared on the subtitle track are sent over HTTP(S), and
   * cross-origin redirects strip sensitive headers automatically.
   */
  @OptIn(UnstableApi::class)
  fun subtitleDataSourceFactory(
    subtitleHeaders: Map<String, String> = emptyMap(),
    allowLegacyTls: Boolean = false,
    context: Context? = null,
  ): DataSource.Factory {
    val isolatedClient = subtitleHttpClient(allowLegacyTls = allowLegacyTls)
    val copiedHeaders = LinkedHashMap(subtitleHeaders)
    val appCtx = context?.applicationContext ?: context
    return DataSource.Factory {
      IsolatedSubtitleDataSource(
        subtitleHeaders = copiedHeaders,
        client = isolatedClient,
        context = appCtx,
      )
    }
  }
}

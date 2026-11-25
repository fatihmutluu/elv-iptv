package io.github.fatihmutluu.elv.xmltvnative

import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteStatement
import java.io.IOException
import java.net.HttpURLConnection
import java.net.SocketTimeoutException
import java.net.URL
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

internal data class NativeStageRequest(
  val jobId: String,
  val url: String,
  val dbPath: String,
  val sourceId: String,
  val runId: Long,
  val fromMs: Long,
  val toMs: Long,
  val headers: Map<String, String>,
  val ifNoneMatch: String?,
  val ifModifiedSince: String?,
  val defaultTimeZone: String?,
  val timeoutMs: Int,
)

internal sealed class NativeStageOutcome {
  data class NotModified(val etag: String?, val lastModified: String?) : NativeStageOutcome()
  data class HttpError(val status: Int, val retryable: Boolean, val code: String) : NativeStageOutcome()
  data class Staged(
    val summary: ScanSummary,
    val etag: String?,
    val lastModified: String?,
  ) : NativeStageOutcome()
}

/**
 * Streams HTTP(S) XMLTV feeds on a background thread and writes staged rows directly into SQLite
 * `programmes_next` using a compiled `SQLiteStatement` in 2,500-row WAL transactions.
 * API 28+ / SQLite 3.22 compatible (`INSERT OR REPLACE`, zero `ON CONFLICT DO UPDATE`).
 * Never logs URLs, headers, or credentials.
 */
internal class NativeXmltvStager {
  companion object {
    private const val MAX_REDIRECTS = 5
    private const val TX_BATCH_SIZE = 2_500
    const val DEFAULT_TIMEOUT_MS = 180_000

    private const val INSERT_SQL =
      "INSERT OR REPLACE INTO programmes_next " +
        "(source_id, guide_id, start, stop, title, sub_title, description, categories_json, " +
        "episode_num, icon, run_id, genre, flags, rating_system, rating_value, title_fold, description_fold) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  }

  private class JobHandle {
    val cancelled = AtomicBoolean(false)
    @Volatile var connection: HttpURLConnection? = null
  }

  private val jobs = ConcurrentHashMap<String, JobHandle>()
  private val executor = Executors.newCachedThreadPool { runnable ->
    Thread(runnable, "elv-xmltv-stager").apply { isDaemon = true }
  }

  fun enqueue(request: NativeStageRequest, onResult: (NativeStageOutcome) -> Unit) {
    executor.execute {
      val outcome = try {
        execute(request)
      } catch (_: StageCancelledException) {
        NativeStageOutcome.HttpError(status = 0, retryable = false, code = "aborted")
      } catch (_: SocketTimeoutException) {
        NativeStageOutcome.HttpError(status = 0, retryable = true, code = "timeout")
      } catch (_: IOException) {
        NativeStageOutcome.HttpError(status = 0, retryable = true, code = "request-failed")
      } catch (_: Throwable) {
        NativeStageOutcome.HttpError(status = 0, retryable = false, code = "native-stage-failed")
      }
      onResult(outcome)
    }
  }

  fun cancel(jobId: String) {
    val handle = jobs[jobId] ?: return
    handle.cancelled.set(true)
    try {
      handle.connection?.disconnect()
    } catch (_: Throwable) {
      // Best-effort abort of blocked socket read.
    }
  }

  fun cancelAll() {
    for (jobId in jobs.keys) {
      cancel(jobId)
    }
  }

  private fun execute(req: NativeStageRequest): NativeStageOutcome {
    val handle = JobHandle()
    jobs[req.jobId] = handle
    var conn: HttpURLConnection? = null
    try {
      if (handle.cancelled.get()) throw StageCancelledException()
      conn = openWithRedirects(req, handle)
      val status = conn.responseCode
      val etag = conn.getHeaderField("ETag")
      val lastModified = conn.getHeaderField("Last-Modified")
      if (status == HttpURLConnection.HTTP_NOT_MODIFIED) {
        return NativeStageOutcome.NotModified(etag = etag, lastModified = lastModified)
      }
      if (status !in 200..299) {
        val retryable = status == 408 || (status in 500..599 && status != 509)
        return NativeStageOutcome.HttpError(status = status, retryable = retryable, code = "http-$status")
      }
      val contentEncoding = conn.contentEncoding?.lowercase(Locale.US) ?: ""
      val forceGzip = contentEncoding.contains("gzip")
      val summary = conn.inputStream.use { rawStream ->
        stageStreamToSqlite(req, rawStream, forceGzip, handle.cancelled)
      }
      return NativeStageOutcome.Staged(summary = summary, etag = etag, lastModified = lastModified)
    } finally {
      try {
        conn?.disconnect()
      } catch (_: Throwable) {
      }
      handle.connection = null
      jobs.remove(req.jobId, handle)
    }
  }

  private fun openWithRedirects(req: NativeStageRequest, handle: JobHandle): HttpURLConnection {
    var currentUrl = req.url
    for (hop in 0..MAX_REDIRECTS) {
      if (handle.cancelled.get()) throw StageCancelledException()
      val parsed = URL(currentUrl)
      val scheme = parsed.protocol.lowercase(Locale.US)
      if (scheme != "http" && scheme != "https") {
        throw IllegalArgumentException("Unsupported scheme")
      }
      val conn = (parsed.openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        instanceFollowRedirects = false
        connectTimeout = req.timeoutMs
        readTimeout = req.timeoutMs
        useCaches = false
        setRequestProperty("Accept-Encoding", "gzip")
        for ((k, v) in req.headers) {
          if (!k.equals("accept-encoding", ignoreCase = true)) {
            setRequestProperty(k, v)
          }
        }
        if (!req.ifNoneMatch.isNullOrEmpty()) {
          setRequestProperty("If-None-Match", req.ifNoneMatch)
        }
        if (!req.ifModifiedSince.isNullOrEmpty()) {
          setRequestProperty("If-Modified-Since", req.ifModifiedSince)
        }
      }
      handle.connection = conn
      val status = conn.responseCode
      if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
        val location = conn.getHeaderField("Location")
        conn.disconnect()
        if (location.isNullOrEmpty() || hop == MAX_REDIRECTS) {
          throw IOException("redirect-failed")
        }
        currentUrl = URL(parsed, location).toString()
        continue
      }
      return conn
    }
    throw IOException("redirect-failed")
  }

  private fun stageStreamToSqlite(
    req: NativeStageRequest,
    rawStream: java.io.InputStream,
    forceGzip: Boolean,
    cancelled: AtomicBoolean,
  ): ScanSummary {
    val db = SQLiteDatabase.openDatabase(req.dbPath, null, SQLiteDatabase.OPEN_READWRITE)
    var stmt: SQLiteStatement? = null
    var inTx = false
    var inBatch = 0
    try {
      applyPragma(db, "PRAGMA busy_timeout = 5000")
      applyPragma(db, "PRAGMA synchronous = NORMAL")
      applyPragma(db, "PRAGMA temp_store = MEMORY")

      stmt = db.compileStatement(INSERT_SQL)
      val compiled = stmt
      db.beginTransactionNonExclusive()
      inTx = true

      val scanner = XmltvByteScanner(
        sourceId = req.sourceId,
        runId = req.runId,
        fromMs = req.fromMs,
        toMs = req.toMs,
        defaultTimeZone = req.defaultTimeZone,
        cancelled = cancelled,
      )
      val summary = scanner.scanStream(rawStream, forceGzip) { row ->
        bindRow(compiled, row)
        compiled.executeInsert()
        inBatch += 1
        if (inBatch >= TX_BATCH_SIZE) {
          db.setTransactionSuccessful()
          db.endTransaction()
          inTx = false
          inBatch = 0
          if (cancelled.get()) throw StageCancelledException()
          db.beginTransactionNonExclusive()
          inTx = true
        }
      }
      if (inTx) {
        db.setTransactionSuccessful()
        db.endTransaction()
        inTx = false
      }
      return summary
    } finally {
      if (inTx) {
        try {
          db.endTransaction()
        } catch (_: Throwable) {
        }
      }
      try {
        stmt?.close()
      } catch (_: Throwable) {
      }
      try {
        db.close()
      } catch (_: Throwable) {
      }
    }
  }

  private fun applyPragma(db: SQLiteDatabase, sql: String) {
    db.rawQuery(sql, null).use { cursor ->
      cursor.moveToFirst()
    }
  }

  private fun bindRow(stmt: SQLiteStatement, row: StagedProgrammeRow) {
    stmt.clearBindings()
    stmt.bindString(1, row.sourceId)
    stmt.bindString(2, row.guideId)
    stmt.bindLong(3, row.start)
    stmt.bindLong(4, row.stop)
    stmt.bindString(5, row.title)
    bindNullableString(stmt, 6, row.subTitle)
    bindNullableString(stmt, 7, row.description)
    bindNullableString(stmt, 8, row.categoriesJson)
    bindNullableString(stmt, 9, row.episodeNum)
    bindNullableString(stmt, 10, row.icon)
    stmt.bindLong(11, row.runId)
    bindNullableString(stmt, 12, row.genre)
    stmt.bindLong(13, row.flags.toLong())
    bindNullableString(stmt, 14, row.ratingSystem)
    bindNullableString(stmt, 15, row.ratingValue)
    stmt.bindString(16, row.titleFold)
    stmt.bindString(17, row.descriptionFold)
  }

  private fun bindNullableString(stmt: SQLiteStatement, index: Int, value: String?) {
    if (value == null) stmt.bindNull(index) else stmt.bindString(index, value)
  }
}

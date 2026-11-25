package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.content.ContextWrapper
import android.database.DatabaseErrorHandler
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import android.os.StatFs
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.database.DatabaseProvider
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.TransferListener
import androidx.media3.datasource.cache.Cache
import androidx.media3.datasource.cache.CacheDataSource
import androidx.media3.datasource.cache.ContentMetadata
import androidx.media3.datasource.cache.ContentMetadataMutations
import androidx.media3.datasource.cache.LeastRecentlyUsedCacheEvictor
import androidx.media3.datasource.cache.SimpleCache
import java.io.File
import java.util.UUID
import java.util.concurrent.Executor
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

internal const val VOD_CACHE_SUBDIR = "vod-cache"
private const val VOD_SESSION_PREFIX = "s-"
private const val VOD_SESSION_INDEX_DB = "index.db"
internal const val VOD_CACHE_DRAIN_TIMEOUT_MS = 1_500L

/**
 * Delegating [Cache] that strips URI-bearing metadata keys (`exo_redir`) before delegating mutations to [SimpleCache],
 * preserving only [ContentMetadata.KEY_CONTENT_LENGTH] (`exo_len`) so HTTP 301/302/307 redirect URLs and tokens never
 * touch disk or SQLite (#350).
 */
@OptIn(UnstableApi::class)
private class RedactingVodCache(private val delegate: Cache) : Cache by delegate {
  override fun applyContentMetadataMutations(key: String, mutations: ContentMetadataMutations) {
    val sanitized = ContentMetadataMutations()
    val contentLength = mutations.editedValues[ContentMetadata.KEY_CONTENT_LENGTH]
    if (contentLength is Long) {
      ContentMetadataMutations.setContentLength(sanitized, contentLength)
    }
    if (ContentMetadata.KEY_CONTENT_LENGTH in mutations.removedValues) {
      sanitized.remove(ContentMetadata.KEY_CONTENT_LENGTH)
    }
    if (sanitized.editedValues.isNotEmpty() || sanitized.removedValues.isNotEmpty()) {
      delegate.applyContentMetadataMutations(key, sanitized)
    }
  }
}

/**
 * Isolates a session's SQLite index file inside [dbFile] (`sessionDir/index.db`) so [SQLiteOpenHelper] works uniformly
 * across Android and Robolectric without touching shared `exoplayer_internal.db`.
 */
private class SessionDatabaseContext(base: Context, private val dbFile: File) : ContextWrapper(base) {
  override fun getDatabasePath(name: String): File = dbFile

  override fun openOrCreateDatabase(
    name: String,
    mode: Int,
    factory: SQLiteDatabase.CursorFactory?,
  ): SQLiteDatabase = SQLiteDatabase.openOrCreateDatabase(dbFile, factory)

  override fun openOrCreateDatabase(
    name: String,
    mode: Int,
    factory: SQLiteDatabase.CursorFactory?,
    errorHandler: DatabaseErrorHandler?,
  ): SQLiteDatabase = SQLiteDatabase.openOrCreateDatabase(dbFile.path, factory, errorHandler)
}

@OptIn(UnstableApi::class)
private class SessionVodDatabaseProvider(
  context: Context,
  dbFile: File,
) : SQLiteOpenHelper(SessionDatabaseContext(context, dbFile), dbFile.name, null, 1), DatabaseProvider {
  override fun onCreate(db: SQLiteDatabase) = Unit
  override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = Unit
}

/**
 * Ephemeral per-session VOD write-through cache backed by Media3 [SimpleCache] under `cacheDir/vod-cache/s-<uuid>` (#350).
 *
 * Invariants:
 * - Strictly `max_connections = 1`: wraps ExoPlayer's single gated upstream [DataSource.Factory] write-through with
 *   zero background downloaders or extra HTTP sockets.
 * - Privacy: every cache key is a lowercase SHA-256 hex digest via [hashVodCacheKey], [RedactingVodCache] strips
 *   `exo_redir` redirect URIs from SQLite metadata, and each session uses an isolated `sessionDir/index.db`.
 * - Resilience: [CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR] ensures `ENOSPC` / cache I/O failures never abort playback,
 *   and active [DataSource] handles are refcounted so [closeAndDelete] defers `SimpleCache.release()` until open handles
 *   close (bounded by [drainTimeoutMs]).
 * - Cleanup: [closeAndDelete] is idempotent and runs off the caller/UI thread via a dedicated daemon executor.
 */
@OptIn(UnstableApi::class)
internal class VodEphemeralCache private constructor(
  internal val sessionDir: File,
  private val rawCache: SimpleCache,
  private val databaseProvider: SessionVodDatabaseProvider,
  upstreamFactory: DataSource.Factory,
  private val cleanupExecutor: Executor,
  private val drainTimeoutMs: Long,
) {
  private val cache: Cache = RedactingVodCache(rawCache)
  private val closed = AtomicBoolean(false)
  private val cleanupDone = AtomicBoolean(false)
  private val lifecycleLock = Any()
  private var openHandles = 0
  private var closeRequested = false
  private var cleanupScheduled = false
  private var drainTimeoutFuture: ScheduledFuture<*>? = null

  /** Write-through [DataSource.Factory] wrapping the primary gated upstream [DataSource.Factory]. */
  val dataSourceFactory: DataSource.Factory = wrapUpstream(upstreamFactory)

  /**
   * Wraps an upstream [DataSource.Factory] in a refcounted write-through [CacheDataSource.Factory] sharing this
   * session's [RedactingVodCache], SHA-256 cache key factory, and [CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR].
   */
  fun wrapUpstream(upstreamFactory: DataSource.Factory): DataSource.Factory {
    val cacheFactory = CacheDataSource.Factory()
      .setCache(cache)
      .setUpstreamDataSourceFactory(upstreamFactory)
      .setCacheKeyFactory { spec -> hashVodCacheKey(spec.key ?: spec.uri.toString()) }
      .setFlags(CacheDataSource.FLAG_IGNORE_CACHE_ON_ERROR)
    return DataSource.Factory {
      TrackedCacheDataSource(
        cachedDelegate = cacheFactory.createDataSource(),
        bypassFactory = upstreamFactory,
      )
    }
  }

  /** Current bytes occupied in this session's [SimpleCache], or `0L` once closed or on error. */
  fun cachedBytes(): Long {
    if (closed.get()) return 0L
    return runCatching { cache.cacheSpace.coerceAtLeast(0L) }.getOrDefault(0L)
  }

  /**
   * Releases [SimpleCache], closes this session's isolated SQLite DB, and recursively deletes [sessionDir] off the main
   * thread. Defers release until open wrapped [DataSource] handles close (with [drainTimeoutMs] fallback).
   */
  fun closeAndDelete() {
    var runNow = false
    synchronized(lifecycleLock) {
      if (closeRequested) return
      closeRequested = true
      closed.set(true)
      if (openHandles == 0) {
        runNow = true
      } else {
        drainTimeoutFuture = runCatching {
          drainTimerExecutor.schedule({ scheduleCleanupOnce() }, drainTimeoutMs, TimeUnit.MILLISECONDS)
        }.getOrNull()
        if (drainTimeoutFuture == null) runNow = true
      }
    }
    if (runNow) scheduleCleanupOnce()
  }

  internal fun cacheKeysForTest(): Set<String> {
    if (closed.get()) return emptySet()
    return runCatching { cache.keys.toSet() }.getOrDefault(emptySet())
  }

  private fun tryAcquireHandle(): Boolean = synchronized(lifecycleLock) {
    if (closeRequested) return false
    openHandles += 1
    true
  }

  private fun releaseHandle() {
    val shouldScheduleNow = synchronized(lifecycleLock) {
      if (openHandles > 0) openHandles -= 1
      closeRequested && openHandles == 0 && !cleanupScheduled
    }
    if (shouldScheduleNow) {
      scheduleCleanupOnce()
    } else if (cleanupDone.get() && sessionDir.exists()) {
      val retryDelete = Runnable { runCatching { if (sessionDir.exists()) sessionDir.deleteRecursively() } }
      runCatching { cleanupExecutor.execute(retryDelete) }.onFailure { retryDelete.run() }
    }
  }

  private fun scheduleCleanupOnce() {
    synchronized(lifecycleLock) {
      if (cleanupScheduled) return
      cleanupScheduled = true
      drainTimeoutFuture?.cancel(false)
      drainTimeoutFuture = null
    }
    val cleanup = Runnable {
      if (!cleanupDone.compareAndSet(false, true)) return@Runnable
      runCatching { rawCache.release() }
      runCatching { databaseProvider.close() }
      runCatching { if (sessionDir.exists()) sessionDir.deleteRecursively() }
    }
    runCatching { cleanupExecutor.execute(cleanup) }.onFailure { cleanup.run() }
  }

  private inner class TrackedCacheDataSource(
    private val cachedDelegate: DataSource,
    private val bypassFactory: DataSource.Factory,
  ) : DataSource {
    private val listeners = mutableListOf<TransferListener>()
    private var activeDelegate: DataSource? = null
    private var trackedOpen = false

    override fun addTransferListener(transferListener: TransferListener) {
      listeners += transferListener
      cachedDelegate.addTransferListener(transferListener)
    }

    override fun open(dataSpec: DataSpec): Long {
      if (tryAcquireHandle()) {
        activeDelegate = cachedDelegate
        trackedOpen = true
        return try {
          cachedDelegate.open(dataSpec)
        } catch (t: Throwable) {
          activeDelegate = null
          trackedOpen = false
          runCatching { cachedDelegate.close() }
          releaseHandle()
          throw t
        }
      }
      val bypass = bypassFactory.createDataSource()
      for (listener in listeners) bypass.addTransferListener(listener)
      activeDelegate = bypass
      trackedOpen = false
      return bypass.open(dataSpec)
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int =
      activeDelegate?.read(buffer, offset, length) ?: C.RESULT_END_OF_INPUT

    override fun getUri(): Uri? = activeDelegate?.uri

    override fun getResponseHeaders(): Map<String, List<String>> =
      activeDelegate?.responseHeaders ?: emptyMap()

    override fun close() {
      val delegate = activeDelegate
      activeDelegate = null
      val wasTracked = trackedOpen
      trackedOpen = false
      try {
        delegate?.close()
      } finally {
        if (wasTracked) releaseHandle()
      }
    }
  }

  companion object {
    private val startupPurgeDone = AtomicBoolean(false)

    private val defaultCleanupExecutor: Executor = ThreadPoolExecutor(
      1,
      1,
      15L,
      TimeUnit.SECONDS,
      LinkedBlockingQueue(),
    ) { runnable ->
      Thread(runnable, "ElvVodCacheCleanup").apply { isDaemon = true }
    }.apply { allowCoreThreadTimeOut(true) }

    private val drainTimerExecutor: ScheduledExecutorService = ScheduledThreadPoolExecutor(1) { runnable ->
      Thread(runnable, "ElvVodCacheDrain").apply { isDaemon = true }
    }.apply {
      setKeepAliveTime(15L, TimeUnit.SECONDS)
      allowCoreThreadTimeOut(true)
      removeOnCancelPolicy = true
    }

    /**
     * Deletes stale `s-*` session directories under `cacheDir/vod-cache/` left behind by a previous process crash,
     * guarded by a one-shot [AtomicBoolean] so overlapping engines never wipe each other's active sessions (#350).
     */
    fun purgeOrphansOnStartup(cacheDir: File): Boolean {
      if (!startupPurgeDone.compareAndSet(false, true)) return false
      purgeVodCacheDir(cacheDir)
      return true
    }

    /** Safely queries available storage bytes on [cacheDir] via [StatFs] / [File.usableSpace], returning `0L` on error. */
    fun usableSpaceBytes(cacheDir: File): Long = runCatching {
      if (!cacheDir.exists()) return 0L
      val statBytes = runCatching { StatFs(cacheDir.absolutePath).availableBytes }.getOrDefault(0L)
      if (statBytes > 0L) statBytes else cacheDir.usableSpace.coerceAtLeast(0L)
    }.getOrDefault(0L)

    /**
     * Opens a new per-session ephemeral VOD cache when [budget] permits disk spill, or returns `null` when disk
     * caching is disabled or initialization fails.
     */
    fun openSession(
      context: Context,
      cacheDir: File,
      budget: VodBufferBudget,
      upstreamFactory: DataSource.Factory,
      cleanupExecutor: Executor = defaultCleanupExecutor,
      drainTimeoutMs: Long = VOD_CACHE_DRAIN_TIMEOUT_MS,
    ): VodEphemeralCache? {
      if (!budget.allowDiskCache || budget.maxDiskBytes <= 0L) return null
      val rootDir = File(cacheDir, VOD_CACHE_SUBDIR)
      val sessionDir = File(rootDir, "$VOD_SESSION_PREFIX${UUID.randomUUID()}")
      if (!sessionDir.mkdirs() && !sessionDir.isDirectory) return null
      var dbProvider: SessionVodDatabaseProvider? = null
      var rawCache: SimpleCache? = null
      return try {
        val appContext = context.applicationContext ?: context
        val dbFile = File(sessionDir, VOD_SESSION_INDEX_DB)
        dbProvider = SessionVodDatabaseProvider(appContext, dbFile)
        val evictor = LeastRecentlyUsedCacheEvictor(budget.maxDiskBytes)
        rawCache = SimpleCache(sessionDir, evictor, dbProvider)
        VodEphemeralCache(
          sessionDir = sessionDir,
          rawCache = rawCache,
          databaseProvider = dbProvider,
          upstreamFactory = upstreamFactory,
          cleanupExecutor = cleanupExecutor,
          drainTimeoutMs = drainTimeoutMs.coerceAtLeast(1L),
        )
      } catch (_: Throwable) {
        runCatching { rawCache?.release() }
        runCatching { dbProvider?.close() }
        runCatching { sessionDir.deleteRecursively() }
        null
      }
    }

    internal fun resetStartupPurgeForTest() {
      startupPurgeDone.set(false)
    }

    private fun purgeVodCacheDir(cacheDir: File) {
      runCatching {
        val dir = File(cacheDir, VOD_CACHE_SUBDIR)
        if (!dir.exists() || !dir.isDirectory) return
        dir.listFiles()?.forEach { child ->
          if (child.name.startsWith(VOD_SESSION_PREFIX)) {
            if (child.isDirectory) child.deleteRecursively() else child.delete()
          }
        }
      }
    }
  }
}

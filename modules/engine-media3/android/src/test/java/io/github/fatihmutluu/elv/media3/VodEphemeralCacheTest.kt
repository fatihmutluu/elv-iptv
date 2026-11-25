package io.github.fatihmutluu.elv.media3

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class VodEphemeralCacheTest {
  private lateinit var tempCacheDir: File
  private val mib = 1024L * 1024L

  @Before
  fun setUp() {
    tempCacheDir = Files.createTempDirectory("elv-vod-cache-test-").toFile()
    VodEphemeralCache.resetStartupPurgeForTest()
  }

  @After
  fun tearDown() {
    tempCacheDir.deleteRecursively()
  }

  private class CountingUpstreamFactory(
    private val payload: ByteArray,
    private val redirectedUri: Uri? = null,
  ) : DataSource.Factory {
    val openCount = AtomicInteger(0)

    override fun createDataSource(): DataSource = object : BaseDataSource(true) {
      private var position = 0
      private var remaining = 0
      private var openedUri: Uri? = null

      override fun open(dataSpec: DataSpec): Long {
        openCount.incrementAndGet()
        openedUri = redirectedUri ?: dataSpec.uri
        val start = dataSpec.position.toInt().coerceIn(0, payload.size)
        val requested = if (dataSpec.length == C.LENGTH_UNSET.toLong()) {
          payload.size - start
        } else {
          minOf(dataSpec.length.toInt(), payload.size - start)
        }
        position = start
        remaining = requested.coerceAtLeast(0)
        return remaining.toLong()
      }

      override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (remaining <= 0) return C.RESULT_END_OF_INPUT
        val count = minOf(length, remaining)
        System.arraycopy(payload, position, buffer, offset, count)
        position += count
        remaining -= count
        return count
      }

      override fun getUri(): Uri? = openedUri

      override fun close() = Unit
    }
  }

  private fun enabledBudget(maxDiskBytes: Long = 16 * mib): VodBufferBudget =
    VodBufferBudget(
      enabled = true,
      forwardTargetMs = 60_000,
      minBufferMs = 30_000,
      backTargetMs = 15_000,
      maxMemoryBytes = 32 * mib,
      maxDiskBytes = maxDiskBytes,
      allowDiskCache = true,
      throttleBackoffLevel = 0,
      prioritizeTimeOverSize = true,
    )

  @Test
  fun `openSession returns null when disk cache is disallowed or maxDiskBytes is zero`() {
    val context = RuntimeEnvironment.getApplication()
    val upstream = CountingUpstreamFactory(ByteArray(16))

    val disallowed = enabledBudget().copy(allowDiskCache = false)
    assertNull(VodEphemeralCache.openSession(context, tempCacheDir, disallowed, upstream))

    val zeroDisk = enabledBudget(maxDiskBytes = 0L)
    assertNull(VodEphemeralCache.openSession(context, tempCacheDir, zeroDisk, upstream))

    assertFalse(File(tempCacheDir, VOD_CACHE_SUBDIR).exists())
  }

  @Test
  fun `write-through caches VOD bytes under SHA-256 key, serves return seek with zero upstream opens, and deletes session on close`() {
    val context = RuntimeEnvironment.getApplication()
    val payload = ByteArray(16 * 1024) { idx -> ((idx * 31) and 0xFF).toByte() }
    val upstream = CountingUpstreamFactory(payload)
    val syncExecutor = Executor { it.run() }

    val session = VodEphemeralCache.openSession(
      context = context,
      cacheDir = tempCacheDir,
      budget = enabledBudget(maxDiskBytes = 4 * mib),
      upstreamFactory = upstream,
      cleanupExecutor = syncExecutor,
    )
    assertNotNull(session)
    session!!

    val rawUrl = listOf("https://provider.invalid", "movie", "demoUser", "demoSecret", "1001.mp4").joinToString("/") + "?token=supersecret99"
    val expectedHash = hashVodCacheKey(rawUrl)
    assertTrue("sessionDir must use opaque s-* prefix", session.sessionDir.name.startsWith("s-"))
    assertEquals(File(tempCacheDir, VOD_CACHE_SUBDIR), session.sessionDir.parentFile)

    // 1. First read populates cache write-through over the single upstream socket
    val ds1 = session.dataSourceFactory.createDataSource()
    val firstRead = ByteArray(payload.size)
    ds1.open(DataSpec(Uri.parse(rawUrl)))
    var total = 0
    while (total < firstRead.size) {
      val n = ds1.read(firstRead, total, firstRead.size - total)
      if (n == C.RESULT_END_OF_INPUT) break
      total += n
    }
    ds1.close()
    assertEquals(payload.size, total)
    assertArrayEquals(payload, firstRead)
    assertEquals("initial read must open upstream exactly once", 1, upstream.openCount.get())
    assertTrue("cachedBytes must reflect written payload", session.cachedBytes() >= payload.size.toLong())

    // 2. Privacy invariant: zero raw URL, username, password, token, or extension on disk or in cache keys
    val cacheKeys = session.cacheKeysForTest()
    assertEquals(setOf(expectedHash), cacheKeys)
    val allNames = session.sessionDir.walkTopDown().map { it.name }.toList()
    for (name in allNames) {
      assertFalse("leaked provider in $name", name.contains("provider", ignoreCase = true))
      assertFalse("leaked username in $name", name.contains("demoUser", ignoreCase = true))
      assertFalse("leaked password in $name", name.contains("secret", ignoreCase = true))
      assertFalse("leaked token in $name", name.contains("token", ignoreCase = true))
      assertFalse("leaked extension in $name", name.contains(".mp4", ignoreCase = true))
    }

    // 3. Return seek inside cached range hits local SimpleCache with 0 extra upstream requests!
    val ds2 = session.dataSourceFactory.createDataSource()
    val backSlice = ByteArray(4096)
    ds2.open(DataSpec.Builder().setUri(Uri.parse(rawUrl)).setPosition(2048L).setLength(4096L).build())
    var readBack = 0
    while (readBack < backSlice.size) {
      val n = ds2.read(backSlice, readBack, backSlice.size - readBack)
      if (n == C.RESULT_END_OF_INPUT) break
      readBack += n
    }
    ds2.close()
    assertEquals(4096, readBack)
    assertArrayEquals(payload.copyOfRange(2048, 2048 + 4096), backSlice)
    assertEquals("cached return seek must incur 0 extra upstream opens", 1, upstream.openCount.get())

    // 4. closeAndDelete is idempotent, zeroes cachedBytes, and deletes sessionDir completely
    session.closeAndDelete()
    session.closeAndDelete()
    assertEquals(0L, session.cachedBytes())
    assertFalse("sessionDir must be deleted after closeAndDelete", session.sessionDir.exists())
  }

  @Test
  fun `closeAndDelete dispatches off the calling thread when using default daemon executor`() {
    val context = RuntimeEnvironment.getApplication()
    val upstream = CountingUpstreamFactory("hello-vod-cache".encodeToByteArray())
    val cleanupThread = AtomicReference<String?>(null)
    val done = CountDownLatch(1)
    val trackingExecutor = Executor { runnable ->
      Thread({
        cleanupThread.set(Thread.currentThread().name)
        try {
          runnable.run()
        } finally {
          done.countDown()
        }
      }, "test-vod-cleanup").start()
    }
    val session = VodEphemeralCache.openSession(
      context = context,
      cacheDir = tempCacheDir,
      budget = enabledBudget(maxDiskBytes = 2 * mib),
      upstreamFactory = upstream,
      cleanupExecutor = trackingExecutor,
    )!!
    val dir = session.sessionDir
    assertTrue(dir.exists())

    session.closeAndDelete()
    assertTrue("cleanup must complete promptly off caller thread", done.await(5, TimeUnit.SECONDS))
    assertEquals("test-vod-cleanup", cleanupThread.get())
    assertFalse("sessionDir must be removed by cleanup executor", dir.exists())
  }

  @Test
  fun `purgeOrphansOnStartup deletes crashed session dirs once without touching later active sessions`() {
    val root = File(tempCacheDir, VOD_CACHE_SUBDIR).apply { mkdirs() }
    val stale1 = File(root, "s-crashed-session-1").apply {
      mkdirs()
      File(this, "chunk.exo").writeText("stale")
    }
    val stale2 = File(root, "s-crashed-session-2").apply { mkdirs() }
    assertTrue(stale1.exists() && stale2.exists())

    assertTrue(VodEphemeralCache.purgeOrphansOnStartup(tempCacheDir))
    assertFalse(stale1.exists())
    assertFalse(stale2.exists())

    // Active session opened after startup purge must not be deleted by a second engine init
    val activeDir = File(root, "s-active-session").apply { mkdirs() }
    assertFalse(VodEphemeralCache.purgeOrphansOnStartup(tempCacheDir))
    assertTrue(activeDir.exists())
  }

  @Test
  fun `usableSpaceBytes returns positive free space on existing dir and 0L safely on invalid path`() {
    assertTrue(VodEphemeralCache.usableSpaceBytes(tempCacheDir) > 0L)
    val missing = File(tempCacheDir, "non-existent/deep/missing/path")
    assertEquals(0L, VodEphemeralCache.usableSpaceBytes(missing))
  }

  @Test
  fun `HTTP 302 redirect strips exo_redir from per-session SQLite index and leaves zero secret bytes on disk`() {
    val context = RuntimeEnvironment.getApplication()
    val payload = ByteArray(12 * 1024) { idx -> ((idx * 17) and 0xFF).toByte() }
    val redirected = Uri.parse("https://secret-cdn.invalid/stream?token=TOPSECRET")
    val upstream = CountingUpstreamFactory(payload, redirectedUri = redirected)
    val syncExecutor = Executor { it.run() }

    val session = VodEphemeralCache.openSession(
      context = context,
      cacheDir = tempCacheDir,
      budget = enabledBudget(maxDiskBytes = 4 * mib),
      upstreamFactory = upstream,
      cleanupExecutor = syncExecutor,
    )!!

    val initialUrl = "https://provider.invalid/movie/1001.mp4"
    val ds = session.dataSourceFactory.createDataSource()
    val buf = ByteArray(payload.size)
    ds.open(DataSpec(Uri.parse(initialUrl)))
    var read = 0
    while (read < buf.size) {
      val n = ds.read(buf, read, buf.size - read)
      if (n == C.RESULT_END_OF_INPUT) break
      read += n
    }
    ds.close()
    assertEquals(payload.size, read)
    assertArrayEquals(payload, buf)

    // Per-session SQLite DB must live inside sessionDir (not shared exoplayer_internal.db)
    val indexDb = File(session.sessionDir, "index.db")
    assertTrue("per-session index.db must exist inside sessionDir", indexDb.exists())

    // Scan EVERY byte of EVERY file in sessionDir (index.db, WAL, SHM, .exo, .uid) for redirected URL/token leaks
    val files = session.sessionDir.walkTopDown().filter { it.isFile }.toList()
    assertTrue("sessionDir must contain cache and index files", files.isNotEmpty())
    for (file in files) {
      val ascii = file.readBytes().toString(Charsets.ISO_8859_1)
      assertFalse("leaked secret-cdn.invalid in ${file.name}", ascii.contains("secret-cdn.invalid", ignoreCase = true))
      assertFalse("leaked TOPSECRET in ${file.name}", ascii.contains("TOPSECRET", ignoreCase = true))
    }

    // Content length metadata is preserved so return seeks still hit cache with 0 upstream opens
    val ds2 = session.dataSourceFactory.createDataSource()
    val slice = ByteArray(2048)
    ds2.open(DataSpec.Builder().setUri(Uri.parse(initialUrl)).setPosition(1024L).setLength(2048L).build())
    var read2 = 0
    while (read2 < slice.size) {
      val n = ds2.read(slice, read2, slice.size - read2)
      if (n == C.RESULT_END_OF_INPUT) break
      read2 += n
    }
    ds2.close()
    assertEquals(2048, read2)
    assertArrayEquals(payload.copyOfRange(1024, 3072), slice)
    assertEquals("return seek after stripped redirect must not re-open upstream", 1, upstream.openCount.get())

    session.closeAndDelete()
    assertFalse("sessionDir including index.db must be deleted atomically", session.sessionDir.exists())
  }

  @Test
  fun `closeAndDelete while wrapped DataSource is open defers release without IllegalStateException and deletes once closed`() {
    val context = RuntimeEnvironment.getApplication()
    val payload = ByteArray(16 * 1024) { idx -> ((idx * 13) and 0xFF).toByte() }
    val upstream = CountingUpstreamFactory(payload)
    val syncExecutor = Executor { it.run() }

    val session = VodEphemeralCache.openSession(
      context = context,
      cacheDir = tempCacheDir,
      budget = enabledBudget(maxDiskBytes = 4 * mib),
      upstreamFactory = upstream,
      cleanupExecutor = syncExecutor,
    )!!

    val url = "https://provider.invalid/movie/race-test.mp4"
    val ds = session.dataSourceFactory.createDataSource()
    ds.open(DataSpec(Uri.parse(url)))

    val firstHalf = ByteArray(4096)
    var read1 = 0
    while (read1 < firstHalf.size) {
      val n = ds.read(firstHalf, read1, firstHalf.size - read1)
      if (n == C.RESULT_END_OF_INPUT) break
      read1 += n
    }
    assertEquals(firstHalf.size, read1)

    // Request teardown while ds is still actively reading
    session.closeAndDelete()
    assertTrue("sessionDir must stay alive while DataSource handle is still open", session.sessionDir.exists())

    // Remaining reads and close() must NOT throw IllegalStateException from SimpleCache
    val rest = ByteArray(payload.size - firstHalf.size)
    var read2 = 0
    while (read2 < rest.size) {
      val n = ds.read(rest, read2, rest.size - read2)
      if (n == C.RESULT_END_OF_INPUT) break
      read2 += n
    }
    ds.close()

    assertEquals(rest.size, read2)
    assertArrayEquals(payload.copyOfRange(0, firstHalf.size), firstHalf)
    assertArrayEquals(payload.copyOfRange(firstHalf.size, payload.size), rest)
    assertFalse("sessionDir must be deleted once last open DataSource closes", session.sessionDir.exists())
  }

  @Test
  fun `closeAndDelete enforces bounded drain timeout if an open DataSource never closes`() {
    val context = RuntimeEnvironment.getApplication()
    val payload = ByteArray(4096) { 0x2A }
    val upstream = CountingUpstreamFactory(payload)
    val cleanedUp = CountDownLatch(1)
    val trackingExecutor = Executor { runnable ->
      runnable.run()
      cleanedUp.countDown()
    }

    val session = VodEphemeralCache.openSession(
      context = context,
      cacheDir = tempCacheDir,
      budget = enabledBudget(maxDiskBytes = 2 * mib),
      upstreamFactory = upstream,
      cleanupExecutor = trackingExecutor,
      drainTimeoutMs = 80L,
    )!!

    val ds = session.dataSourceFactory.createDataSource()
    ds.open(DataSpec(Uri.parse("https://provider.invalid/movie/stuck.mp4")))
    session.closeAndDelete()
    assertTrue("safety drain timeout must release and delete stuck session", cleanedUp.await(3, TimeUnit.SECONDS))
    assertFalse("index.db must be closed and deleted once drain timeout fires", File(session.sessionDir, "index.db").exists())
    runCatching { ds.close() }
    assertFalse("sessionDir must be deleted after drain timeout", session.sessionDir.exists())
  }
}

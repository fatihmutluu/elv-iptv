package io.github.fatihmutluu.elv.media3

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import java.io.File

/**
 * Coordinates per-session VOD adaptive buffer budgets, HTTP `429`/`509` throttle backoff state, and ephemeral disk
 * cache lifecycle on behalf of [Media3Engine] (#350). Live streams never open or retain a VOD disk cache session.
 */
@OptIn(UnstableApi::class)
internal class VodCacheController(
  private val context: Context,
  private val cacheDir: File?,
  private val memoryProfile: DeviceMemoryProfile,
  private val freeDiskBytesProvider: (File) -> Long = VodEphemeralCache::usableSpaceBytes,
) {
  private var activeUrl: String? = null
  private var throttleBackoffLevel: Int = 0
  private var activeBudget: VodBufferBudget? = null
  private var playerVodBudget: VodBufferBudget? = null
  private var activeSession: VodEphemeralCache? = null

  /** Sweeps crashed VOD cache orphan directories once per process startup. */
  fun purgeOrphansOnStartup() {
    cacheDir?.let { VodEphemeralCache.purgeOrphansOnStartup(it) }
  }

  /** Resets per-session throttle backoff whenever the requested playback URL changes. */
  fun onLoadUrl(url: String) {
    if (activeUrl != url) {
      activeUrl = url
      throttleBackoffLevel = 0
    }
  }

  /** Escalates VOD throttle backoff on HTTP `429` or `509` responses during VOD playback. */
  fun onHttpError(live: Boolean, httpStatus: Int?) {
    if (!live && httpStatus != null) {
      throttleBackoffLevel = nextThrottleBackoffLevel(throttleBackoffLevel, httpStatus)
    }
  }

  /** Computes and optionally records the active [VodBufferBudget] for a prepare. */
  fun computeBudget(
    streamKind: StreamKind,
    preset: BufferPreset,
    multiViewTileCount: Int,
    recordActive: Boolean = true,
  ): VodBufferBudget {
    val freeDisk = cacheDir?.let(freeDiskBytesProvider)
    return computeVodBufferBudget(
      streamKind = streamKind,
      preset = preset,
      isLowRamDevice = memoryProfile.isLowRamDevice,
      totalMemBytes = memoryProfile.totalMemBytes,
      freeDiskBytes = freeDisk,
      multiViewTileCount = multiViewTileCount,
      throttleBackoffLevel = throttleBackoffLevel,
    ).also { budget ->
      if (recordActive) activeBudget = budget.takeIf { it.enabled }
    }
  }

  /** Returns `true` when [ExoPlayer]'s `DefaultLoadControl` must be rebuilt to match [budget]. */
  fun needsPlayerRebuild(streamKind: StreamKind, budget: VodBufferBudget): Boolean {
    if (streamKind != StreamKind.VOD || !budget.enabled) return false
    val current = playerVodBudget ?: return true
    return current.forwardTargetMs != budget.forwardTargetMs ||
      current.minBufferMs != budget.minBufferMs ||
      current.backTargetMs != budget.backTargetMs ||
      current.maxMemoryBytes != budget.maxMemoryBytes ||
      current.prioritizeTimeOverSize != budget.prioritizeTimeOverSize
  }

  /** Records the VOD budget applied when building the active [ExoPlayer] instance. */
  fun recordPlayerBuilt(streamKind: StreamKind, budget: VodBufferBudget?) {
    playerVodBudget = if (streamKind == StreamKind.VOD && budget?.enabled == true) budget else null
  }

  /**
   * Tears down any previous ephemeral VOD cache and opens a fresh session strictly for [StreamKind.VOD] when
   * [budget.allowDiskCache] is true. Live streams always return `null`.
   */
  fun openForPrepare(streamKind: StreamKind, budget: VodBufferBudget): VodEphemeralCache? {
    tearDownSession()
    if (streamKind != StreamKind.VOD || !budget.enabled || !budget.allowDiskCache) return null
    val dir = cacheDir ?: return null
    val session = VodEphemeralCache.openSession(
      context = context,
      cacheDir = dir,
      budget = budget,
      upstreamFactory = DataSource.Factory {
        throw IllegalStateException("Use VodEphemeralCache.wrapUpstream() for gated upstream sources")
      },
    )
    activeSession = session
    return session
  }

  /** Returns the configured VOD back-buffer duration in milliseconds, or `0L` when inactive. */
  fun activeBackBufferMs(): Long = activeBudget?.backTargetMs?.toLong() ?: 0L

  /** Returns `(diskCacheBytes, throttled)` telemetry for VOD `ClockAnchor` reporting, or `null` when inactive. */
  fun healthSnapshot(): Pair<Long, Boolean>? {
    val budget = activeBudget ?: return null
    val diskBytes = activeSession?.cachedBytes() ?: 0L
    val throttled = budget.throttleBackoffLevel > 0 || throttleBackoffLevel > 0
    return diskBytes to throttled
  }

  /** Tears down and deletes any active ephemeral VOD cache session, optionally resetting throttle backoff state. */
  fun tearDown(resetThrottle: Boolean = false) {
    tearDownSession()
    activeBudget = null
    if (resetThrottle) {
      activeUrl = null
      throttleBackoffLevel = 0
    }
  }

  internal val throttleBackoffLevelForTest: Int
    get() = throttleBackoffLevel

  internal val activeSessionForTest: VodEphemeralCache?
    get() = activeSession

  private fun tearDownSession() {
    val existing = activeSession ?: return
    activeSession = null
    existing.closeAndDelete()
  }
}

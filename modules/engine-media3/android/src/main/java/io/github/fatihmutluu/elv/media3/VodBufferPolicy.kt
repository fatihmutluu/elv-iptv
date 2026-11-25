package io.github.fatihmutluu.elv.media3

import java.security.MessageDigest
import kotlin.math.roundToInt
import kotlin.math.roundToLong

private const val MIB = 1024L * 1024L
private const val MULTIVIEW_MIN_MEMORY_BYTES = 8L * MIB
private const val RAM_TIER_FLOOR_BYTES = 1536L * MIB
private const val RAM_TIER_CEILING_BYTES = 8192L * MIB
private const val RAM_BUFFER_DIVISOR = 18L

internal const val VOD_LOW_RAM_MAX_MEMORY_BYTES = 16L * MIB
internal const val VOD_LOW_RAM_MAX_DISK_BYTES = 32L * MIB
internal const val VOD_MIN_FREE_DISK_BYTES = 512L * MIB
internal const val VOD_MAX_DISK_BYTES = 512L * MIB
internal const val VOD_MAX_FREE_DISK_RATIO = 0.10
internal const val VOD_MAX_THROTTLE_BACKOFF = 3
internal const val VOD_MIN_FORWARD_TARGET_MS = 15_000
internal const val VOD_LOW_RAM_MAX_FORWARD_MS = 30_000
internal const val VOD_LOW_RAM_MAX_BACK_MS = 8_000

private val HEX_DIGITS = "0123456789abcdef".toCharArray()

/**
 * Adaptive VOD read-ahead, back-buffer, and ephemeral disk cache budget mirrored from `@elv/playback` (#350).
 * Live streams always receive a disabled budget (`enabled = false`, `allowDiskCache = false`, `maxDiskBytes = 0L`).
 */
data class VodBufferBudget(
  val enabled: Boolean,
  val forwardTargetMs: Int,
  val minBufferMs: Int,
  val backTargetMs: Int,
  val maxMemoryBytes: Long,
  val maxDiskBytes: Long,
  val allowDiskCache: Boolean,
  val throttleBackoffLevel: Int,
  val prioritizeTimeOverSize: Boolean,
)

/** True when [httpStatus] indicates upstream rate limiting / bandwidth throttling (`429` or `509`). */
fun isVodThrottleStatus(httpStatus: Int?): Boolean = httpStatus == 429 || httpStatus == 509

/**
 * Advances VOD throttle backoff level on HTTP `429` or `509`, strictly clamped to `0..3` (#350).
 * Non-throttle statuses preserve the clamped current level.
 */
fun nextThrottleBackoffLevel(current: Int, httpStatus: Int): Int {
  val clamped = current.coerceIn(0, VOD_MAX_THROTTLE_BACKOFF)
  return if (isVodThrottleStatus(httpStatus)) {
    (clamped + 1).coerceAtMost(VOD_MAX_THROTTLE_BACKOFF)
  } else {
    clamped
  }
}

/**
 * Computes a deterministic, device-safe adaptive VOD buffer budget (#350):
 * - Live streams (`RAW_TS_LIVE`, `HLS_LIVE`) always return a disabled budget with zero disk spill.
 * - Low-RAM devices (`isLowRamDevice` or `< 1.5 GiB`) stay capped at `<= 16 MiB` RAM, `prioritizeTimeOverSize = false`,
 *   conservative durations (`<= 30 s` forward, `<= 8 s` back), and `<= 32 MiB` disk spill.
 * - Disk spill requires `freeDiskBytes >= 512 MiB`, single-tile playback (`multiViewTileCount == 1`), and
 *   `throttleBackoffLevel < 2`, capped strictly at `min(presetDiskCap, floor(freeDiskBytes * 0.10), 512 MiB)`.
 */
fun computeVodBufferBudget(
  streamKind: StreamKind,
  preset: BufferPreset = BufferPreset.AUTO,
  isLowRamDevice: Boolean,
  totalMemBytes: Long,
  freeDiskBytes: Long?,
  multiViewTileCount: Int = MIN_MULTIVIEW_TILES,
  throttleBackoffLevel: Int = 0,
): VodBufferBudget {
  if (streamKind != StreamKind.VOD) {
    return VodBufferBudget(
      enabled = false,
      forwardTargetMs = 0,
      minBufferMs = 0,
      backTargetMs = 0,
      maxMemoryBytes = 0L,
      maxDiskBytes = 0L,
      allowDiskCache = false,
      throttleBackoffLevel = 0,
      prioritizeTimeOverSize = false,
    )
  }

  val backoff = throttleBackoffLevel.coerceIn(0, VOD_MAX_THROTTLE_BACKOFF)
  val divisor = 1 shl backoff
  val tiles = clampMultiViewTileCount(multiViewTileCount)
  val safeMem = totalMemBytes.coerceAtLeast(0L)
  val lowRam = isLowRam(isLowRamDevice, safeMem)
  val diskAllowedBase =
    freeDiskBytes != null &&
      freeDiskBytes >= VOD_MIN_FREE_DISK_BYTES &&
      tiles <= 1 &&
      backoff < 2
  val tenPercentDisk = if (freeDiskBytes != null && freeDiskBytes > 0L) {
    (freeDiskBytes.toDouble() * VOD_MAX_FREE_DISK_RATIO).toLong().coerceAtLeast(0L)
  } else {
    0L
  }

  if (lowRam) {
    val memBytes = if (tiles > 1) {
      (VOD_LOW_RAM_MAX_MEMORY_BYTES / tiles).coerceAtLeast(MULTIVIEW_MIN_MEMORY_BYTES)
    } else {
      VOD_LOW_RAM_MAX_MEMORY_BYTES
    }
    val rawForwardMs = when {
      tiles >= 3 -> 16_000
      tiles == 2 -> 24_000
      else -> VOD_LOW_RAM_MAX_FORWARD_MS
    }
    val forwardMs = (rawForwardMs / divisor).coerceAtLeast(VOD_MIN_FORWARD_TARGET_MS)
    val minMs = (forwardMs / 2).coerceIn(8_000, 60_000).coerceAtMost(forwardMs)
    val rawBackMs = when {
      tiles >= 3 -> 3_000
      tiles == 2 -> 5_000
      else -> VOD_LOW_RAM_MAX_BACK_MS
    }
    val backFloor = if (tiles > 1) 3_000 else 4_000
    val backMs = (rawBackMs / divisor).coerceAtLeast(backFloor).coerceAtMost(rawBackMs)
    val maxDiskBytes = if (diskAllowedBase) {
      minOf(VOD_LOW_RAM_MAX_DISK_BYTES / divisor, tenPercentDisk, VOD_MAX_DISK_BYTES).coerceAtLeast(0L)
    } else {
      0L
    }
    return VodBufferBudget(
      enabled = true,
      forwardTargetMs = forwardMs,
      minBufferMs = minMs,
      backTargetMs = backMs,
      maxMemoryBytes = memBytes,
      maxDiskBytes = maxDiskBytes,
      allowDiskCache = maxDiskBytes > 0L,
      throttleBackoffLevel = backoff,
      prioritizeTimeOverSize = false,
    )
  }

  val ramFactor = ((safeMem - RAM_TIER_FLOOR_BYTES).toDouble() / (RAM_TIER_CEILING_BYTES - RAM_TIER_FLOOR_BYTES).toDouble())
    .coerceIn(0.0, 1.0)
  val proportionalMem = safeMem / RAM_BUFFER_DIVISOR
  val baseForward: Int
  val baseBack: Int
  val baseDisk: Long
  val baseMem: Long
  when (preset) {
    BufferPreset.AUTO -> {
      baseForward = lerpInt(45_000, 120_000, ramFactor)
      baseBack = lerpInt(12_000, 30_000, ramFactor)
      baseDisk = lerpLong(64L * MIB, 192L * MIB, ramFactor)
      baseMem = proportionalMem.coerceIn(16L * MIB, 96L * MIB)
    }
    BufferPreset.BALANCED -> {
      baseForward = lerpInt(60_000, 150_000, ramFactor)
      baseBack = lerpInt(15_000, 45_000, ramFactor)
      baseDisk = lerpLong(96L * MIB, 256L * MIB, ramFactor)
      baseMem = proportionalMem.coerceIn(32L * MIB, 96L * MIB)
    }
    BufferPreset.LARGE -> {
      baseForward = lerpInt(90_000, 240_000, ramFactor)
      baseBack = lerpInt(20_000, 60_000, ramFactor)
      baseDisk = lerpLong(128L * MIB, 512L * MIB, ramFactor)
      baseMem = proportionalMem.coerceIn(64L * MIB, 128L * MIB)
    }
  }

  val memBytes = if (tiles > 1) {
    (baseMem / tiles).coerceAtLeast(MULTIVIEW_MIN_MEMORY_BYTES)
  } else {
    baseMem
  }
  val rawForwardMs = if (tiles > 1) {
    minOf(baseForward, if (tiles >= 3) 16_000 else 24_000)
  } else {
    baseForward
  }
  val rawBackMs = if (tiles > 1) {
    minOf(baseBack, if (tiles >= 3) 3_000 else 5_000)
  } else {
    baseBack
  }
  val forwardMs = (rawForwardMs / divisor).coerceAtLeast(VOD_MIN_FORWARD_TARGET_MS)
  val minMs = (forwardMs / 2).coerceIn(8_000, 60_000).coerceAtMost(forwardMs)
  val backFloor = if (tiles > 1) 3_000 else 5_000
  val backMs = (rawBackMs / divisor).coerceAtLeast(backFloor).coerceAtMost(rawBackMs)
  val maxDiskBytes = if (diskAllowedBase) {
    minOf(baseDisk / divisor, tenPercentDisk, VOD_MAX_DISK_BYTES).coerceAtLeast(0L)
  } else {
    0L
  }
  return VodBufferBudget(
    enabled = true,
    forwardTargetMs = forwardMs,
    minBufferMs = minMs,
    backTargetMs = backMs,
    maxMemoryBytes = memBytes,
    maxDiskBytes = maxDiskBytes,
    allowDiskCache = maxDiskBytes > 0L,
    throttleBackoffLevel = backoff,
    prioritizeTimeOverSize = tiles <= 1 && backoff == 0,
  )
}

/**
 * Produces a lowercase 64-character SHA-256 hex digest for VOD cache keys so raw URLs, hostnames, credentials, and
 * query tokens never appear in cache keys or on disk (#350).
 */
fun hashVodCacheKey(rawKey: String): String {
  val digest = MessageDigest.getInstance("SHA-256").digest(rawKey.toByteArray(Charsets.UTF_8))
  val out = CharArray(digest.size * 2)
  for (i in digest.indices) {
    val v = digest[i].toInt() and 0xFF
    out[i * 2] = HEX_DIGITS[v ushr 4]
    out[i * 2 + 1] = HEX_DIGITS[v and 0x0F]
  }
  return String(out)
}

/**
 * Applies an enabled [VodBufferBudget] onto [base] [LoadControlValues] while preserving all ExoPlayer
 * `DefaultLoadControl` invariants and never violating a low-RAM `<= 16 MiB` ceiling (#350).
 */
fun applyVodBudgetToLoadControl(base: LoadControlValues, budget: VodBufferBudget): LoadControlValues {
  if (!budget.enabled) return base
  val floorMinMs = maxOf(base.bufferForPlaybackMs, base.bufferForPlaybackAfterRebufferMs)
  val maxMs = budget.forwardTargetMs.coerceAtLeast(floorMinMs)
  val minMs = budget.minBufferMs.coerceIn(floorMinMs, maxMs)
  val backMs = budget.backTargetMs.coerceAtLeast(0)
  val lowRamCap = VOD_LOW_RAM_MAX_MEMORY_BYTES.toInt()
  val budgetMemBytes = budget.maxMemoryBytes
    .coerceIn(MULTIVIEW_MIN_MEMORY_BYTES, Int.MAX_VALUE.toLong())
    .toInt()
  val isBaseLowRam = !base.prioritizeTimeOverSizeThresholds && base.targetBufferBytes <= lowRamCap
  val targetBytes = if (isBaseLowRam) {
    minOf(base.targetBufferBytes, budgetMemBytes, lowRamCap)
  } else {
    budgetMemBytes
  }
  val prioritizeTime = if (isBaseLowRam) false else budget.prioritizeTimeOverSize
  return base.copy(
    minBufferMs = minMs,
    maxBufferMs = maxMs,
    targetBufferBytes = targetBytes,
    backBufferMs = backMs,
    retainBackBufferFromKeyframe = backMs > 0,
    prioritizeTimeOverSizeThresholds = prioritizeTime,
  )
}

private fun lerpInt(min: Int, max: Int, factor: Double): Int =
  (min + (max - min) * factor).roundToInt().coerceIn(min, max)

private fun lerpLong(min: Long, max: Long, factor: Double): Long =
  (min + (max - min).toDouble() * factor).roundToLong().coerceIn(min, max)

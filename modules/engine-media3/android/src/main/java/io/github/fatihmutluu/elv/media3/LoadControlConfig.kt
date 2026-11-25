package io.github.fatihmutluu.elv.media3

import java.util.Locale

private const val MIB = 1024 * 1024
private const val LOW_RAM_TOTAL_BYTES = 1536L * MIB
private const val LOW_RAM_TARGET_BYTES = 16 * MIB
private const val MULTIVIEW_MIN_TARGET_BYTES = 8 * MIB
const val MIN_MULTIVIEW_TILES = 1
const val MAX_MULTIVIEW_TILES = 4
private const val AUTO_MIN_TARGET_BYTES = 16L * MIB
private const val AUTO_MAX_TARGET_BYTES = 96L * MIB
private const val BALANCED_MIN_TARGET_BYTES = 32L * MIB
private const val BALANCED_MAX_TARGET_BYTES = 96L * MIB
private const val LARGE_MIN_TARGET_BYTES = 64L * MIB
private const val LARGE_MAX_TARGET_BYTES = 128L * MIB
private const val RAM_BUFFER_DIVISOR = 18L

private const val REBUFFER_MS_STANDARD = 2_500
private const val REBUFFER_MS_LOW_RAM = 3_500

/** User-selectable buffer size preset (#147). */
enum class BufferPreset(val wireName: String) {
  AUTO("auto"),
  BALANCED("balanced"),
  LARGE("large"),
}

/** Parses a wire buffer preset name (case-insensitive), falling back to [BufferPreset.AUTO]. */
fun parseBufferPreset(raw: String?): BufferPreset =
  when (raw?.trim()?.lowercase(Locale.ROOT)) {
    BufferPreset.BALANCED.wireName -> BufferPreset.BALANCED
    BufferPreset.LARGE.wireName -> BufferPreset.LARGE
    else -> BufferPreset.AUTO
  }

/** Playback stream profile used to size `DefaultLoadControl` (#147). */
enum class StreamKind {
  RAW_TS_LIVE,
  HLS_LIVE,
  VOD,
}

/**
 * Buffer bounds for `DefaultLoadControl` (#127, #147, #150, #262, #307, #422):
 * - Low-RAM (`< 1.5 GiB` or `isLowRamDevice`) strictly caps memory at `16 MiB` (`prioritizeTimeOverSizeThresholds = false`)
 *   across every [BufferPreset].
 * - Non-low-RAM scales `targetBufferBytes` proportionally (`totalMemBytes / 18`, clamped per preset).
 * - Non-seekable live streams (`RAW_TS_LIVE`, `HLS_LIVE`) drop back-buffer RAM (`backBufferMs = 0`,
 *   `retainBackBufferFromKeyframe = false`); `RAW_TS_LIVE` keeps a lean startup buffer (`750 ms`).
 * - Raised `bufferForPlaybackAfterRebufferMs` (`3_500 ms` low-RAM / `2_500 ms` standard) damps rebuffer oscillation.
 */
data class LoadControlValues(
  val minBufferMs: Int,
  val maxBufferMs: Int,
  val bufferForPlaybackMs: Int,
  val bufferForPlaybackAfterRebufferMs: Int,
  val targetBufferBytes: Int,
  val backBufferMs: Int = 12_000,
  val retainBackBufferFromKeyframe: Boolean = true,
  val prioritizeTimeOverSizeThresholds: Boolean = true,
)

/** A device is low-RAM when Android reports `isLowRamDevice` or its total memory is under 1.5 GB. */
fun isLowRam(isLowRamDevice: Boolean, totalMemBytes: Long): Boolean =
  isLowRamDevice || totalMemBytes < LOW_RAM_TOTAL_BYTES

/** Clamps a Multi-View tile count into the supported `[1, 4]` range (`#34`). */
fun clampMultiViewTileCount(tileCount: Int): Int =
  tileCount.coerceIn(MIN_MULTIVIEW_TILES, MAX_MULTIVIEW_TILES)

/** Initial or updated Multi-View engine configuration (`#34`, `#221`). */
data class MultiViewEngineOptions(
  val handleAudioFocus: Boolean = true,
  val multiViewTileCount: Int = MIN_MULTIVIEW_TILES,
)

/** Parses optional JS Multi-View engine options (`handleAudioFocus`, `multiViewTileCount`) with safe clamping. */
internal fun parseMultiViewEngineOptions(raw: Map<String, Any?>?): MultiViewEngineOptions {
  if (raw == null) return MultiViewEngineOptions()
  val handleAudioFocus = raw["handleAudioFocus"] as? Boolean ?: true
  val rawCount = (raw["multiViewTileCount"] as? Number)?.toDouble()
  val tileCount = if (rawCount != null && rawCount.isFinite()) {
    clampMultiViewTileCount(rawCount.toInt())
  } else {
    MIN_MULTIVIEW_TILES
  }
  return MultiViewEngineOptions(
    handleAudioFocus = handleAudioFocus,
    multiViewTileCount = tileCount,
  )
}

/**
 * Scales a single-tile [LoadControlValues] profile for simultaneous Multi-View decoders (`#34`):
 * divides `targetBufferBytes` by clamped `tileCount` (floored at `8 MiB`), disables time-over-size priority,
 * and caps live/VOD buffer durations conservatively while preserving ExoPlayer invariants.
 */
internal fun scaleLoadControlForMultiView(
  base: LoadControlValues,
  streamKind: StreamKind,
  multiViewTileCount: Int,
): LoadControlValues {
  val tiles = clampMultiViewTileCount(multiViewTileCount)
  if (tiles <= 1) return base
  val scaledBytes = (base.targetBufferBytes / tiles).coerceAtLeast(MULTIVIEW_MIN_TARGET_BYTES)
  val floorMinMs = maxOf(base.bufferForPlaybackMs, base.bufferForPlaybackAfterRebufferMs)
  val (capMinMs, capMaxMs, capBackMs) = when (streamKind) {
    StreamKind.RAW_TS_LIVE -> if (tiles >= 3) Triple(6_000, 12_000, 0) else Triple(8_000, 15_000, 0)
    StreamKind.HLS_LIVE -> if (tiles >= 3) Triple(8_000, 15_000, 0) else Triple(10_000, 20_000, 0)
    StreamKind.VOD -> if (tiles >= 3) Triple(8_000, 16_000, 3_000) else Triple(12_000, 24_000, 5_000)
  }
  val minMs = minOf(base.minBufferMs, capMinMs).coerceAtLeast(floorMinMs)
  val maxMs = minOf(base.maxBufferMs, capMaxMs).coerceAtLeast(minMs)
  val backMs = minOf(base.backBufferMs, capBackMs).coerceAtLeast(0)
  return base.copy(
    minBufferMs = minMs,
    maxBufferMs = maxMs,
    targetBufferBytes = scaledBytes,
    backBufferMs = backMs,
    retainBackBufferFromKeyframe = backMs > 0 && base.retainBackBufferFromKeyframe,
    prioritizeTimeOverSizeThresholds = false,
  )
}

/**
 * Stream-type and RAM-proportional load control profile (#147, #150, #262, #422, #34).
 * Low-RAM devices are always capped at `16 MiB` (or `8 MiB` floor when [multiViewTileCount] > 1) with
 * `prioritizeTimeOverSizeThresholds = false` regardless of [preset].
 */
fun loadControlForStream(
  isLowRamDevice: Boolean,
  totalMemBytes: Long,
  streamKind: StreamKind,
  preset: BufferPreset = BufferPreset.AUTO,
  multiViewTileCount: Int = MIN_MULTIVIEW_TILES,
): LoadControlValues {
  val lowRam = isLowRam(isLowRamDevice, totalMemBytes)
  val targetBytes = targetBufferBytesFor(lowRam, totalMemBytes, preset)
  val afterRebufferMs = if (lowRam) REBUFFER_MS_LOW_RAM else REBUFFER_MS_STANDARD
  val base = when (streamKind) {
    StreamKind.RAW_TS_LIVE -> {
      val (minMs, maxMs) = when {
        lowRam -> 10_000 to 20_000
        preset == BufferPreset.LARGE -> 20_000 to 40_000
        preset == BufferPreset.BALANCED -> 15_000 to 30_000
        else -> 12_000 to 25_000
      }
      LoadControlValues(
        minBufferMs = minMs,
        maxBufferMs = maxMs,
        bufferForPlaybackMs = 750,
        bufferForPlaybackAfterRebufferMs = afterRebufferMs,
        targetBufferBytes = targetBytes,
        backBufferMs = 0,
        retainBackBufferFromKeyframe = false,
        prioritizeTimeOverSizeThresholds = !lowRam,
      )
    }
    StreamKind.HLS_LIVE -> {
      val (minMs, maxMs) = when {
        lowRam -> 10_000 to 20_000
        preset == BufferPreset.LARGE -> 30_000 to 60_000
        preset == BufferPreset.BALANCED -> 20_000 to 40_000
        else -> 15_000 to 30_000
      }
      LoadControlValues(
        minBufferMs = minMs,
        maxBufferMs = maxMs,
        bufferForPlaybackMs = 1_000,
        bufferForPlaybackAfterRebufferMs = afterRebufferMs,
        targetBufferBytes = targetBytes,
        backBufferMs = 0,
        retainBackBufferFromKeyframe = false,
        prioritizeTimeOverSizeThresholds = !lowRam,
      )
    }
    StreamKind.VOD -> {
      val (minMs, maxMs, backMs) = when {
        lowRam -> Triple(15_000, 30_000, 5_000)
        preset == BufferPreset.LARGE -> Triple(45_000, 90_000, 20_000)
        preset == BufferPreset.BALANCED -> Triple(25_000, 50_000, 15_000)
        else -> Triple(15_000, 30_000, 12_000)
      }
      LoadControlValues(
        minBufferMs = minMs,
        maxBufferMs = maxMs,
        bufferForPlaybackMs = 1_000,
        bufferForPlaybackAfterRebufferMs = afterRebufferMs,
        targetBufferBytes = targetBytes,
        backBufferMs = backMs,
        retainBackBufferFromKeyframe = true,
        prioritizeTimeOverSizeThresholds = !lowRam,
      )
    }
  }
  return scaleLoadControlForMultiView(base, streamKind, multiViewTileCount)
}

/** Backward-compatible load control values for low-RAM vs standard tiers, split by [live] vs VOD (#422). */
fun loadControlFor(lowRam: Boolean, live: Boolean = false): LoadControlValues =
  loadControlForStream(
    isLowRamDevice = lowRam,
    totalMemBytes = if (lowRam) 1024L * MIB else 2048L * MIB,
    streamKind = if (live) StreamKind.HLS_LIVE else StreamKind.VOD,
    preset = BufferPreset.AUTO,
  )

/** Backward-compatible memory-scaled load control values split by [live] vs VOD (#262, #422). */
fun loadControlForMemory(
  isLowRamDevice: Boolean,
  totalMemBytes: Long,
  live: Boolean = false,
): LoadControlValues =
  loadControlForStream(
    isLowRamDevice = isLowRamDevice,
    totalMemBytes = totalMemBytes,
    streamKind = if (live) StreamKind.HLS_LIVE else StreamKind.VOD,
    preset = BufferPreset.AUTO,
  )

private fun targetBufferBytesFor(lowRam: Boolean, totalMemBytes: Long, preset: BufferPreset): Int {
  if (lowRam) return LOW_RAM_TARGET_BYTES
  val proportional = (totalMemBytes.coerceAtLeast(0L) / RAM_BUFFER_DIVISOR)
  return when (preset) {
    BufferPreset.AUTO -> proportional.coerceIn(AUTO_MIN_TARGET_BYTES, AUTO_MAX_TARGET_BYTES).toInt()
    BufferPreset.BALANCED -> proportional.coerceIn(BALANCED_MIN_TARGET_BYTES, BALANCED_MAX_TARGET_BYTES).toInt()
    BufferPreset.LARGE -> proportional.coerceIn(LARGE_MIN_TARGET_BYTES, LARGE_MAX_TARGET_BYTES).toInt()
  }
}

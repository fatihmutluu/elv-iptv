package io.github.fatihmutluu.elv.media3

import java.util.Locale

private const val MIB = 1024 * 1024
private const val LOW_RAM_TOTAL_BYTES = 1536L * MIB
private const val LOW_RAM_TARGET_BYTES = 16 * MIB
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

/**
 * Stream-type and RAM-proportional load control profile (#147, #150, #262, #422).
 * Low-RAM devices are always capped at `16 MiB` with `prioritizeTimeOverSizeThresholds = false` regardless of [preset].
 */
fun loadControlForStream(
  isLowRamDevice: Boolean,
  totalMemBytes: Long,
  streamKind: StreamKind,
  preset: BufferPreset = BufferPreset.AUTO,
): LoadControlValues {
  val lowRam = isLowRam(isLowRamDevice, totalMemBytes)
  val targetBytes = targetBufferBytesFor(lowRam, totalMemBytes, preset)
  val afterRebufferMs = if (lowRam) REBUFFER_MS_LOW_RAM else REBUFFER_MS_STANDARD
  return when (streamKind) {
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

package io.github.fatihmutluu.elv.media3

private const val MIB = 1024 * 1024
private const val LOW_RAM_TOTAL_BYTES = 1536L * MIB
private const val HIGH_RAM_TOTAL_BYTES = 4096L * MIB

/**
 * Buffer bounds for `DefaultLoadControl` (#127, #262, #307, #422):
 * - Low-RAM enforces the `16 MiB` byte cap strictly (`prioritizeTimeOverSizeThresholds = false`).
 * - Live drops back-buffer RAM (`backBufferMs = 0`, `retainBackBufferFromKeyframe = false`) and tightens low-RAM bounds.
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

/** Load control values for low-RAM (`16 MiB` hard cap) vs standard (`32 MiB`) tiers, split by [live] vs VOD (#422). */
fun loadControlFor(lowRam: Boolean, live: Boolean = false): LoadControlValues =
  buildLoadControlValues(
    lowRam = lowRam,
    live = live,
    targetMib = if (lowRam) 16 else 32,
  )

/** Memory-tiered load control values (`16 MiB` `< 1.5 GiB`, `32 MiB` `1.5–4 GiB`, `48 MiB` `>= 4 GiB`, #262, #422). */
fun loadControlForMemory(
  isLowRamDevice: Boolean,
  totalMemBytes: Long,
  live: Boolean = false,
): LoadControlValues {
  val lowRam = isLowRam(isLowRamDevice, totalMemBytes)
  val targetMib = when {
    lowRam -> 16
    totalMemBytes >= HIGH_RAM_TOTAL_BYTES -> 48
    else -> 32
  }
  return buildLoadControlValues(lowRam = lowRam, live = live, targetMib = targetMib)
}

private fun buildLoadControlValues(lowRam: Boolean, live: Boolean, targetMib: Int): LoadControlValues =
  LoadControlValues(
    minBufferMs = if (live && lowRam) 10_000 else 15_000,
    maxBufferMs = if (live && lowRam) 20_000 else 30_000,
    bufferForPlaybackMs = 1_000,
    bufferForPlaybackAfterRebufferMs = 2_000,
    targetBufferBytes = targetMib * MIB,
    backBufferMs = if (live) 0 else if (lowRam) 5_000 else 12_000,
    retainBackBufferFromKeyframe = !live,
    prioritizeTimeOverSizeThresholds = !lowRam,
  )

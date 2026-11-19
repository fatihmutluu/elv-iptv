package io.github.fatihmutluu.elv.media3

private const val MIB = 1024 * 1024
private const val LOW_RAM_TOTAL_BYTES = 1536L * MIB
private const val HIGH_RAM_TOTAL_BYTES = 4096L * MIB

/** Buffer bounds for `DefaultLoadControl`; time thresholds take priority over byte caps (#127, #262, #307). */
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

/** Load control values for low-RAM (`16 MiB`, `5 s` back-buffer) vs standard (`32 MiB`, `12 s` back-buffer) tiers. */
fun loadControlFor(lowRam: Boolean): LoadControlValues =
  buildLoadControlValues(
    targetMib = if (lowRam) 16 else 32,
    backBufferMs = if (lowRam) 5_000 else 12_000,
  )

/** Memory-tiered load control values (`16 MiB` `< 1.5 GiB`, `32 MiB` `1.5–4 GiB`, `48 MiB` `>= 4 GiB`, #262). */
fun loadControlForMemory(isLowRamDevice: Boolean, totalMemBytes: Long): LoadControlValues =
  when {
    isLowRam(isLowRamDevice, totalMemBytes) -> buildLoadControlValues(targetMib = 16, backBufferMs = 5_000)
    totalMemBytes >= HIGH_RAM_TOTAL_BYTES -> buildLoadControlValues(targetMib = 48, backBufferMs = 12_000)
    else -> buildLoadControlValues(targetMib = 32, backBufferMs = 12_000)
  }

private fun buildLoadControlValues(targetMib: Int, backBufferMs: Int): LoadControlValues =
  LoadControlValues(
    minBufferMs = 15_000,
    maxBufferMs = 30_000,
    bufferForPlaybackMs = 1_000,
    bufferForPlaybackAfterRebufferMs = 2_000,
    targetBufferBytes = targetMib * MIB,
    backBufferMs = backBufferMs,
    retainBackBufferFromKeyframe = true,
    prioritizeTimeOverSizeThresholds = true,
  )

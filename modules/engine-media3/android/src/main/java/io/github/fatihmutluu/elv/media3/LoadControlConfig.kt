package io.github.fatihmutluu.elv.media3

private const val MIB = 1024 * 1024
private const val LOW_RAM_TOTAL_BYTES = 1536L * MIB

/** Buffer bounds for `DefaultLoadControl`; durations and the byte target both apply. */
data class LoadControlValues(
  val minBufferMs: Int,
  val maxBufferMs: Int,
  val bufferForPlaybackMs: Int,
  val bufferForPlaybackAfterRebufferMs: Int,
  val targetBufferBytes: Int,
)

/** A device is low-RAM when Android reports `isLowRamDevice` or its total memory is under 1.5 GB. */
fun isLowRam(isLowRamDevice: Boolean, totalMemBytes: Long): Boolean =
  isLowRamDevice || totalMemBytes < LOW_RAM_TOTAL_BYTES

/** Load control start values of player core spec 6.1: 16 MB target on low-RAM devices, 32 MB otherwise. */
fun loadControlFor(lowRam: Boolean): LoadControlValues =
  LoadControlValues(
    minBufferMs = 15_000,
    maxBufferMs = 30_000,
    bufferForPlaybackMs = 1_000,
    bufferForPlaybackAfterRebufferMs = 2_000,
    targetBufferBytes = (if (lowRam) 16 else 32) * MIB,
  )

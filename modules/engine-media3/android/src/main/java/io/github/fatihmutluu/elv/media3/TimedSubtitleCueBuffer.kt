package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi

/**
 * Bounded, non-flushing subtitle cue buffer supporting live subtitle timing offsets (`#203`, `#59`).
 *
 * Emitted cue snapshots are stored monotonically by presentation timestamp (`maxEntries = 128`, dropping
 * oldest on overflow). Adjusting [setDelayMs] clamps to `[-30_000, 30_000]` ms and NEVER clears already
 * buffered cues so mid-playback timing adjustments shift visible subtitles without blanking the screen.
 */
@OptIn(UnstableApi::class)
internal class TimedSubtitleCueBuffer(
  private val maxEntries: Int = DEFAULT_MAX_ENTRIES,
) {
  init {
    require(maxEntries > 0) { "maxEntries must be positive" }
  }

  internal data class Entry(
    val presentationTimeUs: Long,
    val cues: List<Cue>,
  )

  private val entries = ArrayDeque<Entry>()

  /** Current clamped subtitle delay in milliseconds (`[-30_000, 30_000]`). */
  var delayMs: Long = 0L
    private set

  /** Current clamped subtitle delay in microseconds. */
  val delayUs: Long
    get() = delayMs * 1_000L

  /** Number of cue snapshots currently retained in the bounded queue. */
  val size: Int
    get() = entries.size

  /** True when at least one cue snapshot is retained. */
  val isNotEmpty: Boolean
    get() = entries.isNotEmpty()

  /** Clamps and applies [delayMs] in `[-30_000, 30_000]` ms without clearing buffered cues. */
  fun setDelayMs(delayMs: Long) {
    this.delayMs = clampSyncDelayMs(delayMs)
  }

  /**
   * Records a cue snapshot at [presentationTimeUs] (clamped `>= 0`). Duplicate or regressive timestamps
   * overwrite/trim newer tail entries to preserve strict monotonic ordering; overflows drop the oldest entry.
   */
  fun record(presentationTimeUs: Long, cues: List<Cue>) {
    val timeUs = presentationTimeUs.coerceAtLeast(0L)
    while (entries.isNotEmpty() && entries.last().presentationTimeUs >= timeUs) {
      entries.removeLast()
    }
    entries.addLast(Entry(presentationTimeUs = timeUs, cues = cues.toList()))
    while (entries.size > maxEntries) {
      entries.removeFirst()
    }
  }

  /**
   * Resolves the active cues for [playerPositionUs].
   *
   * Fast-paths immediately to the latest recorded snapshot when [delayMs] is `0L`. Otherwise computes
   * `effectiveUs = playerPositionUs - delayUs` and returns the latest buffered snapshot with
   * `presentationTimeUs <= effectiveUs`, or an empty list if [effectiveUs] precedes the first buffered entry.
   */
  fun resolveCues(playerPositionUs: Long): List<Cue> {
    if (entries.isEmpty()) return emptyList()
    if (delayMs == 0L) return entries.last().cues
    val effectiveUs = playerPositionUs - delayUs
    for (idx in entries.lastIndex downTo 0) {
      val entry = entries[idx]
      if (entry.presentationTimeUs <= effectiveUs) {
        return entry.cues
      }
    }
    return emptyList()
  }

  /** Clears buffered cue snapshots while preserving the current [delayMs] (e.g. across seek or track switch). */
  fun clearCues() {
    entries.clear()
  }

  /** Clears buffered cue snapshots and resets [delayMs] to `0L` (new media load or session stop). */
  fun reset() {
    entries.clear()
    delayMs = 0L
  }

  internal companion object {
    const val DEFAULT_MAX_ENTRIES = 128
  }
}

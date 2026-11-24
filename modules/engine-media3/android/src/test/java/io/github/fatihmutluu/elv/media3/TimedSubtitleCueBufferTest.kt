package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(UnstableApi::class)
class TimedSubtitleCueBufferTest {
  private fun cue(text: String): List<Cue> = listOf(Cue.Builder().setText(text).build())

  @Test
  fun `fast-paths immediately to latest cue when delay is zero`() {
    val buffer = TimedSubtitleCueBuffer()
    assertTrue(buffer.resolveCues(0L).isEmpty())

    val first = cue("Line 1")
    val second = cue("Line 2")
    buffer.record(1_000_000L, first)
    assertEquals(first, buffer.resolveCues(900_000L))

    buffer.record(2_500_000L, second)
    assertEquals(second, buffer.resolveCues(2_490_000L))
    assertEquals(0L, buffer.delayMs)
  }

  @Test
  fun `clamps setDelayMs to plus or minus 30000 ms without flushing buffered cues`() {
    val buffer = TimedSubtitleCueBuffer()
    val c1 = cue("First")
    val c2 = cue("Second")
    buffer.record(1_000_000L, c1)
    buffer.record(3_000_000L, c2)

    buffer.setDelayMs(1_500L)
    assertEquals(1_500L, buffer.delayMs)
    assertEquals(1_500_000L, buffer.delayUs)
    assertEquals(2, buffer.size)
    // At playerPosition = 2.0s with +1.5s delay, effectiveUs = 0.5s -> before first cue
    assertTrue(buffer.resolveCues(2_000_000L).isEmpty())
    // At playerPosition = 2.5s with +1.5s delay, effectiveUs = 1.0s -> first cue
    assertEquals(c1, buffer.resolveCues(2_500_000L))
    // At playerPosition = 4.5s with +1.5s delay, effectiveUs = 3.0s -> second cue
    assertEquals(c2, buffer.resolveCues(4_500_000L))

    // Changing delay mid-playback must NOT clear buffered cues
    buffer.setDelayMs(-2_000L)
    assertEquals(-2_000L, buffer.delayMs)
    assertEquals(2, buffer.size)
    // At playerPosition = 1.2s with -2.0s delay, effectiveUs = 3.2s -> second cue
    assertEquals(c2, buffer.resolveCues(1_200_000L))

    // Clamping bounds
    buffer.setDelayMs(99_999L)
    assertEquals(30_000L, buffer.delayMs)
    buffer.setDelayMs(-99_999L)
    assertEquals(-30_000L, buffer.delayMs)
    assertEquals(2, buffer.size)
  }

  @Test
  fun `enforces bounded capacity by dropping oldest entries and keeps timestamps monotonic`() {
    val buffer = TimedSubtitleCueBuffer(maxEntries = 3)
    buffer.record(1_000_000L, cue("A"))
    buffer.record(2_000_000L, cue("B"))
    buffer.record(3_000_000L, cue("C"))
    buffer.record(4_000_000L, cue("D"))
    assertEquals(3, buffer.size)

    buffer.setDelayMs(1_000L)
    // A (1.0s) was evicted; at playerPos = 2.5s -> effectiveUs = 1.5s -> empty
    assertTrue(buffer.resolveCues(2_500_000L).isEmpty())
    // At playerPos = 3.0s -> effectiveUs = 2.0s -> B
    assertEquals("B", buffer.resolveCues(3_000_000L).first().text.toString())

    // Duplicate or regressive timestamp overwrites/trims tail monotonically
    buffer.record(3_000_000L, cue("C-updated"))
    assertEquals(2, buffer.size)
    assertEquals("C-updated", buffer.resolveCues(4_500_000L).first().text.toString())
  }

  @Test
  fun `clearCues preserves delay while reset clears both entries and delay`() {
    val buffer = TimedSubtitleCueBuffer()
    buffer.setDelayMs(750L)
    buffer.record(1_000_000L, cue("Hello"))
    assertTrue(buffer.isNotEmpty)

    buffer.clearCues()
    assertFalse(buffer.isNotEmpty)
    assertEquals(750L, buffer.delayMs)

    buffer.record(2_000_000L, cue("World"))
    buffer.reset()
    assertFalse(buffer.isNotEmpty)
    assertEquals(0L, buffer.delayMs)
  }
}

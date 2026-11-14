package io.github.fatihmutluu.elv.media3

import io.github.fatihmutluu.elv.media3.ScreenCue.BUFFERING
import io.github.fatihmutluu.elv.media3.ScreenCue.ENDED
import io.github.fatihmutluu.elv.media3.ScreenCue.ERROR
import io.github.fatihmutluu.elv.media3.ScreenCue.OPENING
import io.github.fatihmutluu.elv.media3.ScreenCue.PAUSED
import io.github.fatihmutluu.elv.media3.ScreenCue.PLAYING
import io.github.fatihmutluu.elv.media3.ScreenCue.READY
import io.github.fatihmutluu.elv.media3.ScreenCue.STOP
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenOnTest {
  /** Feeds [cues] (with the prepare's `played` flag) from a screen that may sleep; returns each decision. */
  private fun run(vararg cues: Pair<ScreenCue, Boolean>): List<Boolean> {
    var on = false
    return cues.map { (cue, played) -> keepsScreenOn(on, cue, played).also { on = it } }
  }

  @Test
  fun `playing keeps the screen on, and so does buffering once the media played`() {
    assertTrue(keepsScreenOn(false, PLAYING, played = false))
    assertTrue(keepsScreenOn(false, BUFFERING, played = true))
  }

  @Test
  fun `pause, end, an error and stop let the screen sleep`() {
    for (cue in listOf(PAUSED, ENDED, ERROR, STOP)) {
      assertFalse(keepsScreenOn(true, cue, played = true))
      assertFalse(keepsScreenOn(false, cue, played = false))
    }
  }

  @Test
  fun `opening, ready and buffering before the first play keep the previous choice`() {
    for (cue in listOf(OPENING, READY, BUFFERING)) {
      assertTrue(keepsScreenOn(true, cue, played = false))
      assertFalse(keepsScreenOn(false, cue, played = false))
    }
    assertTrue(keepsScreenOn(true, READY, played = true))
    assertFalse(keepsScreenOn(false, READY, played = true))
  }

  @Test
  fun `a zap or a recovery retry from a playing media never lets the screen sleep`() {
    val decisions = run(
      OPENING to false,
      BUFFERING to false,
      PLAYING to true,
      BUFFERING to true,
      OPENING to false,
      BUFFERING to false,
      PLAYING to true,
    )
    assertEquals(listOf(false, false, true, true, true, true, true), decisions)
  }

  @Test
  fun `after a pause the screen stays on again from the first rebuffer`() {
    val decisions = run(PLAYING to true, PAUSED to true, BUFFERING to true, PLAYING to true)
    assertEquals(listOf(true, false, true, true), decisions)
  }

  @Test
  fun `a failed start after a playing media lets the screen sleep`() {
    val decisions = run(PLAYING to true, OPENING to false, ERROR to false, OPENING to false)
    assertEquals(listOf(true, true, false, false), decisions)
  }

  @Test
  fun `engine state names map to their cues`() {
    assertEquals(OPENING, ScreenCue.ofState("opening"))
    assertEquals(BUFFERING, ScreenCue.ofState("buffering"))
    assertEquals(READY, ScreenCue.ofState("ready"))
    assertEquals(PLAYING, ScreenCue.ofState("playing"))
    assertEquals(PAUSED, ScreenCue.ofState("paused"))
    assertEquals(ENDED, ScreenCue.ofState("ended"))
    assertNull(ScreenCue.ofState("error"))
  }
}

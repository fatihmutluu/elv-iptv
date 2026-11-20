package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ZapShutterTest {
  @Test
  fun `the shutter covers the surface before any media`() {
    val shutter = ZapShutter()
    assertTrue(shutter.covers)
    assertTrue(shutter.update(0, framed = false))
  }

  @Test
  fun `a load covers the surface until the first frame of that media`() {
    val shutter = ZapShutter()
    assertTrue(shutter.update(1, framed = false))
    assertFalse(shutter.update(1, framed = true))
    assertTrue(shutter.update(2, framed = false))
    assertFalse(shutter.update(2, framed = true))
    assertFalse(shutter.covers)
  }

  @Test
  fun `a first frame of an older media lifts nothing during a zap`() {
    val shutter = ZapShutter()
    shutter.update(1, framed = false)
    shutter.update(2, framed = false)
    assertTrue(shutter.update(1, framed = true))
    assertTrue(shutter.covers)
    assertFalse(shutter.update(2, framed = true))
  }

  @Test
  fun `late or repeated reports never cover a media that already showed its first frame`() {
    val shutter = ZapShutter()
    assertFalse(shutter.update(3, framed = true))
    assertFalse(shutter.update(2, framed = false))
    assertFalse(shutter.update(3, framed = false))
    assertFalse(shutter.update(3, framed = true))
    assertTrue(shutter.update(4, framed = false))
  }

  @Test
  fun `a reset covers again and accepts the serials of another engine`() {
    val shutter = ZapShutter()
    shutter.update(5, framed = true)
    shutter.reset()
    assertTrue(shutter.covers)
    assertFalse(shutter.update(1, framed = true))
  }

  @Test
  fun `a first frame counts only after the fence of the current prepare and only once`() {
    val fence = PrepareFence()
    assertFalse(fence.acceptFirstFrame())
    fence.begin(1)
    assertFalse(fence.acceptFirstFrame())
    fence.passed(1)
    assertTrue(fence.acceptFirstFrame())
    assertFalse(fence.acceptFirstFrame())
  }

  @Test
  fun `a frame of the previous prepare that arrives after a new one began is stale`() {
    val fence = PrepareFence()
    fence.begin(1)
    fence.passed(1)
    fence.begin(2)
    assertFalse(fence.acceptFirstFrame())
    fence.passed(1)
    assertFalse(fence.acceptFirstFrame())
    fence.passed(2)
    assertTrue(fence.acceptFirstFrame())
  }

  @Test
  fun `each prepare reports its own first frame`() {
    val fence = PrepareFence()
    fence.begin(1)
    fence.passed(1)
    assertTrue(fence.acceptFirstFrame())
    fence.begin(2)
    fence.passed(2)
    assertTrue(fence.acceptFirstFrame())
  }

  @Test
  fun `PrepareFence gates renderer and reused-player callbacks and deduplicates audio-only firstFrame`() {
    val fence = PrepareFence()
    fence.begin(prepare = 5L, reused = true)
    assertFalse(fence.isRendererOpen)
    assertFalse(fence.acceptsMediaId("5"))
    assertFalse(fence.acceptAudioFirstFrame())

    fence.passed(5L)
    assertTrue(fence.isRendererOpen)
    assertTrue(fence.acceptsMediaId("5"))
    assertFalse("stale mediaId from prior prepare must be rejected", fence.acceptsMediaId("4"))
    assertTrue(fence.acceptAudioFirstFrame())
    assertFalse(fence.acceptAudioFirstFrame())
    assertFalse("video firstFrame must not double-fire after audio firstFrame", fence.acceptFirstFrame())

    fence.begin(prepare = 6L, reused = false)
    assertFalse(fence.isRendererOpen)
    assertTrue("fresh player accepts current mediaId immediately", fence.acceptsMediaId("6"))
    assertFalse(fence.acceptsMediaId("5"))
  }
}

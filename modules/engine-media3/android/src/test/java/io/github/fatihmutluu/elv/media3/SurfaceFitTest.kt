package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SurfaceFitTest {
  private fun fit(
    videoW: Int,
    videoH: Int,
    pixelRatio: Float = 1f,
    viewW: Int = 1920,
    viewH: Int = 1080,
    mode: ResizeMode = ResizeMode.FIT,
  ) = fitRect(viewW, viewH, videoW, videoH, pixelRatio, mode)

  @Test
  fun `a 16 by 9 video fills a 16 by 9 view`() {
    assertEquals(VideoRect(0, 0, 1920, 1080), fit(1920, 1080))
    assertEquals(VideoRect(0, 0, 1920, 1080), fit(1280, 720))
  }

  @Test
  fun `a 4 by 3 video is pillarboxed in the centre`() {
    assertEquals(VideoRect(240, 0, 1680, 1080), fit(640, 480))
  }

  @Test
  fun `a 21 by 9 video is letterboxed in the centre`() {
    assertEquals(VideoRect(0, 135, 1920, 945), fit(2560, 1080))
  }

  @Test
  fun `a portrait view letterboxes a landscape video`() {
    assertEquals(VideoRect(0, 555, 1080, 1365), fit(640, 480, viewW = 1080, viewH = 1920))
  }

  @Test
  fun `anamorphic video is shaped by its pixel aspect ratio`() {
    assertEquals(VideoRect(0, 0, 1920, 1080), fit(720, 576, pixelRatio = 64f / 45f))
    assertEquals(VideoRect(240, 0, 1680, 1080), fit(720, 576, pixelRatio = 16f / 15f))
  }

  @Test
  fun `an aspect within one percent of the view fills it without hairline bars`() {
    assertEquals(VideoRect(0, 0, 1366, 768), fit(1920, 1080, viewW = 1366, viewH = 768))
  }

  @Test
  fun `unknown sizes change nothing and the surface keeps filling the view`() {
    val whole = VideoRect(0, 0, 1920, 1080)
    assertEquals(whole, fit(0, 0))
    assertEquals(whole, fit(1920, 0))
    assertEquals(whole, fit(0, 1080))
    assertEquals(whole, fit(1920, 1080, pixelRatio = 0f))
    assertEquals(whole, fit(640, 480, pixelRatio = Float.NaN))
    assertEquals(VideoRect(0, 0, 0, 0), fit(640, 480, viewW = 0, viewH = 0))
  }

  @Test
  fun `an extreme shape keeps the surface at least one pixel wide`() {
    assertEquals(VideoRect(959, 0, 960, 1080), fit(1, 100_000))
  }

  @Test
  fun `fill crops the video to cover the view in the centre`() {
    assertEquals(VideoRect(0, -180, 1920, 1260), fit(640, 480, mode = ResizeMode.FILL))
    assertEquals(VideoRect(-320, 0, 2240, 1080), fit(2560, 1080, mode = ResizeMode.FILL))
    assertEquals(VideoRect(0, 0, 1920, 1080), fit(1280, 720, mode = ResizeMode.FILL))
  }

  @Test
  fun `the resize mode prop is fit unless it says fill`() {
    assertEquals(ResizeMode.FILL, ResizeMode.of("fill"))
    assertEquals(ResizeMode.FIT, ResizeMode.of("fit"))
    assertEquals(ResizeMode.FIT, ResizeMode.of(null))
    assertEquals(ResizeMode.FIT, ResizeMode.of("stretch"))
  }

  @Test
  fun `a stopped media keeps the last shape until the next media reports its own`() {
    val fit = SurfaceFit()
    assertTrue(fit.video(640, 480, 1f))
    assertEquals(VideoRect(240, 0, 1680, 1080), fit.rect(1920, 1080))
    assertFalse(fit.video(0, 0, 1f))
    assertEquals(VideoRect(240, 0, 1680, 1080), fit.rect(1920, 1080))
    assertFalse(fit.video(640, 480, 1f))
    assertTrue(fit.video(2560, 1080, 1f))
    assertEquals(VideoRect(0, 135, 1920, 945), fit.rect(1920, 1080))
  }

  @Test
  fun `the mode applies to the current shape and a reset forgets the shape only`() {
    val fit = SurfaceFit()
    assertEquals(VideoRect(0, 0, 1920, 1080), fit.rect(1920, 1080))
    fit.video(640, 480, 1f)
    fit.mode = ResizeMode.FILL
    assertEquals(VideoRect(0, -180, 1920, 1260), fit.rect(1920, 1080))
    fit.reset()
    assertEquals(ResizeMode.FILL, fit.mode)
    assertEquals(VideoRect(0, 0, 1920, 1080), fit.rect(1920, 1080))
  }

  @Test
  fun `SurfaceFit sanitizes NaN, non-positive and infinite pixelRatio to 1f without layout thrash`() {
    val fit = SurfaceFit()
    assertTrue(fit.video(640, 480, Float.NaN))
    assertEquals(VideoRect(240, 0, 1680, 1080), fit.rect(1920, 1080))
    assertFalse("repeated NaN pixelRatio must deduplicate cleanly", fit.video(640, 480, Float.NaN))
    assertFalse(fit.video(640, 480, 0f))
    assertFalse(fit.video(640, 480, -2f))
    assertFalse(fit.video(640, 480, Float.POSITIVE_INFINITY))
  }
}

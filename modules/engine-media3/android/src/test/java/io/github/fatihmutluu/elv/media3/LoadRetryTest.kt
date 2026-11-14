package io.github.fatihmutluu.elv.media3

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoadRetryTest {
  @Test
  fun `refused requests always fail at once`() {
    for (hls in listOf(false, true)) {
      for (manifestLoaded in listOf(false, true)) {
        assertTrue(failsAtOnce(null, refused = true, hls = hls, manifestLoaded = manifestLoaded))
      }
    }
  }

  @Test
  fun `I-O errors without an HTTP status keep Media3's retries`() {
    assertFalse(failsAtOnce(null, refused = false, hls = false, manifestLoaded = false))
    assertFalse(failsAtOnce(null, refused = false, hls = true, manifestLoaded = false))
    assertFalse(failsAtOnce(null, refused = false, hls = true, manifestLoaded = true))
  }

  @Test
  fun `progressive media fails at once on every HTTP status`() {
    for (status in listOf(401, 403, 404, 429, 500, 503, 509)) {
      assertTrue("status $status", failsAtOnce(status, refused = false, hls = false, manifestLoaded = true))
    }
  }

  @Test
  fun `the first HLS manifest load fails at once on every HTTP status`() {
    for (status in listOf(401, 403, 404, 429, 500, 503, 509)) {
      assertTrue("status $status", failsAtOnce(status, refused = false, hls = true, manifestLoaded = false))
    }
  }

  @Test
  fun `HLS segments and refreshes fail at once only on auth and limit statuses`() {
    for (status in listOf(401, 403, 429, 509)) {
      assertTrue("status $status", failsAtOnce(status, refused = false, hls = true, manifestLoaded = true))
    }
    for (status in listOf(404, 410, 500, 502, 503)) {
      assertFalse("status $status", failsAtOnce(status, refused = false, hls = true, manifestLoaded = true))
    }
  }
}

package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.audio.AudioSink
import java.lang.reflect.Proxy
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(UnstableApi::class)
class OffsetForwardingAudioSinkTest {
  private fun fakeAudioSink(positionProvider: (Boolean) -> Long): AudioSink =
    Proxy.newProxyInstance(
      AudioSink::class.java.classLoader,
      arrayOf(AudioSink::class.java),
    ) { _, method, args ->
      when (method.name) {
        "getCurrentPositionUs" -> positionProvider((args?.firstOrNull() as? Boolean) == true)
        else -> when (method.returnType) {
          Boolean::class.javaPrimitiveType -> false
          Int::class.javaPrimitiveType -> 0
          Long::class.javaPrimitiveType -> 0L
          Float::class.javaPrimitiveType -> 0f
          Double::class.javaPrimitiveType -> 0.0
          else -> null
        }
      }
    } as AudioSink

  @Test
  fun `clamps sync delay milliseconds and converts to microseconds`() {
    assertEquals(0L, clampSyncDelayMs(0L))
    assertEquals(250L, clampSyncDelayMs(250L))
    assertEquals(-500L, clampSyncDelayMs(-500L))
    assertEquals(30_000L, clampSyncDelayMs(120_000L))
    assertEquals(-30_000L, clampSyncDelayMs(-120_000L))
    assertEquals(1_250_000L, syncDelayMsToUs(1_250L))
    assertEquals(-30_000_000L, syncDelayMsToUs(-50_000L))
  }

  @Test
  fun `preserves CURRENT_POSITION_NOT_SET and applies clamped non-negative offset`() {
    assertEquals(
      AudioSink.CURRENT_POSITION_NOT_SET,
      applyAudioDelayOffsetUs(AudioSink.CURRENT_POSITION_NOT_SET, 500_000L),
    )
    assertEquals(
      AudioSink.CURRENT_POSITION_NOT_SET,
      applyAudioDelayOffsetUs(AudioSink.CURRENT_POSITION_NOT_SET, -500_000L),
    )

    // Positive delay -> audio plays later relative to video -> reported MediaClock shifts ahead
    assertEquals(5_500_000L, applyAudioDelayOffsetUs(5_000_000L, 500_000L))
    // Negative delay -> audio plays earlier relative to video -> reported MediaClock shifts earlier
    assertEquals(4_500_000L, applyAudioDelayOffsetUs(5_000_000L, -500_000L))
    // Clamp at 0L when negative delay exceeds raw position
    assertEquals(0L, applyAudioDelayOffsetUs(200_000L, -500_000L))
    // Out-of-range delay values are clamped to +-30s
    assertEquals(80_000_000L, applyAudioDelayOffsetUs(50_000_000L, 90_000_000L))
    assertEquals(20_000_000L, applyAudioDelayOffsetUs(50_000_000L, -90_000_000L))
  }

  @Test
  fun `OffsetForwardingAudioSink reads shared AtomicLong live without reallocating`() {
    var rawPosUs = 10_000_000L
    val sharedDelay = AtomicLong(0L)
    val sink = OffsetForwardingAudioSink(fakeAudioSink { rawPosUs }, sharedDelay)

    assertEquals(10_000_000L, sink.getCurrentPositionUs(false))

    sink.setAudioDelayMs(300L)
    assertEquals(300_000L, sharedDelay.get())
    assertEquals(10_300_000L, sink.getCurrentPositionUs(false))

    sharedDelay.set(syncDelayMsToUs(-250L))
    assertEquals(9_750_000L, sink.getCurrentPositionUs(true))

    rawPosUs = AudioSink.CURRENT_POSITION_NOT_SET
    assertEquals(AudioSink.CURRENT_POSITION_NOT_SET, sink.getCurrentPositionUs(false))
  }
}

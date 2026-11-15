package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.analytics.AnalyticsListener
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Runs on a device or emulator. The live playback cases read the stream simulator through the emulator host alias:
 * start it with `pnpm sim --port 7880` (override with the `simHost` instrumentation argument).
 */
@OptIn(UnstableApi::class)
@RunWith(AndroidJUnit4::class)
class FfmpegAudioPlaybackTest {
  private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
  private val simHost: String =
    InstrumentationRegistry.getArguments().getString("simHost") ?: "10.0.2.2:7880"
  private val simAccount: String =
    InstrumentationRegistry.getArguments().getString("simAccount") ?: "corpus"

  @Test
  fun loadsTheDynamicFfmpegLibraries() {
    assertTrue("FFmpeg JNI must load", FfmpegAudio.isAvailable())
    val version = FfmpegAudio.version()
    assertNotNull(version)
    assertTrue("unexpected version $version", version!!.startsWith("Lavc"))
    Log.i("FfmpegAudioTest", "loaded version=$version")
  }

  @Test
  fun supportsBroadcastAndCommonAudioFormats() {
    val mimes = listOf(
      MimeTypes.AUDIO_AC3,
      MimeTypes.AUDIO_E_AC3,
      MimeTypes.AUDIO_E_AC3_JOC,
      MimeTypes.AUDIO_DTS,
      MimeTypes.AUDIO_DTS_HD,
      MimeTypes.AUDIO_TRUEHD,
      MimeTypes.AUDIO_MPEG_L2,
      MimeTypes.AUDIO_MPEG,
      MimeTypes.AUDIO_AAC,
      MimeTypes.AUDIO_FLAC,
      MimeTypes.AUDIO_ALAC,
      MimeTypes.AUDIO_OPUS,
      MimeTypes.AUDIO_VORBIS,
      MimeTypes.AUDIO_MLAW,
      MimeTypes.AUDIO_ALAW,
    )
    for (mime in mimes) assertTrue("FFmpeg must decode $mime", FfmpegAudio.supportsMimeType(mime))
  }

  @Test
  fun bundlesLgplAndApacheNotices() {
    val base = "licenses/ffmpeg-media3"
    val buildInfo = read("$base/BUILDINFO.json")
    assertTrue(buildInfo.contains("\"linking\": \"dynamic\""))
    assertTrue(buildInfo.contains("--enable-shared"))
    assertFalse(buildInfo.contains("--enable-gpl"))
    assertFalse(buildInfo.contains("--enable-nonfree"))
    assertTrue(read("$base/ffmpeg/COPYING.LGPLv2.1").contains("LESSER GENERAL PUBLIC LICENSE"))
    assertTrue(read("$base/ffmpeg/LICENSE.md").isNotBlank())
    assertTrue(read("$base/media3/LICENSE").contains("Apache License"))
  }

  @Test
  fun decodesLiveAc3WithFfmpeg() =
    assertDecodes(channel = 1004, softwareAudio = false, mime = MimeTypes.AUDIO_AC3, codec = "-ac3")

  @Test
  fun decodesLiveEac3WithFfmpeg() =
    assertDecodes(channel = 1008, softwareAudio = false, mime = MimeTypes.AUDIO_E_AC3, codec = "-eac3")

  @Test
  fun prefersFfmpegForAacWhenSoftwareAudio() =
    assertDecodes(channel = 1001, softwareAudio = true, mime = MimeTypes.AUDIO_AAC, codec = "-aac")

  private fun read(path: String): String = context.assets.open(path).bufferedReader().use { it.readText() }

  private fun assertDecodes(channel: Int, softwareAudio: Boolean, mime: String, codec: String) {
    val thread = HandlerThread("FfmpegAudioPlaybackTest").apply { start() }
    val handler = Handler(thread.looper)
    val decoder = AtomicReference<String?>(null)
    val error = AtomicReference<PlaybackException?>(null)
    val player = onThread(handler) {
      ExoPlayer.Builder(context, createRenderersFactory(context, softwareAudio))
        .setLooper(thread.looper)
        .build()
        .also { built ->
          built.trackSelectionParameters = built.trackSelectionParameters.buildUpon()
            .setTrackTypeDisabled(C.TRACK_TYPE_VIDEO, true)
            .build()
          built.addAnalyticsListener(object : AnalyticsListener {
            override fun onAudioDecoderInitialized(
              eventTime: AnalyticsListener.EventTime,
              decoderName: String,
              initializedTimestampMs: Long,
              initializationDurationMs: Long,
            ) {
              decoder.set(decoderName)
            }

            override fun onPlayerError(eventTime: AnalyticsListener.EventTime, e: PlaybackException) {
              error.set(e)
            }
          })
          built.setMediaItem(MediaItem.fromUri("http://${simHost}/live/${simAccount}/${simAccount}/${channel}.ts"))
          built.playWhenReady = true
          built.prepare()
        }
    }
    try {
      var rendered = 0
      var playing = false
      var sampleMime: String? = null
      val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
      while (System.nanoTime() < deadline && error.get() == null) {
        val snapshot = onThread(handler) {
          Triple(player.isPlaying, player.audioFormat?.sampleMimeType, player.audioDecoderCounters?.renderedOutputBufferCount ?: 0)
        }
        playing = snapshot.first
        sampleMime = snapshot.second
        rendered = snapshot.third
        if (playing && rendered > 50) break
        Thread.sleep(250)
      }
      assertNull("playback error on channel $channel: ${error.get()?.errorCodeName}", error.get())
      assertTrue("channel $channel never reached playing", playing)
      assertEquals(mime, sampleMime)
      val name = decoder.get()
      assertNotNull("no audio decoder initialized on channel $channel", name)
      assertTrue("channel $channel decoded with $name", name!!.startsWith("ffmpeg") && name.endsWith(codec))
      assertTrue("channel $channel rendered $rendered audio buffers", rendered > 50)
      Log.i("FfmpegAudioTest", "decoded channel=$channel mime=$sampleMime decoder=$name rendered=$rendered softwareAudio=$softwareAudio")
    } finally {
      onThread(handler) { player.release() }
      thread.quitSafely()
    }
  }

  private fun <T> onThread(handler: Handler, block: () -> T): T {
    val result = AtomicReference<Result<T>>()
    val done = CountDownLatch(1)
    handler.post {
      result.set(runCatching(block))
      done.countDown()
    }
    assertTrue("playback thread timed out", done.await(10, TimeUnit.SECONDS))
    return result.get().getOrThrow()
  }
}

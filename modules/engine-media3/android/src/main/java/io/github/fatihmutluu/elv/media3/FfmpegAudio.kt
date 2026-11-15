package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.decoder.ffmpeg.FfmpegLibrary
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.audio.AudioRendererEventListener
import androidx.media3.exoplayer.mediacodec.MediaCodecSelector
import androidx.media3.exoplayer.mediacodec.MediaCodecUtil
import androidx.media3.exoplayer.metadata.MetadataOutput
import androidx.media3.exoplayer.text.TextOutput
import androidx.media3.exoplayer.video.VideoRendererEventListener

/** Software decoders first for audio only; video keeps the platform order. */
@OptIn(UnstableApi::class)
internal val SOFTWARE_AUDIO_FIRST = MediaCodecSelector { mimeType, secure, tunneling ->
  val decoders = MediaCodecSelector.DEFAULT.getDecoderInfos(mimeType, secure, tunneling)
  if (MimeTypes.isAudio(mimeType)) MediaCodecUtil.getDecoderInfosSortedBySoftwareOnly(decoders) else decoders
}

@OptIn(UnstableApi::class)
internal fun extensionRendererModeFor(softwareAudio: Boolean): Int =
  if (softwareAudio) {
    DefaultRenderersFactory.EXTENSION_RENDERER_MODE_PREFER
  } else {
    DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON
  }

/**
 * Configures Media3's [FfmpegLibrary] loader in topological dependency order (`avutil` -> `swresample` ->
 * `avcodec` -> `ffmpegJNI`) before any renderer or availability check touches JNI.
 */
@OptIn(UnstableApi::class)
internal object FfmpegAudio {
  val LIBRARIES: Array<String> = arrayOf("avutil", "swresample", "avcodec", "ffmpegJNI")
  private var configured = false

  @Synchronized
  fun ensureConfigured() {
    ensureConfiguredWith { FfmpegLibrary.setLibraries(*LIBRARIES) }
  }

  @Synchronized
  internal fun ensureConfiguredWith(applyLibraries: () -> Unit) {
    if (!configured) {
      applyLibraries()
      configured = true
    }
  }

  @Synchronized
  internal fun resetForTest() {
    configured = false
  }

  fun isAvailable(): Boolean {
    ensureConfigured()
    return FfmpegLibrary.isAvailable()
  }

  fun version(): String? {
    ensureConfigured()
    return FfmpegLibrary.getVersion()
  }

  fun supportsMimeType(mimeType: String): Boolean {
    ensureConfigured()
    return FfmpegLibrary.supportsFormat(mimeType)
  }
}

@OptIn(UnstableApi::class)
internal fun createRenderersFactory(context: Context, softwareAudio: Boolean): DefaultRenderersFactory {
  FfmpegAudio.ensureConfigured()
  return DefaultRenderersFactory(context)
    .setEnableDecoderFallback(true)
    .setExtensionRendererMode(extensionRendererModeFor(softwareAudio))
    .setMediaCodecSelector(if (softwareAudio) SOFTWARE_AUDIO_FIRST else MediaCodecSelector.DEFAULT)
}

@OptIn(UnstableApi::class)
internal fun audioRendererClassNamesFor(context: Context, softwareAudio: Boolean): List<String> {
  val handler = Handler(Looper.getMainLooper())
  val renderers = createRenderersFactory(context, softwareAudio).createRenderers(
    handler,
    object : VideoRendererEventListener {},
    object : AudioRendererEventListener {},
    TextOutput {},
    MetadataOutput {},
  )
  return renderers
    .filter { it.trackType == C.TRACK_TYPE_AUDIO }
    .map { it.javaClass.name }
}

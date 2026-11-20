package io.github.fatihmutluu.elv.media3

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.decoder.ffmpeg.FfmpegLibrary

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

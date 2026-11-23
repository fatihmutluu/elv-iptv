package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.content.res.AssetManager
import android.graphics.Typeface
import android.view.accessibility.CaptioningManager
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.CaptionStyleCompat
import java.util.concurrent.ConcurrentHashMap

internal const val SUBTITLE_FONT_SYSTEM = "system"
internal const val SUBTITLE_FONT_ATKINSON = "atkinson"
internal const val SUBTITLE_FONT_OPENDYSLEXIC = "opendyslexic"

internal const val ATKINSON_SUBTITLE_ASSET_PATH = "fonts/AtkinsonHyperlegibleNext.ttf"
internal const val OPENDYSLEXIC_SUBTITLE_ASSET_PATH = "fonts/OpenDyslexic.otf"

/**
 * Resolves, caches, and applies bundled accessibility subtitle typefaces (`#163`) while preserving the user's
 * system `CaptioningManager` colors, window, and edge preferences.
 */
internal object SubtitleFontResolver {
  private val cache = ConcurrentHashMap<String, Typeface>()

  /** Normalizes a JS `subtitleFontFamily` prop into `'atkinson'`, `'opendyslexic'`, or `'system'`. */
  fun normalizeFamily(family: String?): String =
    when (family?.trim()?.lowercase()) {
      SUBTITLE_FONT_ATKINSON -> SUBTITLE_FONT_ATKINSON
      SUBTITLE_FONT_OPENDYSLEXIC -> SUBTITLE_FONT_OPENDYSLEXIC
      else -> SUBTITLE_FONT_SYSTEM
    }

  /** Maps a `subtitleFontFamily` prop to its Android asset path, or `null` for system typography. */
  fun resolveAssetPath(family: String?): String? =
    when (normalizeFamily(family)) {
      SUBTITLE_FONT_ATKINSON -> ATKINSON_SUBTITLE_ASSET_PATH
      SUBTITLE_FONT_OPENDYSLEXIC -> OPENDYSLEXIC_SUBTITLE_ASSET_PATH
      else -> null
    }

  /**
   * Loads and statically caches the requested accessibility [Typeface] from Android `assets/fonts/`.
   * Returns `null` for `'system'`, unknown families, or if the asset is absent (e.g. in unit-test environments).
   */
  fun loadTypeface(
    context: Context,
    family: String?,
    loader: (AssetManager, String) -> Typeface? = ::loadFromAssets,
  ): Typeface? {
    val assetPath = resolveAssetPath(family) ?: return null
    cache[assetPath]?.let { return it }
    val loaded = runCatching { loader(context.assets, assetPath) }.getOrNull() ?: return null
    return cache.putIfAbsent(assetPath, loaded) ?: loaded
  }

  /**
   * Builds a [CaptionStyleCompat] that preserves the active `CaptioningManager` foreground, background, window,
   * edge type, and edge color (falling back to [CaptionStyleCompat.DEFAULT] when unavailable or disabled) while
   * overriding the caption [Typeface].
   */
  @OptIn(UnstableApi::class)
  fun buildCaptionStyle(context: Context, typeface: Typeface): CaptionStyleCompat {
    val captioningManager = runCatching {
      context.getSystemService(Context.CAPTIONING_SERVICE) as? CaptioningManager
    }.getOrNull()
    val base = if (captioningManager != null && captioningManager.isEnabled) {
      runCatching { CaptionStyleCompat.createFromCaptionStyle(captioningManager.userStyle) }
        .getOrDefault(CaptionStyleCompat.DEFAULT)
    } else {
      CaptionStyleCompat.DEFAULT
    }
    return buildCaptionStyle(base, typeface)
  }

  /** Builds a [CaptionStyleCompat] keeping [base]'s colors and edge style with [typeface] substituted. */
  @OptIn(UnstableApi::class)
  fun buildCaptionStyle(base: CaptionStyleCompat, typeface: Typeface): CaptionStyleCompat =
    CaptionStyleCompat(
      base.foregroundColor,
      base.backgroundColor,
      base.windowColor,
      base.edgeType,
      base.edgeColor,
      typeface,
    )

  internal fun clearCacheForTest() {
    cache.clear()
  }

  private fun loadFromAssets(assets: AssetManager, assetPath: String): Typeface? =
    Typeface.createFromAsset(assets, assetPath)
}

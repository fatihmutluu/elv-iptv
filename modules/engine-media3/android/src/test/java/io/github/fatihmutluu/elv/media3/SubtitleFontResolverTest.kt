package io.github.fatihmutluu.elv.media3

import android.graphics.Color
import android.graphics.Typeface
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.CaptionStyleCompat
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class SubtitleFontResolverTest {
  @After
  fun tearDown() {
    SubtitleFontResolver.clearCacheForTest()
  }

  @Test
  fun `normalizes families and resolves asset paths for bundled accessibility fonts (#163)`() {
    assertEquals(SUBTITLE_FONT_ATKINSON, SubtitleFontResolver.normalizeFamily("atkinson"))
    assertEquals(SUBTITLE_FONT_ATKINSON, SubtitleFontResolver.normalizeFamily("  Atkinson  "))
    assertEquals(SUBTITLE_FONT_OPENDYSLEXIC, SubtitleFontResolver.normalizeFamily("opendyslexic"))
    assertEquals(SUBTITLE_FONT_OPENDYSLEXIC, SubtitleFontResolver.normalizeFamily("OpenDyslexic"))
    assertEquals(SUBTITLE_FONT_SYSTEM, SubtitleFontResolver.normalizeFamily("system"))
    assertEquals(SUBTITLE_FONT_SYSTEM, SubtitleFontResolver.normalizeFamily(null))
    assertEquals(SUBTITLE_FONT_SYSTEM, SubtitleFontResolver.normalizeFamily("unknown-font"))

    assertEquals("fonts/AtkinsonHyperlegibleNext.ttf", SubtitleFontResolver.resolveAssetPath("atkinson"))
    assertEquals("fonts/OpenDyslexic.otf", SubtitleFontResolver.resolveAssetPath("opendyslexic"))
    assertEquals(ATKINSON_SUBTITLE_ASSET_PATH, SubtitleFontResolver.resolveAssetPath("atkinson"))
    assertEquals(OPENDYSLEXIC_SUBTITLE_ASSET_PATH, SubtitleFontResolver.resolveAssetPath("opendyslexic"))
    assertNull(SubtitleFontResolver.resolveAssetPath("system"))
    assertNull(SubtitleFontResolver.resolveAssetPath(null))
    assertNull(SubtitleFontResolver.resolveAssetPath("serif"))
  }

  @Test
  fun `caches loaded typefaces per asset path and falls back to null when asset is missing (#163)`() {
    val context = RuntimeEnvironment.getApplication()
    var calls = 0
    val loadedPaths = mutableListOf<String>()

    val first = SubtitleFontResolver.loadTypeface(context, "atkinson") { _, path ->
      calls += 1
      loadedPaths += path
      Typeface.MONOSPACE
    }
    val second = SubtitleFontResolver.loadTypeface(context, "atkinson") { _, path ->
      calls += 1
      loadedPaths += path
      Typeface.SERIF
    }
    assertSame(Typeface.MONOSPACE, first)
    assertSame(Typeface.MONOSPACE, second)
    assertEquals(1, calls)
    assertEquals(listOf(ATKINSON_SUBTITLE_ASSET_PATH), loadedPaths)

    val dyslexic = SubtitleFontResolver.loadTypeface(context, "opendyslexic") { _, path ->
      calls += 1
      loadedPaths += path
      Typeface.SANS_SERIF
    }
    assertSame(Typeface.SANS_SERIF, dyslexic)
    assertEquals(2, calls)
    assertEquals(listOf(ATKINSON_SUBTITLE_ASSET_PATH, OPENDYSLEXIC_SUBTITLE_ASSET_PATH), loadedPaths)

    // 'system' returns null without invoking loader
    assertNull(
      SubtitleFontResolver.loadTypeface(context, "system") { _, _ ->
        calls += 1
        Typeface.DEFAULT
      },
    )
    assertEquals(2, calls)

    // Missing asset / throwing loader returns null gracefully without throwing
    SubtitleFontResolver.clearCacheForTest()
    assertNull(
      SubtitleFontResolver.loadTypeface(context, "atkinson") { _, _ ->
        throw RuntimeException("Font asset not found")
      },
    )
    // Default asset loader also degrades gracefully when unit-test APK lacks app assets
    assertNull(SubtitleFontResolver.loadTypeface(context, "atkinson"))
  }

  @Test
  fun `buildCaptionStyle preserves colors and edge styling while overriding typeface (#163)`() {
    val customBase = CaptionStyleCompat(
      Color.YELLOW,
      Color.BLUE,
      Color.DKGRAY,
      CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW,
      Color.RED,
      Typeface.SERIF,
    )
    val styled = SubtitleFontResolver.buildCaptionStyle(customBase, Typeface.MONOSPACE)
    assertEquals(Color.YELLOW, styled.foregroundColor)
    assertEquals(Color.BLUE, styled.backgroundColor)
    assertEquals(Color.DKGRAY, styled.windowColor)
    assertEquals(CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, styled.edgeType)
    assertEquals(Color.RED, styled.edgeColor)
    assertSame(Typeface.MONOSPACE, styled.typeface)

    val context = RuntimeEnvironment.getApplication()
    val defaultStyled = SubtitleFontResolver.buildCaptionStyle(context, Typeface.MONOSPACE)
    assertEquals(CaptionStyleCompat.DEFAULT.foregroundColor, defaultStyled.foregroundColor)
    assertEquals(CaptionStyleCompat.DEFAULT.backgroundColor, defaultStyled.backgroundColor)
    assertEquals(CaptionStyleCompat.DEFAULT.windowColor, defaultStyled.windowColor)
    assertEquals(CaptionStyleCompat.DEFAULT.edgeType, defaultStyled.edgeType)
    assertEquals(CaptionStyleCompat.DEFAULT.edgeColor, defaultStyled.edgeColor)
    assertSame(Typeface.MONOSPACE, defaultStyled.typeface)
  }
}

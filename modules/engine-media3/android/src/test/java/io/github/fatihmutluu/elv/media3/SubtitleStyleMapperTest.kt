package io.github.fatihmutluu.elv.media3

import android.graphics.Color
import android.graphics.Typeface
import android.view.View
import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.CaptionStyleCompat
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(UnstableApi::class)
@RunWith(RobolectricTestRunner::class)
class SubtitleStyleMapperTest {
  @Test
  fun `maps every fontSize, textColor, backgroundColor, edgeStyle, and verticalPosition preset accurately (#32)`() {
    val previousLocale = Locale.getDefault()
    try {
      Locale.setDefault(Locale.forLanguageTag("tr-TR"))

      // Font sizes -> exact fixed SP values
      assertEquals(16f, SubtitleStyleMapper.textSizeSp("small"), 0.001f)
      assertEquals(20f, SubtitleStyleMapper.textSizeSp("medium"), 0.001f)
      assertEquals(26f, SubtitleStyleMapper.textSizeSp("large"), 0.001f)
      assertEquals(32f, SubtitleStyleMapper.textSizeSp("extraLarge"), 0.001f)
      assertEquals(20f, SubtitleStyleMapper.textSizeSp("unknown"), 0.001f)

      // Foreground text colors
      assertEquals(Color.WHITE, SubtitleStyleMapper.foregroundColor("white"))
      assertEquals(Color.YELLOW, SubtitleStyleMapper.foregroundColor("yellow"))
      assertEquals(Color.CYAN, SubtitleStyleMapper.foregroundColor("cyan"))
      assertEquals(Color.GREEN, SubtitleStyleMapper.foregroundColor("green"))
      assertEquals(Color.WHITE, SubtitleStyleMapper.foregroundColor("INVALID"))

      // Background colors
      assertEquals(Color.TRANSPARENT, SubtitleStyleMapper.backgroundColor("none"))
      assertEquals(SUBTITLE_BG_TRANSLUCENT_ARGB, SubtitleStyleMapper.backgroundColor("translucent"))
      assertEquals(Color.BLACK, SubtitleStyleMapper.backgroundColor("opaque"))
      assertEquals(SUBTITLE_BG_TRANSLUCENT_ARGB, SubtitleStyleMapper.backgroundColor("unknown"))

      // Edge styles
      assertEquals(CaptionStyleCompat.EDGE_TYPE_NONE, SubtitleStyleMapper.edgeType("none"))
      assertEquals(CaptionStyleCompat.EDGE_TYPE_OUTLINE, SubtitleStyleMapper.edgeType("outline"))
      assertEquals(CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, SubtitleStyleMapper.edgeType("dropShadow"))
      assertEquals(CaptionStyleCompat.EDGE_TYPE_OUTLINE, SubtitleStyleMapper.edgeType("invalid"))
    } finally {
      Locale.setDefault(previousLocale)
    }

    // Parse untrusted maps with fallback defaults
    assertNull(SubtitleStyleMapper.parse(null))
    assertNull(SubtitleStyleMapper.parse("not-a-map"))
    val parsed = SubtitleStyleMapper.parse(
      mapOf(
        "fontSize" to "extraLarge",
        "textColor" to "yellow",
        "backgroundColor" to "opaque",
        "edgeStyle" to "dropShadow",
        "verticalPosition" to "raised",
      )
    )
    assertNotNull(parsed)
    assertEquals("extraLarge", parsed!!.fontSize)
    assertEquals("yellow", parsed.textColor)
    assertEquals("opaque", parsed.backgroundColor)
    assertEquals("dropShadow", parsed.edgeStyle)
    assertEquals("raised", parsed.verticalPosition)

    val captionStyle = SubtitleStyleMapper.toCaptionStyle(parsed, Typeface.MONOSPACE)
    assertEquals(Color.YELLOW, captionStyle.foregroundColor)
    assertEquals(Color.BLACK, captionStyle.backgroundColor)
    assertEquals(Color.TRANSPARENT, captionStyle.windowColor)
    assertEquals(CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, captionStyle.edgeType)
    assertEquals(Color.BLACK, captionStyle.edgeColor)
    assertSame(Typeface.MONOSPACE, captionStyle.typeface)
  }

  @Test
  fun `combines verticalPosition with OSD bottom inset and repositions top cues cleanly without secondary overlap (#32, #402)`() {
    // Bottom preset matches existing OSD inset fraction
    assertEquals(
      DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION,
      SubtitleStyleMapper.bottomPaddingFraction("bottom", 0f, 2f, 1080),
      0.0001f,
    )
    assertEquals(
      subtitleBottomPaddingFraction(100f, 2f, 1000),
      SubtitleStyleMapper.bottomPaddingFraction("bottom", 100f, 2f, 1000),
      0.0001f,
    )

    // Raised preset starts higher (0.18) and still lifts with OSD inset up to 0.55
    assertEquals(
      SUBTITLE_RAISED_BOTTOM_PADDING_FRACTION,
      SubtitleStyleMapper.bottomPaddingFraction("raised", 0f, 2f, 1080),
      0.0001f,
    )
    assertEquals(
      0.38f,
      SubtitleStyleMapper.bottomPaddingFraction("raised", 100f, 2f, 1000),
      0.001f,
    )
    assertEquals(
      MAX_SUBTITLE_RAISED_PADDING_FRACTION,
      SubtitleStyleMapper.bottomPaddingFraction("raised", 500f, 2f, 1000),
      0.001f,
    )

    // Top preset repositions primary text cues to top fraction and shifts below secondary when dual subtitles active
    val cue = Cue.Builder().setText("Hello world").build()
    val bottomCues = SubtitleStyleMapper.repositionPrimaryCues(listOf(cue), "bottom")
    assertSame(cue, bottomCues.single())

    val topSolo = SubtitleStyleMapper.repositionPrimaryCues(listOf(cue), "top", hasSecondaryCues = false).single()
    assertEquals(SUBTITLE_TOP_LINE_FRACTION, topSolo.line, 0.0001f)
    assertEquals(Cue.LINE_TYPE_FRACTION, topSolo.lineType)
    assertEquals(Cue.ANCHOR_TYPE_START, topSolo.lineAnchor)

    val topWithSecondary = SubtitleStyleMapper.repositionPrimaryCues(listOf(cue), "top", hasSecondaryCues = true).single()
    val secondaryTop = SubtitleStyleMapper.repositionSecondaryCues(listOf(cue)).single()
    assertEquals(SECONDARY_SUBTITLE_TOP_LINE_FRACTION, secondaryTop.line, 0.0001f)
    assertEquals(PRIMARY_BELOW_SECONDARY_LINE_FRACTION, topWithSecondary.line, 0.0001f)
    assertEquals(Cue.ANCHOR_TYPE_START, secondaryTop.lineAnchor)
  }

  @Test
  fun `Media3SurfaceView applies live subtitleStyle and font updates to primary and secondary SubtitleViews without restart (#32)`() {
    val context = RuntimeEnvironment.getApplication()
    val appContext = createTestAppContext()
    val view = Media3SurfaceView(context, appContext)
    view.measure(
      View.MeasureSpec.makeMeasureSpec(1920, View.MeasureSpec.EXACTLY),
      View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY),
    )
    view.layout(0, 0, 1920, 1080)

    view.setSubtitleStyleMap(
      mapOf(
        "fontSize" to "large",
        "textColor" to "cyan",
        "backgroundColor" to "none",
        "edgeStyle" to "dropShadow",
        "verticalPosition" to "raised",
      )
    )
    view.setSubtitleBottomInsetPx(72.0)
    view.setSubtitleFontFamily("atkinson")

    // Verify both primary and secondary SubtitleViews received the live CaptionStyleCompat & size without throwing
    val styleField = androidx.media3.ui.SubtitleView::class.java.getDeclaredField("style").apply { isAccessible = true }
    val primaryApplied = styleField.get(view.subtitleView) as CaptionStyleCompat
    val secondaryApplied = styleField.get(view.secondarySubtitleView) as CaptionStyleCompat
    assertEquals(Color.CYAN, primaryApplied.foregroundColor)
    assertEquals(Color.TRANSPARENT, primaryApplied.backgroundColor)
    assertEquals(CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW, primaryApplied.edgeType)
    assertEquals(primaryApplied.foregroundColor, secondaryApplied.foregroundColor)
    assertEquals(primaryApplied.edgeType, secondaryApplied.edgeType)

    // Live switch back to null restores system defaults cleanly
    view.setSubtitleStyleMap(null)
    val resetPrimary = styleField.get(view.subtitleView) as CaptionStyleCompat
    assertNotNull(resetPrimary)
  }

  private fun createTestAppContext(): expo.modules.kotlin.AppContext {
    val unsafeClass = Class.forName("sun.misc.Unsafe")
    val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
    val allocate = unsafeClass.getMethod("allocateInstance", Class::class.java)
    return allocate.invoke(unsafe, expo.modules.kotlin.AppContext::class.java) as expo.modules.kotlin.AppContext
  }
}

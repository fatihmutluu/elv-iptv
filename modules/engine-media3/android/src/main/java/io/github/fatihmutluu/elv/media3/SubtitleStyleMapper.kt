package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.CaptionStyleCompat
import androidx.media3.ui.SubtitleView
import java.util.Locale

internal const val SUBTITLE_FONT_SIZE_SMALL = "small"
internal const val SUBTITLE_FONT_SIZE_MEDIUM = "medium"
internal const val SUBTITLE_FONT_SIZE_LARGE = "large"
internal const val SUBTITLE_FONT_SIZE_EXTRA_LARGE = "extraLarge"

internal const val SUBTITLE_TEXT_COLOR_WHITE = "white"
internal const val SUBTITLE_TEXT_COLOR_YELLOW = "yellow"
internal const val SUBTITLE_TEXT_COLOR_CYAN = "cyan"
internal const val SUBTITLE_TEXT_COLOR_GREEN = "green"

internal const val SUBTITLE_BG_NONE = "none"
internal const val SUBTITLE_BG_TRANSLUCENT = "translucent"
internal const val SUBTITLE_BG_OPAQUE = "opaque"

internal const val SUBTITLE_EDGE_NONE = "none"
internal const val SUBTITLE_EDGE_OUTLINE = "outline"
internal const val SUBTITLE_EDGE_DROP_SHADOW = "dropShadow"

internal const val SUBTITLE_POS_BOTTOM = "bottom"
internal const val SUBTITLE_POS_RAISED = "raised"
internal const val SUBTITLE_POS_TOP = "top"

internal const val SUBTITLE_SIZE_SMALL_SP = 16f
internal const val SUBTITLE_SIZE_MEDIUM_SP = 20f
internal const val SUBTITLE_SIZE_LARGE_SP = 26f
internal const val SUBTITLE_SIZE_EXTRA_LARGE_SP = 32f

internal val SUBTITLE_BG_TRANSLUCENT_ARGB: Int = Color.argb(0x99, 0, 0, 0)
internal const val SUBTITLE_RAISED_BOTTOM_PADDING_FRACTION = 0.18f
internal const val MAX_SUBTITLE_RAISED_PADDING_FRACTION = 0.55f
internal const val SUBTITLE_TOP_LINE_FRACTION = 0.06f
internal const val SECONDARY_SUBTITLE_TOP_LINE_FRACTION = 0.05f
internal const val PRIMARY_BELOW_SECONDARY_LINE_FRACTION = 0.16f

/** Live user subtitle appearance configuration mirrored from `@elv/domain` (`#32`). */
internal data class SubtitleStyleConfig(
  val fontSize: String = SUBTITLE_FONT_SIZE_MEDIUM,
  val textColor: String = SUBTITLE_TEXT_COLOR_WHITE,
  val backgroundColor: String = SUBTITLE_BG_TRANSLUCENT,
  val edgeStyle: String = SUBTITLE_EDGE_OUTLINE,
  val verticalPosition: String = SUBTITLE_POS_BOTTOM,
)

/**
 * Maps [SubtitleStyleConfig] presets to Media3 [CaptionStyleCompat], fixed SP text size, and bottom/top placement
 * without restarting playback (`#32`, `#402`).
 */
@OptIn(UnstableApi::class)
internal object SubtitleStyleMapper {
  val DEFAULT: SubtitleStyleConfig = SubtitleStyleConfig()

  /** Normalizes a JS `SubtitleStyleConfig` map, returning `null` when [raw] is absent or not a map. */
  fun parse(raw: Any?): SubtitleStyleConfig? {
    val map = raw as? Map<*, *> ?: return null
    val fontSize = normalizeFontSize(map["fontSize"] as? String)
    val textColor = normalizeTextColor(map["textColor"] as? String)
    val backgroundColor = normalizeBackgroundColor(map["backgroundColor"] as? String)
    val edgeStyle = normalizeEdgeStyle(map["edgeStyle"] as? String)
    val verticalPosition = normalizeVerticalPosition(map["verticalPosition"] as? String)
    return SubtitleStyleConfig(
      fontSize = fontSize,
      textColor = textColor,
      backgroundColor = backgroundColor,
      edgeStyle = edgeStyle,
      verticalPosition = verticalPosition,
    )
  }

  fun normalizeFontSize(raw: String?): String =
    when (raw?.trim()) {
      SUBTITLE_FONT_SIZE_SMALL -> SUBTITLE_FONT_SIZE_SMALL
      SUBTITLE_FONT_SIZE_MEDIUM -> SUBTITLE_FONT_SIZE_MEDIUM
      SUBTITLE_FONT_SIZE_LARGE -> SUBTITLE_FONT_SIZE_LARGE
      SUBTITLE_FONT_SIZE_EXTRA_LARGE -> SUBTITLE_FONT_SIZE_EXTRA_LARGE
      else -> when (raw?.trim()?.lowercase(Locale.ROOT)) {
        "small" -> SUBTITLE_FONT_SIZE_SMALL
        "large" -> SUBTITLE_FONT_SIZE_LARGE
        "extralarge" -> SUBTITLE_FONT_SIZE_EXTRA_LARGE
        else -> SUBTITLE_FONT_SIZE_MEDIUM
      }
    }

  fun normalizeTextColor(raw: String?): String =
    when (raw?.trim()?.lowercase(Locale.ROOT)) {
      SUBTITLE_TEXT_COLOR_YELLOW -> SUBTITLE_TEXT_COLOR_YELLOW
      SUBTITLE_TEXT_COLOR_CYAN -> SUBTITLE_TEXT_COLOR_CYAN
      SUBTITLE_TEXT_COLOR_GREEN -> SUBTITLE_TEXT_COLOR_GREEN
      else -> SUBTITLE_TEXT_COLOR_WHITE
    }

  fun normalizeBackgroundColor(raw: String?): String =
    when (raw?.trim()?.lowercase(Locale.ROOT)) {
      SUBTITLE_BG_NONE -> SUBTITLE_BG_NONE
      SUBTITLE_BG_OPAQUE -> SUBTITLE_BG_OPAQUE
      else -> SUBTITLE_BG_TRANSLUCENT
    }

  fun normalizeEdgeStyle(raw: String?): String =
    when (raw?.trim()) {
      SUBTITLE_EDGE_NONE -> SUBTITLE_EDGE_NONE
      SUBTITLE_EDGE_OUTLINE -> SUBTITLE_EDGE_OUTLINE
      SUBTITLE_EDGE_DROP_SHADOW -> SUBTITLE_EDGE_DROP_SHADOW
      else -> when (raw?.trim()?.lowercase(Locale.ROOT)) {
        "none" -> SUBTITLE_EDGE_NONE
        "dropshadow" -> SUBTITLE_EDGE_DROP_SHADOW
        else -> SUBTITLE_EDGE_OUTLINE
      }
    }

  fun normalizeVerticalPosition(raw: String?): String =
    when (raw?.trim()?.lowercase(Locale.ROOT)) {
      SUBTITLE_POS_RAISED -> SUBTITLE_POS_RAISED
      SUBTITLE_POS_TOP -> SUBTITLE_POS_TOP
      else -> SUBTITLE_POS_BOTTOM
    }

  /** Maps a fontSize preset to fixed Android SP (`16 | 20 | 26 | 32`). */
  fun textSizeSp(fontSize: String): Float =
    when (normalizeFontSize(fontSize)) {
      SUBTITLE_FONT_SIZE_SMALL -> SUBTITLE_SIZE_SMALL_SP
      SUBTITLE_FONT_SIZE_LARGE -> SUBTITLE_SIZE_LARGE_SP
      SUBTITLE_FONT_SIZE_EXTRA_LARGE -> SUBTITLE_SIZE_EXTRA_LARGE_SP
      else -> SUBTITLE_SIZE_MEDIUM_SP
    }

  /** Maps a textColor preset to an ARGB foreground color integer. */
  fun foregroundColor(textColor: String): Int =
    when (normalizeTextColor(textColor)) {
      SUBTITLE_TEXT_COLOR_YELLOW -> Color.YELLOW
      SUBTITLE_TEXT_COLOR_CYAN -> Color.CYAN
      SUBTITLE_TEXT_COLOR_GREEN -> Color.GREEN
      else -> Color.WHITE
    }

  /** Maps a backgroundColor preset to an ARGB background color integer. */
  fun backgroundColor(backgroundColor: String): Int =
    when (normalizeBackgroundColor(backgroundColor)) {
      SUBTITLE_BG_NONE -> Color.TRANSPARENT
      SUBTITLE_BG_OPAQUE -> Color.BLACK
      else -> SUBTITLE_BG_TRANSLUCENT_ARGB
    }

  /** Maps an edgeStyle preset to a Media3 [CaptionStyleCompat] edge constant. */
  fun edgeType(edgeStyle: String): Int =
    when (normalizeEdgeStyle(edgeStyle)) {
      SUBTITLE_EDGE_NONE -> CaptionStyleCompat.EDGE_TYPE_NONE
      SUBTITLE_EDGE_DROP_SHADOW -> CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW
      else -> CaptionStyleCompat.EDGE_TYPE_OUTLINE
    }

  /** Builds a [CaptionStyleCompat] from [config] with an optional accessibility [typeface] override. */
  fun toCaptionStyle(config: SubtitleStyleConfig, typeface: Typeface? = null): CaptionStyleCompat =
    CaptionStyleCompat(
      foregroundColor(config.textColor),
      backgroundColor(config.backgroundColor),
      Color.TRANSPARENT,
      edgeType(config.edgeStyle),
      Color.BLACK,
      typeface,
    )

  /**
   * Computes Media3 `SubtitleView` bottom padding fraction combining [verticalPosition] and dynamic OSD
   * [insetDp] so subtitles never overlap bottom transport controls (`#32`, `#136`).
   */
  fun bottomPaddingFraction(
    verticalPosition: String,
    insetDp: Float,
    density: Float,
    viewHeightPx: Int,
  ): Float =
    when (normalizeVerticalPosition(verticalPosition)) {
      SUBTITLE_POS_RAISED -> {
        val cleanDp = if (insetDp.isFinite() && insetDp > 0f) insetDp else 0f
        val cleanDensity = if (density.isFinite() && density > 0f) density else 1f
        if (cleanDp <= 0f || viewHeightPx <= 0) {
          SUBTITLE_RAISED_BOTTOM_PADDING_FRACTION
        } else {
          val insetPx = cleanDp * cleanDensity
          (SUBTITLE_RAISED_BOTTOM_PADDING_FRACTION + insetPx / viewHeightPx.toFloat())
            .coerceIn(SUBTITLE_RAISED_BOTTOM_PADDING_FRACTION, MAX_SUBTITLE_RAISED_PADDING_FRACTION)
        }
      }
      SUBTITLE_POS_TOP -> DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION
      else -> subtitleBottomPaddingFraction(insetDp, density, viewHeightPx)
    }

  /**
   * Repositions primary text cues when [verticalPosition] is `"top"` so cues render near the top of the video frame.
   * When [hasSecondaryCues] is true, offsets primary slightly below the top-aligned secondary cue band so both stay
   * visually separated (`#32`, `#402`).
   */
  fun repositionPrimaryCues(
    cues: List<Cue>,
    verticalPosition: String,
    hasSecondaryCues: Boolean = false,
  ): List<Cue> {
    if (cues.isEmpty()) return cues
    if (normalizeVerticalPosition(verticalPosition) != SUBTITLE_POS_TOP) return cues
    val lineFraction = if (hasSecondaryCues) PRIMARY_BELOW_SECONDARY_LINE_FRACTION else SUBTITLE_TOP_LINE_FRACTION
    return cues.map { cue ->
      if (cue.bitmap != null) {
        cue
      } else {
        cue.buildUpon()
          .setLine(lineFraction, Cue.LINE_TYPE_FRACTION)
          .setLineAnchor(Cue.ANCHOR_TYPE_START)
          .build()
      }
    }
  }

  /**
   * Anchors secondary subtitle cues cleanly at the top of the video frame so primary bottom cues and secondary top
   * cues never overlap (`#402`).
   */
  fun repositionSecondaryCues(cues: List<Cue>): List<Cue> {
    if (cues.isEmpty()) return cues
    return cues.map { cue ->
      if (cue.bitmap != null) {
        cue
      } else {
        cue.buildUpon()
          .setLine(SECONDARY_SUBTITLE_TOP_LINE_FRACTION, Cue.LINE_TYPE_FRACTION)
          .setLineAnchor(Cue.ANCHOR_TYPE_START)
          .build()
      }
    }
  }

  /**
   * Applies live styling and font family to [view] without restarting playback. When [config] is `null`, falls back
   * cleanly to system captioning preferences with the optional accessibility [typeface].
   */
  fun applyToSubtitleView(
    view: SubtitleView,
    config: SubtitleStyleConfig?,
    typeface: Typeface?,
    context: Context,
    insetDp: Float = 0f,
    density: Float = context.resources.displayMetrics.density,
    viewHeightPx: Int = view.height,
    isSecondary: Boolean = false,
  ) {
    if (config == null) {
      if (typeface == null) {
        view.setUserDefaultStyle()
      } else {
        view.setStyle(SubtitleFontResolver.buildCaptionStyle(context, typeface))
      }
      view.setUserDefaultTextSize()
      view.setApplyEmbeddedStyles(true)
      view.setBottomPaddingFraction(
        if (isSecondary) {
          DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION
        } else {
          subtitleBottomPaddingFraction(insetDp, density, viewHeightPx)
        }
      )
      return
    }
    view.setApplyEmbeddedStyles(false)
    view.setStyle(toCaptionStyle(config, typeface))
    view.setFixedTextSize(TypedValue.COMPLEX_UNIT_SP, textSizeSp(config.fontSize))
    view.setBottomPaddingFraction(
      if (isSecondary) {
        DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION
      } else {
        bottomPaddingFraction(config.verticalPosition, insetDp, density, viewHeightPx)
      }
    )
  }
}

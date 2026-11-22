package io.github.fatihmutluu.elv.media3

import kotlin.math.abs
import kotlin.math.roundToInt

/** An aspect this close to the view's fills it: no hairline bars from rounding (Media3's `AspectRatioFrameLayout`). */
private const val ASPECT_TOLERANCE = 0.01

/** How the video meets the view: the `resizeMode` prop of `Media3Surface`. */
internal enum class ResizeMode {
  /** The whole picture at its display aspect ratio, centred, with black bars (the default). */
  FIT,

  /** The view covered at the picture's display aspect ratio, centred, the overflow cropped. */
  FILL,

  /** The picture stretched to fill the whole view, ignoring its display aspect ratio (#151). */
  STRETCH,
  ;

  companion object {
    /** The mode named by the prop; `fill` -> [FILL], `stretch` -> [STRETCH], anything else -> [FIT]. */
    fun of(name: String?): ResizeMode = when (name) {
      "fill" -> FILL
      "stretch" -> STRETCH
      else -> FIT
    }
  }
}

/** A rectangle in view pixels; edges past the view (a [ResizeMode.FILL] crop) are allowed. */
internal data class VideoRect(val left: Int, val top: Int, val right: Int, val bottom: Int) {
  val width: Int
    get() = right - left

  val height: Int
    get() = bottom - top
}

/**
 * Where the surface goes in a [viewW] x [viewH] view for a [videoW] x [videoH] picture whose pixels are [pixelRatio]
 * times as wide as high: centred at the display aspect ratio, inside the view ([ResizeMode.FIT]) or covering it
 * ([ResizeMode.FILL]). An unknown picture shape (a zero size, a ratio that is not positive) changes nothing: the
 * surface fills the view.
 */
internal fun fitRect(
  viewW: Int,
  viewH: Int,
  videoW: Int,
  videoH: Int,
  pixelRatio: Float,
  mode: ResizeMode,
): VideoRect {
  val whole = VideoRect(0, 0, viewW.coerceAtLeast(0), viewH.coerceAtLeast(0))
  if (mode == ResizeMode.STRETCH) return whole
  if (viewW <= 0 || viewH <= 0 || videoW <= 0 || videoH <= 0 || !(pixelRatio > 0f) || pixelRatio.isInfinite()) {
    return whole
  }
  val videoAspect = videoW * pixelRatio.toDouble() / videoH
  val viewAspect = viewW.toDouble() / viewH
  if (abs(videoAspect / viewAspect - 1) <= ASPECT_TOLERANCE) return whole
  val fullWidth = (videoAspect > viewAspect) == (mode == ResizeMode.FIT)
  val width = if (fullWidth) viewW else (viewH * videoAspect).roundToInt().coerceAtLeast(1)
  val height = if (fullWidth) (viewW / videoAspect).roundToInt().coerceAtLeast(1) else viewH
  val left = (viewW - width) / 2
  val top = (viewH - height) / 2
  return VideoRect(left, top, left + width, top + height)
}

/**
 * The surface's shape on the UI thread: the resize [mode] and the bound engine's last known picture shape. A size
 * that is not known (a stopped media reports zero) keeps the last shape, so a zap does not resize the surface until
 * the new media reports its own.
 */
internal class SurfaceFit {
  var mode = ResizeMode.FIT

  private var width = 0
  private var height = 0
  private var pixelRatio = 1f

  /** Applies a decoded picture size; returns true when the shape changed. Invalid [pixelRatio] defaults to `1f`. */
  fun video(width: Int, height: Int, pixelRatio: Float): Boolean {
    if (width <= 0 || height <= 0) return false
    val cleanRatio = if (pixelRatio.isFinite() && pixelRatio > 0f) pixelRatio else 1f
    if (width == this.width && height == this.height && cleanRatio == this.pixelRatio) return false
    this.width = width
    this.height = height
    this.pixelRatio = cleanRatio
    return true
  }

  /** Forgets the shape (the view was bound to another engine); the mode stays. */
  fun reset() {
    width = 0
    height = 0
    pixelRatio = 1f
  }

  /** The surface rectangle in a [viewW] x [viewH] view. */
  fun rect(viewW: Int, viewH: Int): VideoRect = fitRect(viewW, viewH, width, height, pixelRatio, mode)
}

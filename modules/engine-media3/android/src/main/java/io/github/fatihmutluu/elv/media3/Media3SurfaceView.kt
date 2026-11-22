package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.SubtitleView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

private const val TAG = "ElvMedia3"
internal const val DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION = 0.08f
internal const val MAX_SUBTITLE_BOTTOM_PADDING_FRACTION = 0.45f

/**
 * Computes the Media3 `SubtitleView` bottom padding fraction for an extra OSD inset in dp (#136),
 * clamped to `[DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION, MAX_SUBTITLE_BOTTOM_PADDING_FRACTION]`.
 */
internal fun subtitleBottomPaddingFraction(insetDp: Float, density: Float, viewHeightPx: Int): Float {
  val cleanDp = if (insetDp.isFinite() && insetDp > 0f) insetDp else 0f
  val cleanDensity = if (density.isFinite() && density > 0f) density else 1f
  if (cleanDp <= 0f || viewHeightPx <= 0) return DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION
  val insetPx = cleanDp * cleanDensity
  return (DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION + insetPx / viewHeightPx.toFloat())
    .coerceIn(DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION, MAX_SUBTITLE_BOTTOM_PADDING_FRACTION)
}

/**
 * Longest UI-thread wait for the playback thread to let go of a surface (#424): bounded to 250 ms to avoid UI-thread
 * ANRs when `ExoPlayer.release()` or `MediaCodec.release()` is slow. The wait ends as soon as the detach ran.
 */
internal const val DETACH_TIMEOUT_MS = 250L

private fun exactly(size: Int) = View.MeasureSpec.makeMeasureSpec(size.coerceAtLeast(0), View.MeasureSpec.EXACTLY)

/**
 * The `Media3Surface` view (player core spec 6.1): a `SurfaceView`, created once and never re-typed or put on top,
 * covered by a black zap shutter `View`, with `SubtitleView` above the shutter over the fitted video rectangle so
 * subtitles stay visible on audio-only streams while stale cues are cleared on every prepare/stop/off. The view paints
 * black bars beside the video, never over it, so React Native views drawn above compose over video and subtitles.
 */
@OptIn(UnstableApi::class)
class Media3SurfaceView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext),
  SurfaceHolder.Callback {
  private val surfaceView = SurfaceView(context)
  internal val subtitleView = SubtitleView(context)
  private val shutterView = View(context)
  private val main = Handler(Looper.getMainLooper())
  private val shutter = ZapShutter()
  private val fit = SurfaceFit()
  private val bars = Paint().apply { color = Color.BLACK }
  private var placed = VideoRect(0, 0, 0, 0)
  private var engine: Media3Engine? = null
  private var binding: Binding? = null
  private var surface: Surface? = null
  private var screenWanted = false
  private var subtitleBottomInsetDp = 0f

  init {
    surfaceView.isFocusable = false
    shutterView.isFocusable = false
    subtitleView.isFocusable = false
    shutterView.setBackgroundColor(Color.BLACK)
    surfaceView.holder.addCallback(this)
    addView(surfaceView)
    addView(shutterView)
    addView(subtitleView)
    showShutter(shutter.covers)
    applySubtitleBottomPadding()
  }

  /**
   * Binds the view to [next] (null unbinds): the surface moves from the previous engine, which must let go of it
   * first; subtitle cues clear, the shutter covers, the surface fills the view and the screen may sleep until [next]
   * reports its state.
   */
  fun bind(next: Media3Engine?) {
    if (next === engine) return
    engine?.let { old ->
      binding?.let { old.unbindView(it) }
      surface?.let { detach(old, it) }
    }
    engine = next
    subtitleView.setCues(emptyList())
    shutter.reset()
    showShutter(shutter.covers)
    fit.reset()
    placed = VideoRect(0, 0, 0, 0)
    placeSurface()
    keepScreen(false)
    binding = next?.let { bound -> Binding().also { bound.bindView(it) } }
    val validSurface = surface?.takeIf { it.isValid }
    if (validSurface == null) {
      surface = null
    } else {
      next?.attachSurface(validSurface)
    }
  }

  /** The `resizeMode` prop: `fit` (default) or `fill`. */
  fun setResizeMode(name: String?) {
    val next = ResizeMode.of(name)
    if (next == fit.mode) return
    fit.mode = next
    placeSurface()
  }

  /** The `subtitleBottomInsetPx` prop (in dp): lifts `SubtitleView` cues above a visible OSD (#136). */
  fun setSubtitleBottomInsetPx(insetDp: Double?) {
    val next = insetDp?.takeIf { it.isFinite() && it > 0.0 }?.toFloat() ?: 0f
    if (next == subtitleBottomInsetDp) return
    subtitleBottomInsetDp = next
    applySubtitleBottomPadding()
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    val created = holder.surface
    if (created == null || !created.isValid) return
    surface = created
    engine?.attachSurface(created)
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    val destroyed = surface ?: return
    surface = null
    engine?.let { detach(it, destroyed) }
  }

  /** React Native lays out this view only: the shutter fills it, the surface and subtitles take its fitted rectangle. */
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val height = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(width, height)
    shutterView.measure(exactly(width), exactly(height))
    val rect = fit.rect(width, height)
    surfaceView.measure(exactly(rect.width), exactly(rect.height))
    subtitleView.measure(exactly(rect.width), exactly(rect.height))
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    shutterView.layout(0, 0, r - l, b - t)
    placeSurface(r - l, b - t)
  }

  override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    applySubtitleBottomPadding(h)
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    keepScreenOn = screenWanted
  }

  override fun onDetachedFromWindow() {
    keepScreenOn = false
    super.onDetachedFromWindow()
  }

  /** Bars beside the surface only; the clip keeps a `fill` crop inside the view. */
  override fun dispatchDraw(canvas: Canvas) {
    val w = width.toFloat()
    val h = height.toFloat()
    canvas.clipRect(0f, 0f, w, h)
    if (placed.top > 0) canvas.drawRect(0f, 0f, w, placed.top.toFloat(), bars)
    if (placed.bottom < height) canvas.drawRect(0f, placed.bottom.toFloat(), w, h, bars)
    if (placed.left > 0) canvas.drawRect(0f, 0f, placed.left.toFloat(), h, bars)
    if (placed.right < width) canvas.drawRect(placed.right.toFloat(), 0f, w, h, bars)
    super.dispatchDraw(canvas)
  }

  /**
   * Sizes and centres the surface and subtitle layer in a [width] x [height] view; called from layout and when the
   * shape or the mode changes, which needs no layout pass (React Native would not run one for this view).
   */
  private fun placeSurface(width: Int = this.width, height: Int = this.height) {
    val rect = fit.rect(width, height)
    if (surfaceView.measuredWidth != rect.width || surfaceView.measuredHeight != rect.height) {
      surfaceView.measure(exactly(rect.width), exactly(rect.height))
    }
    if (subtitleView.measuredWidth != rect.width || subtitleView.measuredHeight != rect.height) {
      subtitleView.measure(exactly(rect.width), exactly(rect.height))
    }
    surfaceView.layout(rect.left, rect.top, rect.right, rect.bottom)
    subtitleView.layout(rect.left, rect.top, rect.right, rect.bottom)
    if (rect == placed) return
    placed = rect
    invalidate()
  }

  /** The screen stays on only while the bound engine plays and this view is in a window. */
  private fun keepScreen(on: Boolean) {
    screenWanted = on
    keepScreenOn = on && isAttachedToWindow
  }

  private fun applySubtitleBottomPadding(viewHeight: Int = height) {
    subtitleView.setBottomPaddingFraction(
      subtitleBottomPaddingFraction(
        insetDp = subtitleBottomInsetDp,
        density = resources.displayMetrics.density,
        viewHeightPx = viewHeight,
      )
    )
  }

  private fun detach(from: Media3Engine, old: Surface) {
    if (!from.detachSurface(old, DETACH_TIMEOUT_MS)) Log.w(TAG, "surface detach timed out")
  }

  /** INVISIBLE, not GONE: toggling needs no layout pass. */
  private fun showShutter(covers: Boolean) {
    shutterView.visibility = if (covers) View.VISIBLE else View.INVISIBLE
  }

  /** One binding per bound engine, so reports still queued from a previous engine are ignored. */
  private inner class Binding : ViewSink {
    override fun onShutter(media: Long, framed: Boolean) = onMain { showShutter(shutter.update(media, framed)) }

    override fun onVideoSize(width: Int, height: Int, pixelRatio: Float) =
      onMain { if (fit.video(width, height, pixelRatio)) placeSurface() }

    override fun onScreenOn(on: Boolean) = onMain { keepScreen(on) }

    override fun onCues(cues: List<Cue>) = onMain { subtitleView.setCues(cues) }

    private fun onMain(apply: () -> Unit) {
      main.post { if (binding === this) apply() }
    }
  }
}

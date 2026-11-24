package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.SurfaceTexture
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.TextureView
import android.view.View
import androidx.annotation.OptIn
import androidx.media3.common.text.Cue
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.SubtitleView
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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
 * The `Media3Surface` view (player core spec 6.1): a `SurfaceView` by default (never put on top, or an opt-in
 * `TextureView` fallback when `useTextureView = true`, #262) at child index 0, optional native ASS/SSA OpenGL
 * overlay below the black zap shutter `View` (#223), primary `SubtitleView`, and top-aligned `secondarySubtitleView`
 * (#402) over the fitted video rectangle. `surfaceRecreationToken` (#144) swaps only child 0 for a fresh video
 * surface on Rung 3 decoder reset while ignoring retired surface callbacks.
 */
@OptIn(UnstableApi::class)
class Media3SurfaceView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext),
  SurfaceHolder.Callback {
  private var activeSurfaceView: SurfaceView? = null
  private var activeTextureView: TextureView? = null
  private var activeVideoView: View
  private var assOverlayView: View? = null
  private var boundAssHandle: AssOverlayHandle? = null
  internal val subtitleView = SubtitleView(context)
  internal val secondarySubtitleView = SubtitleView(context)
  private val shutterView = View(context)
  private val main = Handler(Looper.getMainLooper())
  private val shutter = ZapShutter()
  private val fit = SurfaceFit()
  private val bars = Paint().apply { color = Color.BLACK }
  private var placed = VideoRect(0, 0, 0, 0)
  private var engine: Media3Engine? = null
  private var binding: Binding? = null
  private var surface: Surface? = null
  private var textureSurface: Surface? = null
  private var useTextureView = false
  private var surfaceRecreationToken = 0
  private var screenWanted = false
  private var subtitleBottomInsetDp = 0f
  private var subtitleFontFamily = SUBTITLE_FONT_SYSTEM
  private var subtitleStyle: SubtitleStyleConfig? = null
  private var rawPrimaryCues: List<Cue> = emptyList()
  private var rawSecondaryCues: List<Cue> = emptyList()

  internal val activeTextureSurfaceForTest: Surface?
    get() = textureSurface

  internal val assOverlayViewForTest: View?
    get() = assOverlayView

  init {
    val initialSurfaceView = SurfaceView(context).apply {
      isFocusable = false
      holder.addCallback(this@Media3SurfaceView)
    }
    activeSurfaceView = initialSurfaceView
    activeVideoView = initialSurfaceView
    shutterView.isFocusable = false
    subtitleView.isFocusable = false
    secondarySubtitleView.isFocusable = false
    shutterView.setBackgroundColor(Color.BLACK)
    addView(initialSurfaceView)
    addView(shutterView)
    addView(subtitleView)
    addView(secondarySubtitleView)
    showShutter(shutter.covers)
    applySubtitleAppearance()
  }

  /**
   * Binds the view to [next] (null unbinds): the surface moves from the previous engine, which must let go of it
   * first; subtitle cues and any mounted ASS overlay clear, the shutter covers, the surface fills the view and the
   * screen may sleep until [next] reports its state.
   */
  fun bind(next: Media3Engine?) {
    if (next === engine) return
    engine?.let { old ->
      binding?.let { old.unbindView(it) }
      surface?.let { detach(old, it) }
    }
    engine = next
    rawPrimaryCues = emptyList()
    rawSecondaryCues = emptyList()
    subtitleView.setCues(emptyList())
    secondarySubtitleView.setCues(emptyList())
    detachAssOverlayView()
    shutter.reset()
    showShutter(shutter.covers)
    fit.reset()
    placed = VideoRect(0, 0, 0, 0)
    placeSurface()
    keepScreen(false)
    binding = next?.let { bound -> Binding().also { bound.bindView(it) } }
    val validSurface = surface?.takeIf { it.isValid }
    if (validSurface == null) {
      if (textureSurface != null && textureSurface === surface) {
        runCatching { textureSurface?.release() }
        textureSurface = null
      }
      surface = null
    } else {
      next?.attachSurface(validSurface)
    }
  }

  /** The `resizeMode` prop: `fit` (default), `fill`, or `stretch` (#151). */
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

  /** The `subtitleFontFamily` prop (`#163`): `'system'` (default), `'atkinson'`, or `'opendyslexic'`. */
  fun setSubtitleFontFamily(family: String?) {
    val next = SubtitleFontResolver.normalizeFamily(family)
    if (next == subtitleFontFamily) return
    subtitleFontFamily = next
    applySubtitleAppearance()
  }

  /** Live subtitle appearance update from JS prop or engine without restarting playback (`#32`). */
  internal fun setSubtitleStyle(style: SubtitleStyleConfig?) {
    if (style == subtitleStyle) return
    subtitleStyle = style
    applySubtitleAppearance()
    renderPrimaryCues()
    renderSecondaryCues()
  }

  /** The `subtitleStyle` view prop parsed from JS (`#32`). */
  fun setSubtitleStyleMap(raw: Map<String, Any?>?) {
    setSubtitleStyle(SubtitleStyleMapper.parse(raw))
  }

  /** Mounts or detaches the native ASS/SSA OpenGL overlay view strictly below `shutterView` (`#223`). */
  internal fun setAssOverlayHandle(handle: AssOverlayHandle?) {
    if (handle === boundAssHandle) return
    detachAssOverlayView()
    if (handle == null) return
    val created = runCatching { handle.createOverlayView(context) }.getOrNull() ?: return
    created.isFocusable = false
    val insertIndex = indexOfChild(shutterView).coerceAtLeast(1)
    addView(created, insertIndex)
    assOverlayView = created
    boundAssHandle = handle
    placeSurface()
  }

  private fun detachAssOverlayView() {
    boundAssHandle = null
    val current = assOverlayView ?: return
    assOverlayView = null
    removeView(current)
  }

  /**
   * The `surfaceRecreationToken` prop (#144): ignores unchanged values and initial `0`; when incremented (Rung 3
   * decoder reset), replaces child index 0 with a fresh `SurfaceView` or `TextureView`.
   */
  fun setSurfaceRecreationToken(token: Int) {
    val normalized = token.coerceAtLeast(0)
    if (normalized == surfaceRecreationToken) return
    surfaceRecreationToken = normalized
    if (normalized == 0) return
    replaceVideoView()
  }

  /** The `useTextureView` prop (#262): defaults to `false` (`SurfaceView`); toggles child 0 to/from `TextureView`. */
  fun setUseTextureView(enabled: Boolean) {
    if (enabled == useTextureView) return
    useTextureView = enabled
    replaceVideoView()
  }

  override fun surfaceCreated(holder: SurfaceHolder) = onSurfaceCreated(holder, holder.surface)

  internal fun onSurfaceCreatedForTest(holder: SurfaceHolder, created: Surface?) = onSurfaceCreated(holder, created)

  private fun onSurfaceCreated(holder: SurfaceHolder, created: Surface?) {
    if (useTextureView || holder !== activeSurfaceView?.holder) return
    if (created == null || !created.isValid) return
    surface = created
    engine?.attachSurface(created)
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    if (useTextureView || holder !== activeSurfaceView?.holder) return
    val destroyed = surface ?: return
    surface = null
    engine?.let { detach(it, destroyed) }
  }

  /** React Native lays out this view only: the shutter fills it, the surface, ASS overlay, and subtitles take its fitted rectangle. */
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val height = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(width, height)
    shutterView.measure(exactly(width), exactly(height))
    val rect = fit.rect(width, height)
    activeVideoView.measure(exactly(rect.width), exactly(rect.height))
    assOverlayView?.measure(exactly(rect.width), exactly(rect.height))
    subtitleView.measure(exactly(rect.width), exactly(rect.height))
    secondarySubtitleView.measure(exactly(rect.width), exactly(rect.height))
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

  private fun replaceVideoView() {
    detachCurrentSurface()
    activeSurfaceView?.let { old ->
      old.holder.removeCallback(this)
      removeView(old)
    }
    activeSurfaceView = null
    activeTextureView?.let { old ->
      old.surfaceTextureListener = null
      removeView(old)
    }
    activeTextureView = null

    val nextView: View = if (useTextureView) {
      TextureView(context).apply {
        isFocusable = false
        activeTextureView = this
        surfaceTextureListener = createTextureListener(this)
      }
    } else {
      SurfaceView(context).apply {
        isFocusable = false
        activeSurfaceView = this
        holder.addCallback(this@Media3SurfaceView)
      }
    }
    activeVideoView = nextView
    addView(nextView, 0)
    placeSurface()
    invalidate()
  }

  private fun detachCurrentSurface() {
    val oldSurface = surface
    val oldTextureSurface = textureSurface
    surface = null
    textureSurface = null
    if (oldSurface != null) {
      engine?.let { detach(it, oldSurface) }
    }
    if (oldTextureSurface != null) {
      runCatching { oldTextureSurface.release() }
    }
  }

  private fun createTextureListener(owner: TextureView): TextureView.SurfaceTextureListener =
    object : TextureView.SurfaceTextureListener {
      override fun onSurfaceTextureAvailable(surfaceTexture: SurfaceTexture, width: Int, height: Int) {
        if (!useTextureView || owner !== activeTextureView) return
        textureSurface?.let { stale ->
          if (surface === stale) surface = null
          engine?.let { detach(it, stale) }
          runCatching { stale.release() }
          textureSurface = null
        }
        val created = Surface(surfaceTexture)
        if (!created.isValid) {
          runCatching { created.release() }
          return
        }
        textureSurface = created
        surface = created
        engine?.attachSurface(created)
      }

      override fun onSurfaceTextureSizeChanged(surfaceTexture: SurfaceTexture, width: Int, height: Int) = Unit

      override fun onSurfaceTextureDestroyed(surfaceTexture: SurfaceTexture): Boolean {
        if (owner !== activeTextureView) return true
        val destroyed = textureSurface ?: surface
        textureSurface = null
        if (surface === destroyed) surface = null
        if (destroyed != null) {
          engine?.let { detach(it, destroyed) }
          runCatching { destroyed.release() }
        }
        return true
      }

      override fun onSurfaceTextureUpdated(surfaceTexture: SurfaceTexture) = Unit
    }

  /**
   * Sizes and centres the surface, optional ASS overlay, and subtitle layers in a [width] x [height] view; called
   * from layout and when the shape or the mode changes, which needs no layout pass (React Native would not run one
   * for this view).
   */
  private fun placeSurface(width: Int = this.width, height: Int = this.height) {
    val rect = fit.rect(width, height)
    measureAndLayoutToRect(activeVideoView, rect)
    assOverlayView?.let { measureAndLayoutToRect(it, rect) }
    measureAndLayoutToRect(subtitleView, rect)
    measureAndLayoutToRect(secondarySubtitleView, rect)
    if (rect == placed) return
    placed = rect
    invalidate()
  }

  private fun measureAndLayoutToRect(child: View, rect: VideoRect) {
    if (child.measuredWidth != rect.width || child.measuredHeight != rect.height) {
      child.measure(exactly(rect.width), exactly(rect.height))
    }
    child.layout(rect.left, rect.top, rect.right, rect.bottom)
  }

  /** The screen stays on only while the bound engine plays and this view is in a window. */
  private fun keepScreen(on: Boolean) {
    screenWanted = on
    keepScreenOn = on && isAttachedToWindow
  }

  private fun applySubtitleBottomPadding(viewHeight: Int = height) {
    val verticalPos = subtitleStyle?.verticalPosition ?: SUBTITLE_POS_BOTTOM
    subtitleView.setBottomPaddingFraction(
      SubtitleStyleMapper.bottomPaddingFraction(
        verticalPosition = verticalPos,
        insetDp = subtitleBottomInsetDp,
        density = resources.displayMetrics.density,
        viewHeightPx = viewHeight,
      )
    )
    secondarySubtitleView.setBottomPaddingFraction(DEFAULT_SUBTITLE_BOTTOM_PADDING_FRACTION)
  }

  private fun applySubtitleAppearance(viewHeight: Int = height) {
    val typeface = SubtitleFontResolver.loadTypeface(context, subtitleFontFamily)
    val density = resources.displayMetrics.density
    SubtitleStyleMapper.applyToSubtitleView(
      view = subtitleView,
      config = subtitleStyle,
      typeface = typeface,
      context = context,
      insetDp = subtitleBottomInsetDp,
      density = density,
      viewHeightPx = viewHeight,
      isSecondary = false,
    )
    SubtitleStyleMapper.applyToSubtitleView(
      view = secondarySubtitleView,
      config = subtitleStyle,
      typeface = typeface,
      context = context,
      insetDp = 0f,
      density = density,
      viewHeightPx = viewHeight,
      isSecondary = true,
    )
  }

  private fun renderPrimaryCues() {
    val verticalPos = subtitleStyle?.verticalPosition ?: SUBTITLE_POS_BOTTOM
    val positioned = SubtitleStyleMapper.repositionPrimaryCues(
      cues = rawPrimaryCues,
      verticalPosition = verticalPos,
      hasSecondaryCues = rawSecondaryCues.isNotEmpty(),
    )
    subtitleView.setCues(positioned)
  }

  private fun renderSecondaryCues() {
    val positioned = SubtitleStyleMapper.repositionSecondaryCues(rawSecondaryCues)
    secondarySubtitleView.setCues(positioned)
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

    override fun onCues(cues: List<Cue>) = onMain {
      rawPrimaryCues = cues
      renderPrimaryCues()
    }

    override fun onSecondaryCues(cues: List<Cue>) = onMain {
      val hadSecondary = rawSecondaryCues.isNotEmpty()
      val hasSecondary = cues.isNotEmpty()
      rawSecondaryCues = cues
      renderSecondaryCues()
      if (hadSecondary != hasSecondary && subtitleStyle?.verticalPosition == SUBTITLE_POS_TOP) {
        renderPrimaryCues()
      }
    }

    override fun onSubtitleStyle(style: SubtitleStyleConfig?) = onMain {
      setSubtitleStyle(style)
    }

    override fun onAssOverlayHandle(handle: AssOverlayHandle?) = onMain {
      setAssOverlayHandle(handle)
    }

    override fun onAssOverlayDetachSync(timeoutMs: Long) {
      if (Looper.myLooper() === Looper.getMainLooper()) {
        if (binding === this) setAssOverlayHandle(null)
        return
      }
      val detached = CountDownLatch(1)
      val posted = main.postAtFrontOfQueue {
        try {
          if (binding === this) setAssOverlayHandle(null)
        } finally {
          detached.countDown()
        }
      }
      if (posted && !detached.await(timeoutMs, TimeUnit.MILLISECONDS)) {
        Log.w(TAG, "ASS overlay detach timed out")
      }
    }

    private fun onMain(apply: () -> Unit) {
      main.post { if (binding === this) apply() }
    }
  }
}

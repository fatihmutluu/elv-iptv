package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView

private const val TAG = "ElvMedia3"

/**
 * Longest UI-thread wait for the playback thread to let go of a surface: a release in progress (Media3's 500 ms
 * release timeout) plus Media3's own 2 s surface detach timeout, with margin. The wait ends as soon as the detach ran.
 */
private const val DETACH_TIMEOUT_MS = 3_000L

/**
 * The `Media3Surface` view (player core spec 6.1): a `SurfaceView`, created once and never re-typed or put on top,
 * under a black zap shutter. Neither paints anything else, so React Native views drawn above compose over the video.
 * Surface callbacks attach and detach the surface on the bound engine's playback thread; the engine drives the
 * shutter from every `load` until that media's first frame, posted straight to this view (no JavaScript round trip).
 */
class Media3SurfaceView(context: Context, appContext: AppContext) :
  ExpoView(context, appContext),
  SurfaceHolder.Callback {
  private val surfaceView = SurfaceView(context)
  private val shutterView = View(context)
  private val main = Handler(Looper.getMainLooper())
  private val shutter = ZapShutter()
  private var engine: Media3Engine? = null
  private var binding: Binding? = null
  private var surface: Surface? = null

  init {
    surfaceView.isFocusable = false
    shutterView.isFocusable = false
    shutterView.setBackgroundColor(Color.BLACK)
    surfaceView.holder.addCallback(this)
    addView(surfaceView)
    addView(shutterView)
    showShutter(shutter.covers)
  }

  /**
   * Binds the view to [next] (null unbinds): the surface moves from the previous engine, which must let go of it
   * first, and the shutter covers until [next] reports its state.
   */
  fun bind(next: Media3Engine?) {
    if (next === engine) return
    engine?.let { old ->
      binding?.let { old.unbindShutter(it) }
      surface?.let { detach(old, it) }
    }
    engine = next
    shutter.reset()
    showShutter(shutter.covers)
    binding = next?.let { bound -> Binding().also { bound.bindShutter(it) } }
    surface?.let { next?.attachSurface(it) }
  }

  override fun surfaceCreated(holder: SurfaceHolder) {
    val created = holder.surface
    surface = created
    engine?.attachSurface(created)
  }

  override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit

  override fun surfaceDestroyed(holder: SurfaceHolder) {
    val destroyed = surface ?: return
    surface = null
    engine?.let { detach(it, destroyed) }
  }

  /** React Native lays out this view only; both children fill it. */
  override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val height = MeasureSpec.getSize(heightMeasureSpec)
    setMeasuredDimension(width, height)
    val exactWidth = MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY)
    val exactHeight = MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY)
    surfaceView.measure(exactWidth, exactHeight)
    shutterView.measure(exactWidth, exactHeight)
  }

  override fun onLayout(changed: Boolean, l: Int, t: Int, r: Int, b: Int) {
    surfaceView.layout(0, 0, r - l, b - t)
    shutterView.layout(0, 0, r - l, b - t)
  }

  private fun detach(from: Media3Engine, old: Surface) {
    if (!from.detachSurface(old, DETACH_TIMEOUT_MS)) Log.w(TAG, "surface detach timed out")
  }

  /** INVISIBLE, not GONE: toggling needs no layout pass. */
  private fun showShutter(covers: Boolean) {
    shutterView.visibility = if (covers) View.VISIBLE else View.INVISIBLE
  }

  /** One binding per bound engine, so reports still queued from a previous engine are ignored. */
  private inner class Binding : ShutterSink {
    override fun onShutter(media: Long, framed: Boolean) {
      main.post {
        if (binding === this) showShutter(shutter.update(media, framed))
      }
    }
  }
}

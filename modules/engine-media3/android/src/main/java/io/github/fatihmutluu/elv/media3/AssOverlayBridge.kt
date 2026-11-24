package io.github.fatihmutluu.elv.media3

import android.content.Context
import android.util.Log
import android.view.View
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.RenderersFactory
import androidx.media3.extractor.ExtractorsFactory
import io.github.peerless2012.ass.media.AssHandler
import io.github.peerless2012.ass.media.factory.AssRenderersFactory
import io.github.peerless2012.ass.media.kt.withAssMkvSupport
import io.github.peerless2012.ass.media.parser.AssSubtitleParserFactory
import io.github.peerless2012.ass.media.type.AssRenderType
import io.github.peerless2012.ass.media.widget.AssSubtitleView
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "ElvMedia3"

/**
 * Lifecycle-managed native ASS/SSA OpenGL overlay session (`#223`), abstracted behind an internal interface so
 * JVM Robolectric unit tests can verify fallback, view z-ordering, and zero-leak zap/release idempotency.
 */
@OptIn(UnstableApi::class)
internal interface AssOverlayHandle {
  /** Wraps Media3's [RenderersFactory] with [AssRenderersFactory] when native ASS rendering is active. */
  fun wrapRenderersFactory(base: RenderersFactory): RenderersFactory

  /** Wraps progressive [ExtractorsFactory] with ASS Matroska font and dialogue extraction support. */
  fun wrapExtractorsFactory(base: ExtractorsFactory): ExtractorsFactory

  /** Attaches [player] to the underlying [AssHandler]; returns `false` on native/GL failure. */
  fun attachPlayer(player: ExoPlayer): Boolean

  /** Creates a non-focusable [AssSubtitleView] bound to this session, or `null` if GL view init fails. */
  fun createOverlayView(context: Context): View?

  /** Clears transient frame callbacks between channel zaps without leaking textures. */
  fun clearForZap()

  /** Releases native `libass` / OpenGL resources; strictly idempotent. */
  fun release()
}

@OptIn(UnstableApi::class)
internal class RealAssOverlayHandle(
  private val handler: AssHandler,
) : AssOverlayHandle {
  private val released = AtomicBoolean(false)
  private val playerAttached = AtomicBoolean(false)

  override fun wrapRenderersFactory(base: RenderersFactory): RenderersFactory {
    if (released.get()) return base
    return runCatching { AssRenderersFactory(handler, base) }.getOrDefault(base)
  }

  override fun wrapExtractorsFactory(base: ExtractorsFactory): ExtractorsFactory {
    if (released.get()) return base
    return runCatching {
      val parserFactory = AssSubtitleParserFactory(handler)
      base.withAssMkvSupport(parserFactory, handler)
    }.getOrDefault(base)
  }

  override fun attachPlayer(player: ExoPlayer): Boolean {
    if (released.get()) return false
    if (!playerAttached.compareAndSet(false, true)) return true
    return runCatching {
      handler.init(player)
      true
    }.onFailure { err ->
      playerAttached.set(false)
      Log.w(TAG, "AssHandler.init failed (${err.javaClass.simpleName}); falling back to SubtitleView")
    }.getOrDefault(false)
  }

  override fun createOverlayView(context: Context): View? {
    if (released.get()) return null
    return runCatching {
      AssSubtitleView(context, handler).apply {
        isFocusable = false
      }
    }.onFailure { err ->
      Log.w(TAG, "AssSubtitleView creation failed (${err.javaClass.simpleName}); falling back to SubtitleView")
    }.getOrNull()
  }

  override fun clearForZap() {
    if (released.get()) return
    // Keep videoTimeCallback and renderCallback intact across zaps on a reused ExoPlayer;
    // AssHandler.onMediaItemTransition clears transient track/render state on media change.
  }

  override fun release() {
    if (!released.compareAndSet(false, true)) return
    runCatching {
      handler.videoTimeCallback = null
      handler.renderCallback = null
      if (playerAttached.getAndSet(false)) {
        handler.release()
      }
    }
  }
}

/**
 * Default native `libass-android` (`ass-media`) handle factory (`#223`).
 * Eagerly probes `handler.ass` inside [runCatching] so `UnsatisfiedLinkError`, `NoClassDefFoundError`, or GL init
 * errors on headless devices and Robolectric JVM runners degrade cleanly to Media3's standard `SubtitleView`.
 */
@OptIn(UnstableApi::class)
internal fun defaultCreateAssOverlayHandle(renderType: AssRenderType): AssOverlayHandle? =
  runCatching {
    val handler = AssHandler(renderType)
    // Probe native libass JNI loading inside runCatching before wiring renderers or GL overlay views.
    handler.ass
    RealAssOverlayHandle(handler)
  }.onFailure { err ->
    Log.w(TAG, "Native ASS OpenGL overlay unavailable (${err.javaClass.simpleName}); using SubtitleView fallback")
  }.getOrNull()

/**
 * Coordinates the optional LGPL-verified `libass` OpenGL subtitle overlay across `Media3Engine` player builds,
 * zaps, `stop()`, `recreate()`, and `dispose()` (`#223`).
 */
@OptIn(UnstableApi::class)
internal class AssOverlayBridge(
  private val renderType: AssRenderType = AssRenderType.OVERLAY_OPEN_GL,
  private val handleFactory: (AssRenderType) -> AssOverlayHandle? = ::defaultCreateAssOverlayHandle,
) {
  @Volatile
  private var currentHandle: AssOverlayHandle? = null

  /** Currently active overlay handle, or `null` when unavailable/released (fallback to `SubtitleView`). */
  val activeHandle: AssOverlayHandle?
    get() = currentHandle

  /** True when native ASS/SSA OpenGL overlay is active for the current player instance. */
  val isActive: Boolean
    get() = currentHandle != null

  /** Tears down any previous session and initializes a fresh [AssOverlayHandle] for a new `ExoPlayer` instance. */
  fun beginPlayerSession(): AssOverlayHandle? {
    release()
    val created = runCatching { handleFactory(renderType) }.getOrNull()
    currentHandle = created
    return created
  }

  /** Decorates [base] with [AssRenderersFactory] when active, returning [base] untouched on fallback. */
  fun wrapRenderersFactory(base: RenderersFactory): RenderersFactory =
    currentHandle?.wrapRenderersFactory(base) ?: base

  /** Decorates progressive [base] extractors with ASS Matroska support when active. */
  fun wrapExtractorsFactory(base: ExtractorsFactory): ExtractorsFactory =
    currentHandle?.wrapExtractorsFactory(base) ?: base

  /** Attaches [player] to the active handle; tears down and falls back cleanly if attach fails. */
  fun attachPlayer(player: ExoPlayer): Boolean {
    val handle = currentHandle ?: return false
    val ok = runCatching { handle.attachPlayer(player) }.getOrDefault(false)
    if (!ok) {
      release()
      return false
    }
    return true
  }

  /** Clears transient ASS overlay callbacks on channel zap or stop without crashing. */
  fun clearForZap() {
    currentHandle?.clearForZap()
  }

  /** Releases the active handle and clears all references; strictly idempotent across repeated calls. */
  fun release() {
    val handle = currentHandle ?: return
    currentHandle = null
    runCatching { handle.release() }
  }
}

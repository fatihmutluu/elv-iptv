package io.github.fatihmutluu.elv.media3

import android.os.SystemClock
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Collections

/**
 * Exposes the Media3 engine as the shared object class `Engine` with the player core spec 5.1 commands and the
 * `onEngineEvent` event, plus `uptimeMs()`, the clock of every event's `atMs`, and the view `Media3SurfaceView`
 * whose `engine` prop binds it to an engine and whose `resizeMode` prop (`fit`, `fill`) shapes the picture. Engines
 * still alive when the module goes (JavaScript reload) are disposed, so no player outlives its runtime.
 */
class ElvEngineMedia3Module : Module() {
  private val engines: MutableSet<Media3Engine> = Collections.synchronizedSet(mutableSetOf())

  override fun definition() = ModuleDefinition {
    Name("ElvEngineMedia3")

    Function("uptimeMs") {
      SystemClock.uptimeMillis().toDouble()
    }

    OnDestroy {
      val alive = synchronized(engines) { engines.toList() }
      alive.forEach { it.dispose() }
    }

    Class("Engine", Media3Engine::class) {
      Constructor {
        val context = appContext.reactContext?.applicationContext ?: throw Exceptions.ReactContextLost()
        Media3Engine(context, appContext) { engines.remove(it) }.also { engines.add(it) }
      }

      Events("onEngineEvent")

      Function("load") { engine: Media3Engine, args: Map<String, Any?> ->
        val (attempt, request) = parseLoadArgs(args)
        engine.load(attempt, request)
      }

      Function("retry") { engine: Media3Engine, attempt: Int -> engine.retry(attempt) }

      Function("play") { engine: Media3Engine, attempt: Int -> engine.play(attempt) }

      Function("pause") { engine: Media3Engine, attempt: Int -> engine.pause(attempt) }

      Function("seek") { engine: Media3Engine, attempt: Int, positionMs: Double ->
        engine.seek(attempt, positionMs.toLong())
      }

      Function("selectAudioTrack") { engine: Media3Engine, attempt: Int, id: String ->
        engine.selectAudioTrack(attempt, id)
      }

      Function("selectSubtitleTrack") { engine: Media3Engine, attempt: Int, id: String? ->
        engine.selectSubtitleTrack(attempt, id)
      }

      Function("stop") { engine: Media3Engine, attempt: Int -> engine.stop(attempt) }

      Function("recreate") { engine: Media3Engine, attempt: Int -> engine.recreate(attempt) }
    }

    View(Media3SurfaceView::class) {
      Prop("engine") { view: Media3SurfaceView, engine: Media3Engine? -> view.bind(engine) }

      Prop("resizeMode") { view: Media3SurfaceView, mode: String? -> view.setResizeMode(mode) }

      OnViewDestroys { view: Media3SurfaceView -> view.bind(null) }
    }
  }
}

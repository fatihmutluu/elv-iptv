package io.github.fatihmutluu.elv.media3

import android.os.SystemClock
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.util.Collections

/** The JavaScript `load` argument: a flattened `LoadCommand`. */
class LoadArgs : Record {
  @Field val attempt: Int = 0

  @Field val url: String = ""

  @Field val headers: Map<String, String> = emptyMap()

  @Field val kind: String = "live"

  @Field val startMs: Double? = null

  @Field val softwareAudio: Boolean = false

  internal fun toRequest() =
    LoadRequest(
      url = url,
      headers = headers,
      live = kind != "vod",
      startMs = startMs?.toLong(),
      softwareAudio = softwareAudio,
    )
}

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

      Function("load") { engine: Media3Engine, args: LoadArgs ->
        engine.load(args.attempt, args.toRequest())
      }

      Function("retry") { engine: Media3Engine, attempt: Int -> engine.retry(attempt) }

      Function("play") { engine: Media3Engine, attempt: Int -> engine.play(attempt) }

      Function("pause") { engine: Media3Engine, attempt: Int -> engine.pause(attempt) }

      Function("seek") { engine: Media3Engine, attempt: Int, positionMs: Double ->
        engine.seek(attempt, positionMs.toLong())
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

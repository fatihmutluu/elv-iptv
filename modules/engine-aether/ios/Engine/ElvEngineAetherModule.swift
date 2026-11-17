import AetherEngine
import ExpoModulesCore
import Foundation

/// Flattened `LoadCommand` record sent from JavaScript (`@elv/playback`'s `bridgeNativeEngine`).
struct LoadArgs: Record {
  @Field var attempt: Int = 0
  @Field var url: String = ""
  @Field var headers: [String: String] = [:]
  @Field var kind: String = "live"
  @Field var startMs: Double? = nil
  @Field var softwareAudio: Bool = false
  @Field var audioTrackId: String? = nil
  @Field var subtitleTrackId: ValueOrUndefined<String?> = .undefined

  init() {}

  func toLoadRequest() -> LoadRequest {
    let trimmedAudio = audioTrackId?.trimmingCharacters(in: .whitespacesAndNewlines)
    let subtitlePref: SubtitlePreference
    switch subtitleTrackId {
    case .undefined:
      subtitlePref = .default
    case let .value(unwrapped):
      if let raw = unwrapped?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty {
        subtitlePref = .selected(raw)
      } else {
        subtitlePref = .off
      }
    }
    return LoadRequest(
      url: url,
      headers: headers,
      live: kind != "vod",
      startMs: startMs,
      softwareAudio: softwareAudio,
      audioTrackId: (trimmedAudio?.isEmpty == false) ? trimmedAudio : nil,
      subtitlePreference: subtitlePref
    )
  }
}

/// Expo native module exposing `AetherEngine` behind the `PlayerEngine` port on tvOS, iOS and iPadOS.
public final class ElvEngineAetherModule: Module {
  private let enginesLock = NSLock()
  private var liveEngines = Set<ObjectIdentifier>()
  private var engineTable: [ObjectIdentifier: EngineObject] = [:]

  public func definition() -> ModuleDefinition {
    Name("ElvEngineAether")

    Function("uptimeMs") { () -> Double in
      ProcessInfo.processInfo.systemUptime * 1_000.0
    }

    Function("engineVersion") { () -> String in
      AetherEngine.version
    }

    OnDestroy {
      let remaining: [EngineObject] = self.enginesLock.withLock {
        let list = Array(self.engineTable.values)
        self.engineTable.removeAll()
        self.liveEngines.removeAll()
        return list
      }
      for engine in remaining {
        engine.dispose()
      }
    }

    Class("Engine", EngineObject.self) {
      Constructor { () -> EngineObject in
        let instance = EngineObject { [weak self] disposed in
          self?.unregister(disposed)
        }
        self.register(instance)
        return instance
      }

      Function("load") { (engine: EngineObject, args: LoadArgs) in
        engine.load(args.toLoadRequest(), attempt: args.attempt)
      }

      Function("retry") { (engine: EngineObject, attempt: Int) in
        engine.retry(attempt)
      }

      Function("play") { (engine: EngineObject, attempt: Int) in
        engine.play(attempt)
      }

      Function("pause") { (engine: EngineObject, attempt: Int) in
        engine.pause(attempt)
      }

      Function("seek") { (engine: EngineObject, attempt: Int, positionMs: Double) in
        engine.seek(attempt, positionMs: positionMs)
      }

      Function("selectAudioTrack") { (engine: EngineObject, attempt: Int, id: String) in
        engine.selectAudioTrack(attempt, id: id)
      }

      Function("selectSubtitleTrack") { (engine: EngineObject, attempt: Int, id: String?) in
        engine.selectSubtitleTrack(attempt, id: id)
      }

      Function("stop") { (engine: EngineObject, attempt: Int) in
        engine.stop(attempt)
      }

      Function("recreate") { (engine: EngineObject, attempt: Int) in
        engine.recreate(attempt)
      }
    }

    View(AetherSurfaceView.self) {
      Prop("engine") { (view: AetherSurfaceView, engine: EngineObject?) in
        view.bind(engine)
      }

      Prop("resizeMode") { (view: AetherSurfaceView, mode: String?) in
        view.setResizeMode(mode)
      }
    }
  }

  private func register(_ engine: EngineObject) {
    let key = ObjectIdentifier(engine)
    enginesLock.withLock {
      liveEngines.insert(key)
      engineTable[key] = engine
    }
  }

  private func unregister(_ engine: EngineObject) {
    let key = ObjectIdentifier(engine)
    enginesLock.withLock {
      _ = liveEngines.remove(key)
      _ = engineTable.removeValue(forKey: key)
    }
  }
}

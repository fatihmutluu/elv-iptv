import AetherEngine
import ExpoModulesCore

/// Expo native module exposing AetherEngine for Apple tvOS, iOS and iPadOS builds.
public final class ElvEngineAetherModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ElvEngineAether")

    Function("engineVersion") { () -> String in
      AetherEngine.version
    }
  }
}

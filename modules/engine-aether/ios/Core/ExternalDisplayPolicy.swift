import Foundation

/// Active video render host target for `AetherSurfaceView`'s subviews (`#258`).
public enum ExternalDisplayHostTarget: Equatable, Sendable {
  case inline
  case external(sceneId: String)
}

/// Snapshot of routing, surface availability, and PiP gating computed by `ExternalDisplayPolicy` (`#258`).
public struct ExternalDisplayTransition: Equatable, Sendable {
  public let hostTarget: ExternalDisplayHostTarget
  public let isExternalDisplayActive: Bool
  public let effectiveSurfaceAvailable: Bool
  public let shouldAllowPip: Bool

  public init(
    hostTarget: ExternalDisplayHostTarget,
    isExternalDisplayActive: Bool,
    effectiveSurfaceAvailable: Bool,
    shouldAllowPip: Bool
  ) {
    self.hostTarget = hostTarget
    self.isExternalDisplayActive = isExternalDisplayActive
    self.effectiveSurfaceAvailable = effectiveSurfaceAvailable
    self.shouldAllowPip = shouldAllowPip
  }
}

/// Pure platform-agnostic state machine coordinating inline vs dedicated external `UIWindowScene` video hosting (`#258`).
public struct ExternalDisplayPolicy: Equatable, Sendable {
  public private(set) var inlineSurfaceAttached: Bool
  public private(set) var boundEngineId: String?
  public private(set) var connectedExternalSceneId: String?
  public private(set) var hostedOnExternalDisplay: Bool
  public private(set) var appInBackground: Bool

  public init(
    inlineSurfaceAttached: Bool = false,
    boundEngineId: String? = nil,
    connectedExternalSceneId: String? = nil,
    appInBackground: Bool = false
  ) {
    let normalizedEngine = Self.normalizeId(boundEngineId)
    let normalizedScene = Self.normalizeId(connectedExternalSceneId)
    self.inlineSurfaceAttached = inlineSurfaceAttached
    self.boundEngineId = normalizedEngine
    self.connectedExternalSceneId = normalizedScene
    self.appInBackground = appInBackground
    self.hostedOnExternalDisplay = (normalizedEngine != nil && normalizedScene != nil)
  }

  /// Current evaluated routing, surface availability, and PiP gating snapshot.
  public var currentTransition: ExternalDisplayTransition {
    let target: ExternalDisplayHostTarget
    if hostedOnExternalDisplay, let sceneId = connectedExternalSceneId {
      target = .external(sceneId: sceneId)
    } else {
      target = .inline
    }
    let effectiveSurfaceAvailable =
      boundEngineId != nil && !appInBackground && (inlineSurfaceAttached || hostedOnExternalDisplay)
    return ExternalDisplayTransition(
      hostTarget: target,
      isExternalDisplayActive: hostedOnExternalDisplay,
      effectiveSurfaceAvailable: effectiveSurfaceAvailable,
      shouldAllowPip: !hostedOnExternalDisplay
    )
  }

  /// Records whether the inline `AetherSurfaceView` is currently attached to a handheld window.
  @discardableResult
  public mutating func setInlineSurfaceAttached(_ attached: Bool) -> ExternalDisplayTransition {
    inlineSurfaceAttached = attached
    recomputeHosting()
    return currentTransition
  }

  /// Updates the active bound engine identifier (`nil` releases external hosting cleanly).
  @discardableResult
  public mutating func setBoundEngine(_ engineId: String?) -> ExternalDisplayTransition {
    boundEngineId = Self.normalizeId(engineId)
    recomputeHosting()
    return currentTransition
  }

  /// Registers a connected external non-interactive `UIWindowScene`.
  @discardableResult
  public mutating func connectExternalScene(_ sceneId: String) -> ExternalDisplayTransition {
    guard let normalized = Self.normalizeId(sceneId) else {
      return currentTransition
    }
    connectedExternalSceneId = normalized
    recomputeHosting()
    return currentTransition
  }

  /// Unregisters a disconnected external `UIWindowScene`, ignoring stale scene identifiers.
  @discardableResult
  public mutating func disconnectExternalScene(_ sceneId: String) -> ExternalDisplayTransition {
    guard let normalized = Self.normalizeId(sceneId), connectedExternalSceneId == normalized else {
      return currentTransition
    }
    connectedExternalSceneId = nil
    recomputeHosting()
    return currentTransition
  }

  /// Records host app foreground/background lifecycle transitions.
  @discardableResult
  public mutating func setAppInBackground(_ inBackground: Bool) -> ExternalDisplayTransition {
    appInBackground = inBackground
    recomputeHosting()
    return currentTransition
  }

  /// Releases the bound engine and inline surface while keeping any connected external scene registered.
  @discardableResult
  public mutating func unbind() -> ExternalDisplayTransition {
    boundEngineId = nil
    inlineSurfaceAttached = false
    recomputeHosting()
    return currentTransition
  }

  private mutating func recomputeHosting() {
    hostedOnExternalDisplay = (boundEngineId != nil && connectedExternalSceneId != nil)
  }

  private static func normalizeId(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

#if os(iOS)
import UIKit

/// Main-actor coordinator routing `AetherSurfaceView`'s video, subtitle, and shutter views onto a connected
/// non-interactive external `UIWindowScene` without disrupting `AetherEngine` or causing `surface-lost` (`#258`).
@MainActor
final class AetherExternalDisplayManager {
  static let shared = AetherExternalDisplayManager()

  private var policy = ExternalDisplayPolicy()
  private var externalContainers: [String: UIView] = [:]
  private var externalSceneOrder: [String] = []
  private weak var activeSurface: AetherSurfaceView?
  private weak var activeEngine: EngineObject?
  private var hostedSurfaceId: ObjectIdentifier?
  private var hostedSceneId: String?
  private var hostedPlayerViewId: ObjectIdentifier?
  private weak var hostedPlayerView: UIView?
  private weak var hostedSubtitleView: UIView?
  private weak var hostedShutterView: UIView?
  private var lifecycleObservers: [NSObjectProtocol] = []

  private init() {
    installLifecycleObservers()
  }

  private func installLifecycleObservers() {
    _ = policy.setAppInBackground(UIApplication.shared.applicationState == .background)
    let center = NotificationCenter.default
    let backgroundToken = center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        self?.handleAppBackgroundChanged(true)
      }
    }
    let foregroundToken = center.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        self?.handleAppBackgroundChanged(false)
      }
    }
    let activeToken = center.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        self?.handleAppBackgroundChanged(false)
      }
    }
    lifecycleObservers = [backgroundToken, foregroundToken, activeToken]
  }

  /// Registers a connected external non-interactive `UIWindowScene` container view.
  func registerExternalScene(id: String, containerView: UIView) {
    let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    externalContainers[trimmed] = containerView
    if !externalSceneOrder.contains(trimmed) {
      externalSceneOrder.append(trimmed)
    }
    _ = policy.connectExternalScene(trimmed)
    reconcile()
  }

  /// Unregisters a disconnected external `UIWindowScene` and restores inline hosting if needed.
  func unregisterExternalScene(id: String) {
    let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    externalContainers.removeValue(forKey: trimmed)
    externalSceneOrder.removeAll { $0 == trimmed }
    _ = policy.disconnectExternalScene(trimmed)
    if policy.connectedExternalSceneId == nil, let fallbackId = externalSceneOrder.last {
      _ = policy.connectExternalScene(fallbackId)
    }
    reconcile()
  }

  /// Registers an `AetherSurfaceView` bound to an `EngineObject` for external-display routing.
  func registerSurface(_ surface: AetherSurfaceView, engine: EngineObject) {
    cleanupOrphanedHostedViewsIfNeeded()
    if let current = activeSurface, current !== surface {
      if let currentEngine = activeEngine, currentEngine.isPrimaryAudioOwner, !engine.isPrimaryAudioOwner {
        return
      }
      restoreToInline(surface: current, engine: activeEngine)
    }
    activeSurface = surface
    activeEngine = engine
    _ = policy.setAppInBackground(surface.isAppInBackground)
    _ = policy.setInlineSurfaceAttached(surface.window != nil)
    _ = policy.setBoundEngine(Self.engineIdentifier(for: engine))
    reconcile()
  }

  /// Releases external-display hosting when a surface unbinds or its bound engine detaches.
  func unregisterSurface(_ surface: AetherSurfaceView, engine: EngineObject? = nil) {
    guard activeSurface === surface else { return }
    let previousEngine = engine ?? activeEngine
    restoreToInline(surface: surface, engine: previousEngine)
    activeSurface = nil
    activeEngine = nil
    _ = policy.unbind()
  }

  /// Notifies the manager when the active inline surface attaches to or detaches from its handheld window.
  func surfaceWindowDidChange(_ surface: AetherSurfaceView, attached: Bool) {
    guard activeSurface === surface else { return }
    _ = policy.setInlineSurfaceAttached(attached)
    reconcile()
  }

  /// Updates app foreground/background state in the external display policy.
  func handleAppBackgroundChanged(_ inBackground: Bool) {
    _ = policy.setAppInBackground(inBackground)
    reconcile()
  }

  /// Cleans up externally hosted subviews if an `AetherSurfaceView` is deallocated before explicit unbind.
  func cleanupDestroyedSurface(playerViewId: ObjectIdentifier) {
    guard hostedPlayerViewId == playerViewId else { return }
    let engine = activeEngine
    clearHostedViewsFromExternalContainer()
    activeSurface = nil
    activeEngine = nil
    _ = policy.unbind()
    engine?.withDriver { driver in
      driver.setExternalDisplayActive(false)
    }
  }

  private func reconcile() {
    cleanupOrphanedHostedViewsIfNeeded()
    guard let surface = activeSurface else {
      if policy.boundEngineId != nil {
        _ = policy.unbind()
      }
      return
    }

    let transition = policy.currentTransition
    switch transition.hostTarget {
    case let .external(sceneId):
      guard let container = externalContainers[sceneId] else {
        restoreToInline(surface: surface, engine: activeEngine)
        return
      }
      routeToExternal(surface: surface, engine: activeEngine, sceneId: sceneId, container: container)

    case .inline:
      restoreToInline(surface: surface, engine: activeEngine)
    }
  }

  private func routeToExternal(
    surface: AetherSurfaceView,
    engine: EngineObject?,
    sceneId: String,
    container: UIView
  ) {
    let surfaceId = ObjectIdentifier(surface)
    let alreadyHostedHere = (hostedSurfaceId == surfaceId && hostedSceneId == sceneId && surface.isExternallyHosted)

    // Mark externally hosted BEFORE reparenting so surface availability never dips to false.
    surface.setExternallyHosted(true)

    let targetBounds = container.bounds
    let views: [UIView] = [surface.playerView, surface.subtitleOverlayView, surface.shutterView]
    for view in views {
      view.frame = targetBounds
      view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
      if view.superview !== container {
        container.addSubview(view)
      }
    }
    container.bringSubviewToFront(surface.subtitleOverlayView)
    container.bringSubviewToFront(surface.shutterView)

    hostedSurfaceId = surfaceId
    hostedSceneId = sceneId
    hostedPlayerViewId = ObjectIdentifier(surface.playerView)
    hostedPlayerView = surface.playerView
    hostedSubtitleView = surface.subtitleOverlayView
    hostedShutterView = surface.shutterView

    if !alreadyHostedHere {
      engine?.withDriver { driver in
        driver.setExternalDisplayActive(true)
      }
    }
  }

  private func restoreToInline(surface: AetherSurfaceView, engine: EngineObject?) {
    let surfaceId = ObjectIdentifier(surface)
    let wasHosted = surface.isExternallyHosted || hostedSurfaceId == surfaceId

    surface.playerView.autoresizingMask = []
    surface.subtitleOverlayView.autoresizingMask = []
    surface.shutterView.autoresizingMask = []

    if surface.playerView.superview !== surface {
      surface.insertSubview(surface.playerView, at: 0)
    }
    if surface.subtitleOverlayView.superview !== surface {
      surface.insertSubview(surface.subtitleOverlayView, aboveSubview: surface.playerView)
    }
    if surface.shutterView.superview !== surface {
      surface.insertSubview(surface.shutterView, aboveSubview: surface.subtitleOverlayView)
    }

    if hostedSurfaceId == surfaceId {
      hostedSurfaceId = nil
      hostedSceneId = nil
      hostedPlayerViewId = nil
      hostedPlayerView = nil
      hostedSubtitleView = nil
      hostedShutterView = nil
    }

    surface.setExternallyHosted(false)
    surface.setNeedsLayout()
    if surface.window != nil {
      surface.layoutIfNeeded()
    }

    if wasHosted {
      engine?.withDriver { driver in
        driver.setExternalDisplayActive(false)
      }
    }
  }

  private func cleanupOrphanedHostedViewsIfNeeded() {
    guard activeSurface == nil, hostedSurfaceId != nil else { return }
    clearHostedViewsFromExternalContainer()
  }

  private func clearHostedViewsFromExternalContainer() {
    hostedPlayerView?.removeFromSuperview()
    hostedSubtitleView?.removeFromSuperview()
    hostedShutterView?.removeFromSuperview()
    hostedSurfaceId = nil
    hostedSceneId = nil
    hostedPlayerViewId = nil
    hostedPlayerView = nil
    hostedSubtitleView = nil
    hostedShutterView = nil
  }

  private static func engineIdentifier(for engine: EngineObject) -> String {
    String(describing: ObjectIdentifier(engine))
  }
}
#endif

import Foundation
import UIKit

/// Thread-safe event hub forwarding iOS safe-area inset updates and iPadOS hardware key actions
/// from `AetherSurfaceView` and window lifecycle notifications into `ElvEngineAetherModule` (`#415`).
final class AppleModuleEventHub: @unchecked Sendable {
  static let shared = AppleModuleEventHub()

  private let lock = NSLock()
  private weak var module: ElvEngineAetherModule?
  #if os(iOS)
  private var cachedInsets: SurfaceEdgeInsets = .zero
  private var hasInitializedInsets = false
  #endif
  private var observingSafeArea = false
  private var observingHardwareKey = false
  private var tokens: [NSObjectProtocol] = []

  private init() {}

  func attach(module: ElvEngineAetherModule) {
    let oldTokens: [NSObjectProtocol] = lock.withLock {
      self.module = module
      let drained = tokens
      tokens.removeAll()
      return drained
    }
    for token in oldTokens {
      NotificationCenter.default.removeObserver(token)
    }

    #if os(iOS)
    let center = NotificationCenter.default
    let orientationToken = center.addObserver(
      forName: UIDevice.orientationDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        self?.refreshWindowSafeAreaInsets(forceEmit: false)
        // Schedule a follow-up pass after UIKit finishes rotating window safe-area geometry.
        DispatchQueue.main.async {
          MainActor.assumeIsolated {
            self?.refreshWindowSafeAreaInsets(forceEmit: false)
          }
        }
      }
    }
    let activeToken = center.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        self?.refreshWindowSafeAreaInsets(forceEmit: false)
      }
    }
    lock.withLock {
      tokens = [orientationToken, activeToken]
    }
    AetherBackend.onMainActor { [weak self] in
      self?.refreshWindowSafeAreaInsets(forceEmit: false)
    }
    #endif
  }

  func detach(module: ElvEngineAetherModule) {
    let drained: [NSObjectProtocol] = lock.withLock {
      guard self.module === module else { return [] }
      self.module = nil
      observingSafeArea = false
      observingHardwareKey = false
      let out = tokens
      tokens.removeAll()
      return out
    }
    for token in drained {
      NotificationCenter.default.removeObserver(token)
    }
  }

  func setObservingSafeArea(_ observing: Bool, from module: ElvEngineAetherModule) {
    lock.withLock {
      self.module = module
      observingSafeArea = observing
    }
    #if os(iOS)
    if observing {
      AetherBackend.onMainActor { [weak self] in
        self?.refreshWindowSafeAreaInsets(forceEmit: true)
      }
    }
    #endif
  }

  func setObservingHardwareKey(_ observing: Bool, from module: ElvEngineAetherModule) {
    lock.withLock {
      self.module = module
      observingHardwareKey = observing
    }
  }

  func currentSafeAreaInsetsDictionary() -> [String: Double] {
    #if os(iOS)
    if Thread.isMainThread {
      let live = MainActor.assumeIsolated {
        Self.readKeyWindowSafeAreaInsets()
      }
      lock.withLock {
        cachedInsets = live
        hasInitializedInsets = true
      }
      return Self.toDictionary(live)
    }
    let snapshot: (insets: SurfaceEdgeInsets, initialized: Bool) = lock.withLock {
      (cachedInsets, hasInitializedInsets)
    }
    if !snapshot.initialized {
      AetherBackend.onMainActor { [weak self] in
        self?.refreshWindowSafeAreaInsets(forceEmit: false)
      }
    }
    return Self.toDictionary(snapshot.insets)
    #else
    return Self.toDictionary(.zero)
    #endif
  }

  #if os(iOS)
  @MainActor
  func reportSafeAreaInsets(_ insets: SurfaceEdgeInsets, forceEmit: Bool = false) {
    let target: ElvEngineAetherModule? = lock.withLock {
      let changed = !hasInitializedInsets || cachedInsets != insets
      cachedInsets = insets
      hasInitializedInsets = true
      guard observingSafeArea, changed || forceEmit else { return nil }
      return module
    }
    target?.emit(event: "onSafeAreaInsetsChanged", payload: Self.toDictionary(insets))
  }

  @MainActor
  func emitHardwareKey(_ key: String) {
    let target: ElvEngineAetherModule? = lock.withLock {
      guard observingHardwareKey else { return nil }
      return module
    }
    target?.emit(event: "onHardwareKey", payload: ["key": key])
  }

  @MainActor
  private func refreshWindowSafeAreaInsets(forceEmit: Bool) {
    reportSafeAreaInsets(Self.readKeyWindowSafeAreaInsets(), forceEmit: forceEmit)
  }

  @MainActor
  private static func readKeyWindowSafeAreaInsets() -> SurfaceEdgeInsets {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let activeScene = scenes.first(where: { $0.activationState == .foregroundActive })
      ?? scenes.first(where: { $0.activationState == .foregroundInactive })
      ?? scenes.first
    let window = activeScene?.windows.first(where: { $0.isKeyWindow })
      ?? activeScene?.windows.first
    guard let insets = window?.safeAreaInsets else { return .zero }
    return SurfaceEdgeInsets(
      top: Double(insets.top),
      left: Double(insets.left),
      bottom: Double(insets.bottom),
      right: Double(insets.right)
    )
  }
  #endif

  @MainActor
  func emitPictureInPictureChanged(_ inPip: Bool) {
    let target: ElvEngineAetherModule? = lock.withLock { module }
    target?.emit(event: "onPictureInPictureChanged", payload: ["inPip": inPip])
  }

  private static func toDictionary(_ insets: SurfaceEdgeInsets) -> [String: Double] {
    [
      "top": insets.top,
      "right": insets.right,
      "bottom": insets.bottom,
      "left": insets.left,
    ]
  }
}

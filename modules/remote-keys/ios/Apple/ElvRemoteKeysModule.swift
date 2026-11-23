import ExpoModulesCore
import Foundation

#if os(tvOS)
import UIKit
import UIKit.UIGestureRecognizerSubclass

@MainActor
private final class TvPressObserverGestureRecognizer: UIGestureRecognizer, UIGestureRecognizerDelegate {
  var onPressBegan: ((ApplePressKind, Double) -> Void)?
  var onPressEnded: ((ApplePressKind, Bool, Double) -> Void)?

  override init(target: Any?, action: Selector?) {
    super.init(target: target, action: action)
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
    allowedPressTypes = [
      NSNumber(value: UIPress.PressType.upArrow.rawValue),
      NSNumber(value: UIPress.PressType.downArrow.rawValue),
      NSNumber(value: UIPress.PressType.leftArrow.rawValue),
      NSNumber(value: UIPress.PressType.rightArrow.rawValue),
      NSNumber(value: UIPress.PressType.select.rawValue),
      NSNumber(value: UIPress.PressType.menu.rawValue),
      NSNumber(value: UIPress.PressType.playPause.rawValue),
      NSNumber(value: UIPress.PressType.pageUp.rawValue),
      NSNumber(value: UIPress.PressType.pageDown.rawValue),
    ]
    delegate = self
  }

  convenience init() {
    self.init(target: nil, action: nil)
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool {
    false
  }

  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool {
    false
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent) {
    super.pressesBegan(presses, with: event)
    let nowMs = ProcessInfo.processInfo.systemUptime * 1_000.0
    for press in presses {
      if let kind = Self.mapPressType(press.type) {
        onPressBegan?(kind, nowMs)
      }
    }
  }

  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent) {
    super.pressesEnded(presses, with: event)
    let nowMs = ProcessInfo.processInfo.systemUptime * 1_000.0
    for press in presses {
      if let kind = Self.mapPressType(press.type) {
        onPressEnded?(kind, false, nowMs)
      }
    }
  }

  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent) {
    super.pressesCancelled(presses, with: event)
    let nowMs = ProcessInfo.processInfo.systemUptime * 1_000.0
    for press in presses {
      if let kind = Self.mapPressType(press.type) {
        onPressEnded?(kind, true, nowMs)
      }
    }
  }

  private static func mapPressType(_ type: UIPress.PressType) -> ApplePressKind? {
    switch type {
    case .upArrow:
      return .upArrow
    case .downArrow:
      return .downArrow
    case .leftArrow:
      return .leftArrow
    case .rightArrow:
      return .rightArrow
    case .select:
      return .select
    case .menu:
      return .menu
    case .playPause:
      return .playPause
    case .pageUp:
      return .pageUp
    case .pageDown:
      return .pageDown
    @unknown default:
      return nil
    }
  }
}

@MainActor
private final class TvDirectionalPanGestureRecognizer: UIPanGestureRecognizer, UIGestureRecognizerDelegate {
  override init(target: Any?, action: Selector?) {
    super.init(target: target, action: action)
    allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirect.rawValue)]
    cancelsTouchesInView = false
    delaysTouchesBegan = false
    delaysTouchesEnded = false
    isEnabled = false
    delegate = self
  }

  override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool {
    false
  }

  override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool {
    false
  }

  func gestureRecognizer(
    _ gestureRecognizer: UIGestureRecognizer,
    shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer
  ) -> Bool {
    true
  }
}

@MainActor
private final class TvRemoteWindowController: NSObject {
  private weak var module: ElvRemoteKeysModule?
  private weak var attachedWindow: UIWindow?
  private var pressRecognizer: TvPressObserverGestureRecognizer?
  private var panRecognizer: TvDirectionalPanGestureRecognizer?
  private var pressTracker = ApplePressTracker()
  private var panPolicy = DirectionalPanPolicy()
  private var observingKey = false
  private var observingPan = false
  private var panRequestedEnabled = false
  private var notificationTokens: [NSObjectProtocol] = []

  init(module: ElvRemoteKeysModule) {
    self.module = module
    super.init()
  }

  func setObservingKey(_ observing: Bool) {
    observingKey = observing
    if !observing {
      pressTracker.reset()
    }
    syncAttachments()
  }

  func setObservingPan(_ observing: Bool) {
    observingPan = observing
    if !observing {
      _ = panPolicy.setEnabled(false)
    }
    syncAttachments()
  }

  func setPanGestureEnabled(_ enabled: Bool) {
    panRequestedEnabled = enabled
    let effectiveEnabled = enabled && observingPan
    if let cancelEvent = panPolicy.setEnabled(effectiveEnabled), observingPan {
      module?.emit(event: "onPanGesture", payload: cancelEvent.toPayload())
    }
    syncAttachments()
  }

  func dispose() {
    observingKey = false
    observingPan = false
    panRequestedEnabled = false
    pressTracker.reset()
    panPolicy.reset()
    removeObservers()
    detachRecognizers()
    module = nil
  }

  private func syncAttachments() {
    let needsAny = observingKey || observingPan
    if !needsAny {
      removeObservers()
      detachRecognizers()
      return
    }
    installObserversIfNeeded()
    let targetWindow = resolveKeyWindow()
    if targetWindow !== attachedWindow {
      detachRecognizers()
      attachedWindow = targetWindow
    }
    guard let window = attachedWindow else { return }

    if observingKey {
      if pressRecognizer == nil {
        let recognizer = TvPressObserverGestureRecognizer()
        recognizer.onPressBegan = { [weak self] kind, timeMs in
          self?.handlePressBegan(kind, eventTimeMs: timeMs)
        }
        recognizer.onPressEnded = { [weak self] kind, canceled, timeMs in
          self?.handlePressEnded(kind, canceled: canceled, eventTimeMs: timeMs)
        }
        window.addGestureRecognizer(recognizer)
        pressRecognizer = recognizer
      }
    } else if let recognizer = pressRecognizer {
      recognizer.view?.removeGestureRecognizer(recognizer)
      pressRecognizer = nil
    }

    if observingPan {
      if panRecognizer == nil {
        let recognizer = TvDirectionalPanGestureRecognizer(
          target: self,
          action: #selector(handlePanGesture(_:))
        )
        window.addGestureRecognizer(recognizer)
        panRecognizer = recognizer
      }
      let effectiveEnabled = panRequestedEnabled && observingPan
      if panPolicy.isEnabled != effectiveEnabled {
        if let cancelEvent = panPolicy.setEnabled(effectiveEnabled) {
          module?.emit(event: "onPanGesture", payload: cancelEvent.toPayload())
        }
      }
      panRecognizer?.isEnabled = effectiveEnabled
    } else if let recognizer = panRecognizer {
      recognizer.isEnabled = false
      recognizer.view?.removeGestureRecognizer(recognizer)
      panRecognizer = nil
    }
  }

  private func handlePressBegan(_ kind: ApplePressKind, eventTimeMs: Double) {
    guard observingKey else { return }
    if let event = pressTracker.pressBegan(kind, eventTimeMs: eventTimeMs) {
      module?.emit(event: "onKey", payload: event.toPayload())
    }
  }

  private func handlePressEnded(_ kind: ApplePressKind, canceled: Bool, eventTimeMs: Double) {
    guard observingKey else { return }
    if let event = pressTracker.pressEnded(kind, canceled: canceled, eventTimeMs: eventTimeMs) {
      module?.emit(event: "onKey", payload: event.toPayload())
    }
  }

  @objc
  private func handlePanGesture(_ recognizer: UIPanGestureRecognizer) {
    guard observingPan else { return }
    let mappedState: PanGestureInputState
    switch recognizer.state {
    case .began:
      mappedState = .began
    case .changed:
      mappedState = .changed
    case .ended:
      mappedState = .ended
    case .cancelled, .failed:
      mappedState = .cancelled
    default:
      return
    }
    let translation = recognizer.translation(in: recognizer.view)
    let velocity = recognizer.velocity(in: recognizer.view)
    if let event = panPolicy.update(
      state: mappedState,
      translationX: Double(translation.x),
      translationY: Double(translation.y),
      velocityX: Double(velocity.x),
      velocityY: Double(velocity.y)
    ) {
      module?.emit(event: "onPanGesture", payload: event.toPayload())
    }
  }

  private func installObserversIfNeeded() {
    guard notificationTokens.isEmpty else { return }
    let center = NotificationCenter.default
    let resignToken = center.addObserver(
      forName: UIApplication.willResignActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.handleWillResignActive()
        }
      }
    }
    let activeToken = center.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.syncAttachments()
        }
      }
    }
    let keyWindowToken = center.addObserver(
      forName: UIWindow.didBecomeKeyNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self?.syncAttachments()
        }
      }
    }
    notificationTokens = [resignToken, activeToken, keyWindowToken]
  }

  private func removeObservers() {
    for token in notificationTokens {
      NotificationCenter.default.removeObserver(token)
    }
    notificationTokens.removeAll()
  }

  private func detachRecognizers() {
    if let recognizer = pressRecognizer {
      recognizer.view?.removeGestureRecognizer(recognizer)
      pressRecognizer = nil
    }
    if let recognizer = panRecognizer {
      recognizer.isEnabled = false
      recognizer.view?.removeGestureRecognizer(recognizer)
      panRecognizer = nil
    }
    attachedWindow = nil
  }

  private func handleWillResignActive() {
    if observingKey {
      let blur = pressTracker.handleBlur()
      module?.emit(event: "onKey", payload: blur.toPayload())
    } else {
      pressTracker.reset()
    }
    if panPolicy.lockedAxis != nil {
      if let cancelEvent = panPolicy.setEnabled(false), observingPan {
        module?.emit(event: "onPanGesture", payload: cancelEvent.toPayload())
      }
      _ = panPolicy.setEnabled(panRequestedEnabled && observingPan)
    }
  }

  private func resolveKeyWindow() -> UIWindow? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let activeScene = scenes.first(where: { $0.activationState == .foregroundActive })
      ?? scenes.first(where: { $0.activationState == .foregroundInactive })
      ?? scenes.first
    return activeScene?.windows.first(where: { $0.isKeyWindow })
      ?? activeScene?.windows.first
  }
}
#endif

/// Expo native module forwarding raw tvOS `UIPress` remote events and axis-locked Siri Remote pan gestures
/// (`#414`, `#225`). Compiles as a safe no-op on iOS/iPadOS where touch and hardware keyboards drive navigation.
public final class ElvRemoteKeysModule: Module, @unchecked Sendable {
  #if os(tvOS)
  @MainActor private var controller: TvRemoteWindowController?
  #endif

  public func definition() -> ModuleDefinition {
    Name("ElvRemoteKeys")

    Events("onKey", "onPanGesture")

    Function("uptimeMs") { () -> Double in
      ProcessInfo.processInfo.systemUptime * 1_000.0
    }

    Function("setPanGestureEnabled") { (enabled: Bool) in
      #if os(tvOS)
      self.onMainActor { module in
        module.ensureController().setPanGestureEnabled(enabled)
      }
      #else
      _ = enabled
      #endif
    }

    OnStartObserving("onKey") {
      #if os(tvOS)
      self.onMainActor { module in
        module.ensureController().setObservingKey(true)
      }
      #endif
    }

    OnStopObserving("onKey") {
      #if os(tvOS)
      self.onMainActor { module in
        module.controller?.setObservingKey(false)
      }
      #endif
    }

    OnStartObserving("onPanGesture") {
      #if os(tvOS)
      self.onMainActor { module in
        module.ensureController().setObservingPan(true)
      }
      #endif
    }

    OnStopObserving("onPanGesture") {
      #if os(tvOS)
      self.onMainActor { module in
        module.controller?.setObservingPan(false)
      }
      #endif
    }

    OnDestroy {
      #if os(tvOS)
      // Capture `self` strongly across the main-queue hop so teardown always detaches window
      // gesture recognizers and NotificationCenter observers before deallocation.
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          self.controller?.dispose()
          self.controller = nil
        }
      }
      #endif
    }
  }

  #if os(tvOS)
  @MainActor
  private func ensureController() -> TvRemoteWindowController {
    if let controller {
      return controller
    }
    let created = TvRemoteWindowController(module: self)
    controller = created
    return created
  }

  private func onMainActor(_ body: @escaping @MainActor @Sendable (ElvRemoteKeysModule) -> Void) {
    DispatchQueue.main.async { [weak self] in
      MainActor.assumeIsolated {
        guard let self else { return }
        body(self)
      }
    }
  }
  #endif
}

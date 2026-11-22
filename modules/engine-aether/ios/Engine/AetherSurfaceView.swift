import AetherEngine
import AVFoundation
import ExpoModulesCore
import UIKit

/// Thread-safe cleanup state enabling synchronous `@MainActor` `deinit` teardown without capturing `UIView` across actors.
private final class SurfaceCleanupState: @unchecked Sendable {
  private let lock = NSLock()
  private var tokens: [NSObjectProtocol] = []
  private weak var engine: EngineObject?
  private var ownerId: ObjectIdentifier?
  private var playerViewId: ObjectIdentifier?

  func setTokens(_ next: [NSObjectProtocol]) {
    lock.withLock { tokens = next }
  }

  func updateBinding(engine: EngineObject?, ownerId: ObjectIdentifier?, playerViewId: ObjectIdentifier) {
    lock.withLock {
      self.engine = engine
      self.ownerId = ownerId
      self.playerViewId = (engine == nil) ? nil : playerViewId
    }
  }

  func takeForDeinit() -> (
    tokens: [NSObjectProtocol],
    engine: EngineObject?,
    ownerId: ObjectIdentifier?,
    playerViewId: ObjectIdentifier?
  ) {
    lock.withLock {
      let snapshot = (tokens, engine, ownerId, playerViewId)
      tokens = []
      engine = nil
      ownerId = nil
      playerViewId = nil
      return snapshot
    }
  }
}

/// Unfocusable, non-interactive `UIView` painting the black zap shutter above `AetherPlayerView`.
private final class ShutterOverlayView: UIView {
  override init(frame: CGRect) {
    super.init(frame: frame)
    backgroundColor = .black
    isUserInteractionEnabled = false
    isAccessibilityElement = false
  }

  @available(*, unavailable)
  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override var canBecomeFocused: Bool {
    false
  }
}

/// Native `ExpoView` hosting an `AetherPlayerView` under a native black zap shutter (player core spec 6.2).
final class AetherSurfaceView: ExpoView {
  let playerView = AetherPlayerView(frame: .zero)
  private let subtitleOverlayView = AetherSubtitleOverlayView(frame: .zero)
  private let shutterView = ShutterOverlayView(frame: .zero)
  private let cleanupState = SurfaceCleanupState()

  private weak var boundEngine: EngineObject?
  private var boundOwnerId: ObjectIdentifier?
  private var appInBackground = false
  private var wantsScreenOn = false
  private(set) var currentVideoGravity: AVLayerVideoGravity = .resizeAspect
  private(set) var currentOsdVisible = true

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    MainActor.assumeIsolated {
      configureHierarchy()
      installLifecycleObservers()
    }
  }

  deinit {
    let snapshot = cleanupState.takeForDeinit()
    for token in snapshot.tokens {
      NotificationCenter.default.removeObserver(token)
    }
    guard snapshot.engine != nil || snapshot.ownerId != nil else { return }
    let ownerId = snapshot.ownerId
    let viewId = snapshot.playerViewId
    let engine = snapshot.engine
    AetherBackend.onMainActor { [weak engine] in
      if let ownerId {
        IdleTimer.setHeld(false, ownerId: ownerId)
      }
      if let viewId {
        engine?.detachDestroyedPlayerViewIfLoaded(viewId: viewId)
      }
    }
  }

  override var canBecomeFocused: Bool {
    false
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    playerView.frame = bounds
    subtitleOverlayView.frame = bounds
    shutterView.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    MainActor.assumeIsolated {
      refreshIdleTimer()
      notifySurfaceAvailability(isBackground: isAppInBackground)
    }
  }

  override func prepareForRecycle() {
    super.prepareForRecycle()
    MainActor.assumeIsolated {
      bind(nil)
      setResizeMode("fit")
      setSubtitleBottomInsetPx(0)
      setOsdVisible(true)
    }
  }

  @MainActor
  var isAppInBackground: Bool {
    appInBackground || UIApplication.shared.applicationState == .background
  }

  @MainActor
  var isSurfaceAvailable: Bool {
    window != nil && !isAppInBackground && boundEngine != nil
  }

  @MainActor
  func bind(_ engine: EngineObject?) {
    guard boundEngine !== engine else { return }
    if let prevId = boundOwnerId {
      IdleTimer.setHeld(false, ownerId: prevId)
      boundOwnerId = nil
    }
    if let previous = boundEngine {
      wantsScreenOn = false
      subtitleOverlayView.clear()
      previous.withDriver { driver in
        driver.unbindSurface(self)
      }
      boundEngine = nil
    }
    boundEngine = engine
    boundOwnerId = engine.map(ObjectIdentifier.init)
    cleanupState.updateBinding(
      engine: engine,
      ownerId: boundOwnerId,
      playerViewId: ObjectIdentifier(playerView)
    )
    if let engine {
      engine.withDriver { driver in
        driver.bindSurface(self)
      }
    } else {
      subtitleOverlayView.clear()
      shutterView.isHidden = false
      wantsScreenOn = false
      refreshIdleTimer()
    }
  }

  @MainActor
  func setResizeMode(_ mode: String?) {
    let gravity: AVLayerVideoGravity
    switch mode {
    case "fill":
      gravity = .resizeAspectFill
    case "stretch":
      gravity = .resize
    default:
      gravity = .resizeAspect
    }
    guard gravity != currentVideoGravity else { return }
    currentVideoGravity = gravity
    subtitleOverlayView.updateGravity(gravity)
    boundEngine?.withDriver { driver in
      driver.updateGravity(gravity, from: self)
    }
  }

  @MainActor
  func setSubtitleBottomInsetPx(_ inset: Double?) {
    let clean = inset.flatMap { $0.isFinite && $0 > 0 ? CGFloat($0) : nil } ?? 0
    subtitleOverlayView.updateBottomInset(clean)
  }

  @MainActor
  func setOsdVisible(_ visible: Bool?) {
    let next = visible ?? true
    guard next != currentOsdVisible else { return }
    currentOsdVisible = next
    boundEngine?.withDriver { driver in
      driver.setOsdVisible(next, from: self)
    }
  }

  @MainActor
  func applyShutter(covered: Bool, from engine: EngineObject?) {
    guard let engine, boundEngine === engine else { return }
    shutterView.isHidden = !covered
  }

  @MainActor
  func applySubtitles(_ presentation: SubtitlePresentation, from engine: EngineObject?) {
    guard let engine, boundEngine === engine else { return }
    subtitleOverlayView.apply(presentation)
  }

  @MainActor
  func applyScreenOn(_ on: Bool, from engine: EngineObject?) {
    guard let engine, boundEngine === engine else { return }
    wantsScreenOn = on
    refreshIdleTimer()
  }

  @MainActor
  func detachEngineReference(_ engine: EngineObject?) {
    guard engine == nil || boundEngine === engine else { return }
    boundEngine = nil
    wantsScreenOn = false
    subtitleOverlayView.clear()
    shutterView.isHidden = false
    if let prevId = boundOwnerId {
      boundOwnerId = nil
      IdleTimer.setHeld(false, ownerId: prevId)
    }
    cleanupState.updateBinding(engine: nil, ownerId: nil, playerViewId: ObjectIdentifier(playerView))
  }

  @MainActor
  private func configureHierarchy() {
    backgroundColor = .black
    clipsToBounds = true

    playerView.isUserInteractionEnabled = false
    playerView.isAccessibilityElement = false
    playerView.frame = bounds
    addSubview(playerView)

    subtitleOverlayView.frame = bounds
    addSubview(subtitleOverlayView)

    shutterView.frame = bounds
    addSubview(shutterView)
  }

  @MainActor
  private func installLifecycleObservers() {
    appInBackground = UIApplication.shared.applicationState == .background
    let center = NotificationCenter.default

    let backgroundToken = center.addObserver(
      forName: UIApplication.didEnterBackgroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        guard let self else { return }
        self.appInBackground = true
        self.refreshIdleTimer()
        self.notifySurfaceAvailability(isBackground: true)
      }
    }

    let foregroundToken = center.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        guard let self else { return }
        self.appInBackground = false
        self.refreshIdleTimer()
        self.notifySurfaceAvailability(isBackground: false)
      }
    }

    let activeToken = center.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        guard let self, self.appInBackground else { return }
        self.appInBackground = false
        self.refreshIdleTimer()
        self.notifySurfaceAvailability(isBackground: false)
      }
    }

    cleanupState.setTokens([backgroundToken, foregroundToken, activeToken])
  }

  @MainActor
  private func notifySurfaceAvailability(isBackground: Bool) {
    guard let engine = boundEngine else { return }
    let available = isSurfaceAvailable
    engine.withDriver { driver in
      driver.surfaceAvailabilityDidChange(available, isBackground: isBackground, from: self)
    }
  }

  @MainActor
  private func refreshIdleTimer() {
    guard let ownerId = boundOwnerId else { return }
    let shouldHold = boundEngine != nil && wantsScreenOn && window != nil && !isAppInBackground
    IdleTimer.setHeld(shouldHold, ownerId: ownerId)
  }
}

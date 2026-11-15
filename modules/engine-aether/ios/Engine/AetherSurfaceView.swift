import AetherEngine
import AVFoundation
import ExpoModulesCore
import UIKit

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
  private let shutterView = ShutterOverlayView(frame: .zero)

  private weak var boundEngine: EngineObject?
  private var boundOwnerId: ObjectIdentifier?
  private var appInBackground = false
  private var wantsScreenOn = false
  private(set) var currentVideoGravity: AVLayerVideoGravity = .resizeAspect
  private var notificationTokens: [NSObjectProtocol] = []

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    MainActor.assumeIsolated {
      configureHierarchy()
      installLifecycleObservers()
    }
  }

  deinit {
    let tokens = notificationTokens
    for token in tokens {
      NotificationCenter.default.removeObserver(token)
    }
    let engine = boundEngine
    let ownerId = boundOwnerId
    let view = playerView
    if engine != nil || ownerId != nil {
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          if let ownerId {
            IdleTimer.setHeld(false, ownerId: ownerId)
          }
          engine?.withDriver { driver in
            driver.detachDestroyedPlayerView(view)
          }
        }
      }
    }
  }

  override var canBecomeFocused: Bool {
    false
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    playerView.frame = bounds
    shutterView.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    MainActor.assumeIsolated {
      refreshIdleTimer()
      notifySurfaceAvailability()
    }
  }

  @MainActor
  var isSurfaceAvailable: Bool {
    window != nil && !appInBackground && boundEngine != nil
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
      previous.withDriver { driver in
        driver.unbindSurface(self)
      }
      boundEngine = nil
    }
    boundEngine = engine
    boundOwnerId = engine.map(ObjectIdentifier.init)
    if let engine {
      engine.withDriver { driver in
        driver.bindSurface(self)
      }
    } else {
      shutterView.isHidden = false
      wantsScreenOn = false
      refreshIdleTimer()
    }
  }

  @MainActor
  func setResizeMode(_ mode: String?) {
    let gravity: AVLayerVideoGravity = (mode == "fill") ? .resizeAspectFill : .resizeAspect
    guard gravity != currentVideoGravity else { return }
    currentVideoGravity = gravity
    boundEngine?.withDriver { driver in
      driver.updateGravity(gravity, from: self)
    }
  }

  @MainActor
  func applyShutter(covered: Bool, from engine: EngineObject?) {
    guard let engine, boundEngine === engine else { return }
    shutterView.isHidden = !covered
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
    shutterView.isHidden = false
    if let prevId = boundOwnerId {
      boundOwnerId = nil
      IdleTimer.setHeld(false, ownerId: prevId)
    }
  }

  @MainActor
  private func configureHierarchy() {
    backgroundColor = .black
    clipsToBounds = true

    playerView.isUserInteractionEnabled = false
    playerView.isAccessibilityElement = false
    playerView.frame = bounds
    addSubview(playerView)

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
      MainActor.assumeIsolated {
        guard let self else { return }
        self.appInBackground = true
        self.refreshIdleTimer()
        self.notifySurfaceAvailability()
      }
    }

    let foregroundToken = center.addObserver(
      forName: UIApplication.willEnterForegroundNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.appInBackground = false
        self.refreshIdleTimer()
        self.notifySurfaceAvailability()
      }
    }

    let activeToken = center.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      MainActor.assumeIsolated {
        guard let self, self.appInBackground else { return }
        self.appInBackground = false
        self.refreshIdleTimer()
        self.notifySurfaceAvailability()
      }
    }

    notificationTokens = [backgroundToken, foregroundToken, activeToken]
  }

  @MainActor
  private func notifySurfaceAvailability() {
    guard let engine = boundEngine else { return }
    let available = isSurfaceAvailable
    engine.withDriver { driver in
      driver.surfaceAvailabilityDidChange(available, from: self)
    }
  }

  @MainActor
  private func refreshIdleTimer() {
    guard let ownerId = boundOwnerId else { return }
    let shouldHold = boundEngine != nil && wantsScreenOn && window != nil && !appInBackground
    IdleTimer.setHeld(shouldHold, ownerId: ownerId)
  }
}

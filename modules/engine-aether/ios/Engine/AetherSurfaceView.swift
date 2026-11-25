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

  weak var boundEngine: EngineObject?
  private var boundOwnerId: ObjectIdentifier?
  private var appInBackground = false
  private var wantsScreenOn = false
  private(set) var currentVideoGravity: AVLayerVideoGravity = .resizeAspect
  private var currentResizeMode: SurfaceResizeMode = .fit
  private(set) var currentOsdVisible = true
  private var propSubtitleStyle: UserSubtitleStyleOverride?
  private var engineSubtitleStyle: UserSubtitleStyleOverride?
  private var preferEngineSubtitleStyle = false
  private var coreShutterCovered = true
  private var hdmiSettleActive = false
  private var hdmiSettleTask: Task<Void, Never>?
  private var hdmiSettleSeq = 0
  #if os(iOS)
  var keyboardMapper = HardwareKeyboardMapper()
  private var playbackKeyCommands: [UIKeyCommand] = []
  #endif

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

  #if os(iOS)
  override var canBecomeFirstResponder: Bool {
    MainActor.assumeIsolated {
      window != nil
        && !isAppInBackground
        && boundEngine != nil
        && !isAnyTextInputFirstResponder(in: window)
    }
  }

  override var keyCommands: [UIKeyCommand]? {
    MainActor.assumeIsolated {
      guard window != nil,
            !isAppInBackground,
            boundEngine != nil,
            !isAnyTextInputFirstResponder(in: window)
      else {
        return []
      }
      return playbackKeyCommands
    }
  }
  #endif

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    MainActor.assumeIsolated {
      setNeedsLayout()
      #if os(iOS)
      reportCurrentSafeAreaInsets()
      #endif
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    #if os(iOS)
    let applySafeAreaOnFit = true
    #else
    let applySafeAreaOnFit = false
    #endif
    let insets = SurfaceEdgeInsets(
      top: Double(safeAreaInsets.top),
      left: Double(safeAreaInsets.left),
      bottom: Double(safeAreaInsets.bottom),
      right: Double(safeAreaInsets.right)
    )
    let resolved = resolveSurfaceVideoRect(
      boundsWidth: Double(bounds.width),
      boundsHeight: Double(bounds.height),
      safeAreaInsets: insets,
      resizeMode: currentResizeMode,
      applySafeAreaOnFit: applySafeAreaOnFit
    )
    let videoFrame = CGRect(x: resolved.x, y: resolved.y, width: resolved.width, height: resolved.height)
    playerView.frame = videoFrame
    subtitleOverlayView.frame = videoFrame
    shutterView.frame = bounds
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    MainActor.assumeIsolated {
      refreshIdleTimer()
      notifySurfaceAvailability(isBackground: isDetachingInBackground)
      #if os(iOS)
      if window != nil {
        reportCurrentSafeAreaInsets()
      }
      refreshKeyboardResponder()
      #endif
    }
  }

  override func prepareForRecycle() {
    super.prepareForRecycle()
    MainActor.assumeIsolated {
      bind(nil)
      setResizeMode("fit")
      setSubtitleBottomInsetPx(0)
      setSubtitleFontFamily(nil)
      setSubtitleStyle(nil)
      setOsdVisible(true)
    }
  }

  @MainActor
  var isAppInBackground: Bool {
    appInBackground || UIApplication.shared.applicationState == .background
  }

  /// Treats window teardown while UIKit is inactive/backgrounding as background detach so it never races `didEnterBackgroundNotification` (`#117`).
  @MainActor
  var isDetachingInBackground: Bool {
    isAppInBackground || (window == nil && UIApplication.shared.applicationState != .active)
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
      cancelHdmiShutterSettle()
      wantsScreenOn = false
      engineSubtitleStyle = nil
      preferEngineSubtitleStyle = false
      applyEffectiveSubtitleStyle()
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
      cancelHdmiShutterSettle()
      engineSubtitleStyle = nil
      preferEngineSubtitleStyle = false
      applyEffectiveSubtitleStyle()
      subtitleOverlayView.clear()
      coreShutterCovered = true
      refreshShutterVisibility()
      wantsScreenOn = false
      refreshIdleTimer()
    }
    #if os(iOS)
    refreshKeyboardResponder()
    #endif
  }

  @MainActor
  func setResizeMode(_ mode: String?) {
    let gravity: AVLayerVideoGravity
    let resizeMode: SurfaceResizeMode
    switch mode {
    case "fill":
      gravity = .resizeAspectFill
      resizeMode = .fill
    case "stretch":
      gravity = .resize
      resizeMode = .stretch
    default:
      gravity = .resizeAspect
      resizeMode = .fit
    }
    guard gravity != currentVideoGravity || resizeMode != currentResizeMode else { return }
    currentVideoGravity = gravity
    currentResizeMode = resizeMode
    setNeedsLayout()
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
  func setSubtitleFontFamily(_ family: String?) {
    subtitleOverlayView.updateSubtitleFontFamily(family)
  }

  @MainActor
  func setSubtitleStyle(_ style: UserSubtitleStyleOverride?) {
    if preferEngineSubtitleStyle && style == propSubtitleStyle {
      return
    }
    propSubtitleStyle = style
    preferEngineSubtitleStyle = false
    applyEffectiveSubtitleStyle()
  }

  @MainActor
  func applySubtitleStyle(_ style: UserSubtitleStyleOverride?, from engine: EngineObject?) {
    guard let engine, boundEngine === engine else { return }
    engineSubtitleStyle = style
    preferEngineSubtitleStyle = true
    applyEffectiveSubtitleStyle()
  }

  @MainActor
  private func applyEffectiveSubtitleStyle() {
    let resolved = preferEngineSubtitleStyle ? engineSubtitleStyle : (propSubtitleStyle ?? engineSubtitleStyle)
    subtitleOverlayView.updateSubtitleStyle(resolved)
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
    coreShutterCovered = covered
    refreshShutterVisibility()
  }

  /// Holds the black zap shutter over an HDMI refresh-rate / HDR resync settle window (`#188`, `#116`).
  @MainActor
  func triggerHdmiShutterSettle(durationMs: Int, from engine: EngineObject?) {
    guard let engine, boundEngine === engine, durationMs > 0 else { return }
    hdmiSettleTask?.cancel()
    hdmiSettleSeq &+= 1
    let seq = hdmiSettleSeq
    hdmiSettleActive = true
    refreshShutterVisibility()
    let sleepNanos = UInt64(durationMs) * 1_000_000
    hdmiSettleTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: sleepNanos)
      guard let self, !Task.isCancelled, self.hdmiSettleSeq == seq else { return }
      self.hdmiSettleActive = false
      self.hdmiSettleTask = nil
      self.refreshShutterVisibility()
    }
  }

  @MainActor
  private func cancelHdmiShutterSettle() {
    hdmiSettleSeq &+= 1
    hdmiSettleTask?.cancel()
    hdmiSettleTask = nil
    hdmiSettleActive = false
  }

  @MainActor
  private func refreshShutterVisibility() {
    shutterView.isHidden = !(coreShutterCovered || hdmiSettleActive)
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
    cancelHdmiShutterSettle()
    boundEngine = nil
    engineSubtitleStyle = nil
    preferEngineSubtitleStyle = false
    applyEffectiveSubtitleStyle()
    wantsScreenOn = false
    subtitleOverlayView.clear()
    coreShutterCovered = true
    refreshShutterVisibility()
    if let prevId = boundOwnerId {
      boundOwnerId = nil
      IdleTimer.setHeld(false, ownerId: prevId)
    }
    cleanupState.updateBinding(engine: nil, ownerId: nil, playerViewId: ObjectIdentifier(playerView))
    #if os(iOS)
    refreshKeyboardResponder()
    #endif
  }

  @MainActor
  private func configureHierarchy() {
    backgroundColor = .black
    clipsToBounds = true
    #if os(iOS)
    playbackKeyCommands = AetherKeyCommandHost.makePlaybackKeyCommands(
      action: #selector(handlePlaybackKeyCommand(_:))
    )
    #endif

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
        #if os(iOS)
        self.refreshKeyboardResponder()
        #endif
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
        #if os(iOS)
        self.refreshKeyboardResponder()
        #endif
      }
    }

    let activeToken = center.addObserver(
      forName: UIApplication.didBecomeActiveNotification,
      object: nil,
      queue: nil
    ) { [weak self] _ in
      AetherBackend.onMainActor {
        guard let self else { return }
        if self.appInBackground {
          self.appInBackground = false
          self.refreshIdleTimer()
          self.notifySurfaceAvailability(isBackground: false)
        }
        #if os(iOS)
        self.refreshKeyboardResponder()
        #endif
      }
    }

    var allTokens: [NSObjectProtocol] = [backgroundToken, foregroundToken, activeToken]
    #if os(iOS)
    allTokens.append(
      contentsOf: AetherKeyCommandHost.installTextEditingObservers(
        onBeginEditing: { [weak self] in
          self?.resignKeyboardFocus()
        },
        onEndEditing: { [weak self] in
          self?.refreshKeyboardResponder()
        }
      )
    )
    #endif
    cleanupState.setTokens(allTokens)
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

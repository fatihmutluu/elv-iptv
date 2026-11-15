import AetherEngine
import AVFoundation
import ExpoModulesCore
import Foundation

/// Main-actor coordinator connecting `EngineCore`, `AetherBackend`, and the bound `AetherSurfaceView`.
@MainActor
final class EngineMainDriver: EngineSink {
  private weak var owner: EngineObject?
  let backend: AetherBackend
  private(set) var core: EngineCore!
  weak var boundSurface: AetherSurfaceView?
  var activeEpoch = 0

  init(owner: EngineObject) {
    self.owner = owner
    self.backend = AetherBackend()
    self.core = EngineCore(
      backend: backend,
      sink: self,
      uptimeMs: { ProcessInfo.processInfo.systemUptime * 1_000.0 }
    )
    self.backend.onObservation = { [weak self] observation, serial in
      self?.core.observe(observation, serial: serial)
    }
  }

  func send(_ event: EngineEventOut) {
    owner?.deliverToJavaScript(event, driverEpoch: activeEpoch)
  }

  func setShutter(covered: Bool) {
    boundSurface?.applyShutter(covered: covered, from: owner)
  }

  func setKeepScreenOn(_ on: Bool) {
    if let surface = boundSurface {
      surface.applyScreenOn(on, from: owner)
    } else if !on, let owner {
      IdleTimer.setHeld(false, owner: owner)
    }
  }

  func bindSurface(_ view: AetherSurfaceView) {
    if let previous = boundSurface, previous !== view {
      core.surfaceChanged(available: false)
      previous.detachEngineReference(owner)
    }
    boundSurface = view
    backend.setVideoGravity(view.currentVideoGravity)
    backend.bindPlayerView(view.playerView)
    let snapshot = core.viewSnapshot
    view.applyShutter(covered: snapshot.shutterCovered, from: owner)
    view.applyScreenOn(snapshot.screenOn, from: owner)
    core.surfaceChanged(available: view.isSurfaceAvailable)
  }

  func unbindSurface(_ view: AetherSurfaceView) {
    guard boundSurface === view else { return }
    core.surfaceChanged(available: false)
    boundSurface = nil
    backend.bindPlayerView(nil)
    if let owner {
      IdleTimer.setHeld(false, owner: owner)
    }
  }

  func detachDestroyedPlayerView(_ view: AetherPlayerView) {
    if boundSurface == nil {
      core.surfaceChanged(available: false)
      backend.unbindIfMatching(view)
      if let owner {
        IdleTimer.setHeld(false, owner: owner)
      }
    }
  }

  func surfaceAvailabilityDidChange(_ available: Bool, from view: AetherSurfaceView) {
    guard boundSurface === view else { return }
    core.surfaceChanged(available: available)
  }

  func updateGravity(_ gravity: AVLayerVideoGravity, from view: AetherSurfaceView) {
    guard boundSurface === view else { return }
    backend.setVideoGravity(gravity)
  }

  func dispose() {
    if let previous = boundSurface {
      previous.detachEngineReference(owner)
      boundSurface = nil
    }
    core.release()
    if let owner {
      IdleTimer.setHeld(false, owner: owner)
    }
  }
}

/// Expo `SharedObject` backing one `PlayerEngine` instance (player core spec 6.2).
final class EngineObject: SharedObject {
  private let stateLock = NSLock()
  private var isDisposed = false
  private var jsEpoch = 0
  private var jsToken = 0
  private let onDisposed: (EngineObject) -> Void
  private var driver: EngineMainDriver?

  init(onDisposed: @escaping (EngineObject) -> Void = { _ in }) {
    self.onDisposed = onDisposed
    super.init()
    enqueueMain { [weak self] in
      guard let self, !self.readDisposed() else { return }
      self.driver = EngineMainDriver(owner: self)
    }
  }

  override func sharedObjectDidRelease() {
    dispose()
    super.sharedObjectDidRelease()
  }

  func load(_ request: LoadRequest, attempt: Int) {
    guard let epoch = advanceMediaEpoch(settingToken: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, let driver = self.ensureDriver(), self.currentEpoch() == epoch else { return }
      driver.activeEpoch = epoch
      driver.core.load(request, attempt: attempt)
    }
  }

  func retry(_ attempt: Int) {
    guard let epoch = advanceMediaEpoch(adoptingToken: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, let driver = self.ensureDriver(), self.currentEpoch() == epoch else { return }
      driver.activeEpoch = epoch
      driver.core.retry(attempt)
    }
  }

  func play(_ attempt: Int) {
    guard let epoch = adoptTokenInCurrentEpoch(attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, let driver = self.ensureDriver(), self.currentEpoch() == epoch else { return }
      driver.core.play(attempt)
    }
  }

  func pause(_ attempt: Int) {
    guard let epoch = adoptTokenInCurrentEpoch(attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, let driver = self.ensureDriver(), self.currentEpoch() == epoch else { return }
      driver.core.pause(attempt)
    }
  }

  func seek(_ attempt: Int, positionMs: Double) {
    guard let epoch = adoptTokenInCurrentEpoch(attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, let driver = self.ensureDriver(), self.currentEpoch() == epoch else { return }
      driver.core.seek(attempt, positionMs: positionMs)
    }
  }

  func stop(_ attempt: Int) {
    guard let epoch = advanceMediaEpoch(adoptingToken: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, !self.readDisposed(), let driver = self.ensureDriver() else { return }
      driver.activeEpoch = max(driver.activeEpoch, epoch)
      driver.core.stop(attempt)
    }
  }

  func recreate(_ attempt: Int) {
    guard let epoch = advanceMediaEpoch(adoptingToken: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, let driver = self.ensureDriver(), self.currentEpoch() == epoch else { return }
      driver.activeEpoch = epoch
      driver.core.recreate(attempt)
    }
  }

  func dispose() {
    let shouldDispose: Bool = stateLock.withLock {
      if isDisposed { return false }
      isDisposed = true
      jsEpoch += 1
      return true
    }
    guard shouldDispose else { return }
    onDisposed(self)
    enqueueMain { [weak self] in
      guard let self else { return }
      self.driver?.dispose()
      self.driver = nil
    }
  }

  @MainActor
  func withDriver(_ body: (EngineMainDriver) -> Void) {
    guard !readDisposed(), let driver = ensureDriver() else { return }
    body(driver)
  }

  @MainActor
  fileprivate func deliverToJavaScript(_ event: EngineEventOut, driverEpoch: Int) {
    let snapshot: (disposed: Bool, epoch: Int, token: Int) = stateLock.withLock {
      (isDisposed, jsEpoch, jsToken)
    }
    guard !snapshot.disposed else { return }

    switch event {
    case let .surface(_, change):
      emit(
        event: "onEngineEvent",
        payload: EngineEventOut.surface(attempt: snapshot.token, change: change).payload
      )
    case let .state(attempt, _),
      let .firstFrame(attempt, _),
      let .clock(attempt, _),
      let .stall(attempt, _, _),
      let .error(attempt, _):
      guard driverEpoch == snapshot.epoch, attempt == snapshot.token else { return }
      emit(event: "onEngineEvent", payload: event.payload)
    }
  }

  @MainActor
  private func ensureDriver() -> EngineMainDriver? {
    guard !readDisposed() else { return nil }
    if let driver {
      return driver
    }
    let created = EngineMainDriver(owner: self)
    driver = created
    return created
  }

  private func advanceMediaEpoch(settingToken token: Int) -> Int? {
    stateLock.withLock {
      guard !isDisposed else { return nil }
      jsEpoch += 1
      jsToken = token
      return jsEpoch
    }
  }

  private func advanceMediaEpoch(adoptingToken token: Int) -> Int? {
    stateLock.withLock {
      guard !isDisposed else { return nil }
      jsEpoch += 1
      if token > jsToken { jsToken = token }
      return jsEpoch
    }
  }

  private func adoptTokenInCurrentEpoch(_ token: Int) -> Int? {
    stateLock.withLock {
      guard !isDisposed else { return nil }
      if token > jsToken { jsToken = token }
      return jsEpoch
    }
  }

  private func currentEpoch() -> Int {
    stateLock.withLock { jsEpoch }
  }

  private func readDisposed() -> Bool {
    stateLock.withLock { isDisposed }
  }

  private func enqueueMain(_ block: @escaping @MainActor () -> Void) {
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        block()
      }
    }
  }
}

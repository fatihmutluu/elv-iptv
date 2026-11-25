import ExpoModulesCore
import Foundation

/// Expo `SharedObject` backing one `PlayerEngine` instance (player core spec 6.2).
final class EngineObject: SharedObject, @unchecked Sendable {
  private let fence = CommandFence()
  private let gate = ConnectionGate(forceCloseAfterMs: 1_000, settleAfterCloseMs: 25)
  private let httpSession = EngineHttpSession()
  private let initialAutoEnterPip: Bool
  private let onDisposed: @Sendable (EngineObject) -> Void
  @MainActor private var driver: EngineMainDriver?

  init(
    initialAutoEnterPip: Bool = false,
    onDisposed: @escaping @Sendable (EngineObject) -> Void = { _ in }
  ) {
    self.initialAutoEnterPip = initialAutoEnterPip
    self.onDisposed = onDisposed
    super.init()
    enqueueMain { [weak self] in
      guard let self, !self.fence.isDisposedNow else { return }
      _ = self.ensureDriver()
    }
  }

  override func sharedObjectDidRelease() {
    dispose()
    super.sharedObjectDidRelease()
  }

  func load(_ request: LoadRequest, attempt: Int) {
    guard let epoch = fence.recordLoad(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self,
            case let .run(activeEpoch, rebuildFirst) = self.fence.beginMedia(epoch: epoch),
            let driver = self.ensureDriver()
      else { return }
      driver.activeEpoch = activeEpoch
      if rebuildFirst, !driver.recreatePlayback(attempt) {
        return
      }
      if let style = request.subtitleStyle {
        driver.setSubtitleStyle(style)
      }
      driver.core.load(request, attempt: attempt)
    }
  }

  func retry(_ attempt: Int) {
    guard let epoch = fence.recordRetry(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self,
            case let .run(activeEpoch, rebuildFirst) = self.fence.beginMedia(epoch: epoch),
            let driver = self.driver
      else { return }
      driver.activeEpoch = activeEpoch
      if rebuildFirst, !driver.recreatePlayback(attempt) {
        return
      }
      driver.core.retry(attempt)
    }
  }

  func play(_ attempt: Int) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.driver else { return }
      driver.core.play(attempt)
    }
  }

  func pause(_ attempt: Int) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.driver else { return }
      driver.core.pause(attempt)
    }
  }

  func seek(_ attempt: Int, positionMs: Double) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.driver else { return }
      driver.core.seek(attempt, positionMs: positionMs)
    }
  }

  func setSpeed(_ attempt: Int, rate: Double) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.driver else { return }
      driver.core.setSpeed(attempt, rate: rate)
    }
  }

  func setMuted(_ muted: Bool) {
    guard !fence.isDisposedNow else { return }
    enqueueMain { [weak self] in
      guard let self, !self.fence.isDisposedNow, let driver = self.ensureDriver() else { return }
      driver.backend.setMuted(muted)
    }
  }

  func setVolume(_ volume: Double) {
    guard !fence.isDisposedNow, volume.isFinite else { return }
    enqueueMain { [weak self] in
      guard let self, !self.fence.isDisposedNow, let driver = self.ensureDriver() else { return }
      driver.backend.setVolume(volume)
    }
  }

  func setBackgroundAudioEnabled(_ enabled: Bool) {
    guard !fence.isDisposedNow else { return }
    enqueueMain { [weak self] in
      guard let self, !self.fence.isDisposedNow, let driver = self.ensureDriver() else { return }
      driver.setBackgroundAudioEnabled(enabled)
    }
  }

  func setAllowDetachedSurface(_ enabled: Bool) {
    guard !fence.isDisposedNow else { return }
    enqueueMain { [weak self] in
      guard let self, !self.fence.isDisposedNow, let driver = self.ensureDriver() else { return }
      driver.setAllowDetachedSurface(enabled)
    }
  }

  func setMediaMetadata(_ metadata: NowPlayingMetadata?) {
    guard !fence.isDisposedNow else { return }
    enqueueMain { [weak self] in
      guard let self, !self.fence.isDisposedNow, let driver = self.ensureDriver() else { return }
      driver.setMediaMetadata(metadata)
    }
  }

  @MainActor
  func isCurrentlyLive() -> Bool {
    driver?.core.isLivePlayback ?? true
  }

  @MainActor
  var hasBoundSurface: Bool {
    !fence.isDisposedNow && driver?.boundSurface != nil
  }

  @MainActor
  func canStartPictureInPicture() -> Bool {
    guard !fence.isDisposedNow, let driver else { return false }
    return driver.canStartPictureInPicture()
  }

  @MainActor
  func enterPictureInPicture() -> Bool {
    guard !fence.isDisposedNow, let driver else { return false }
    return driver.enterPictureInPicture()
  }

  @MainActor
  func setAutoEnterPictureInPicture(_ enabled: Bool) -> Bool {
    guard !fence.isDisposedNow, let driver = ensureDriver() else { return false }
    return driver.setAutoEnterPictureInPicture(enabled)
  }

  func selectAudioTrack(_ attempt: Int, id: String) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.ensureDriver() else { return }
      driver.core.selectAudioTrack(attempt, id: id)
    }
  }

  func selectSubtitleTrack(_ attempt: Int, id: String?) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.ensureDriver() else { return }
      driver.core.selectSubtitleTrack(attempt, id: id)
    }
  }

  func selectSecondarySubtitleTrack(_ attempt: Int, id: String?) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.ensureDriver() else { return }
      driver.core.selectSecondarySubtitleTrack(attempt, id: id)
    }
  }

  func addExternalSubtitle(_ attempt: Int, track: ExternalSubtitleDescriptor) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.ensureDriver() else { return }
      driver.core.addExternalSubtitle(attempt, track: track)
    }
  }

  func setSubtitleStyle(_ style: UserSubtitleStyleOverride?) {
    guard !fence.isDisposedNow else { return }
    enqueueMain { [weak self] in
      guard let self, !self.fence.isDisposedNow, let driver = self.ensureDriver() else { return }
      driver.setSubtitleStyle(style)
    }
  }

  func setAudioDelay(_ attempt: Int, delayMs: Double) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.ensureDriver() else { return }
      driver.core.setAudioDelay(attempt, delayMs: delayMs)
    }
  }

  func setSubtitleDelay(_ attempt: Int, delayMs: Double) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.ensureDriver() else { return }
      driver.core.setSubtitleDelay(attempt, delayMs: delayMs)
    }
  }

  func selectVideoQuality(_ attempt: Int, id: String?) {
    guard let epoch = fence.recordInEpochCommand(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.beginInEpoch(epoch: epoch), let driver = self.ensureDriver() else { return }
      driver.core.selectVideoQuality(attempt, id: id)
    }
  }

  func stop(_ attempt: Int) {
    guard let epoch = fence.recordStop(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self, self.fence.canRunStop(), let driver = self.driver else { return }
      driver.activeEpoch = max(driver.activeEpoch, epoch)
      driver.stopPlayback(attempt)
    }
  }

  func recreate(_ attempt: Int) {
    guard let epoch = fence.recordRecreate(attempt: attempt) else { return }
    enqueueMain { [weak self] in
      guard let self,
            case let .run(activeEpoch) = self.fence.beginRecreate(epoch: epoch),
            let driver = self.ensureDriver()
      else { return }
      driver.activeEpoch = activeEpoch
      _ = driver.recreatePlayback(attempt)
    }
  }

  func dispose() {
    guard fence.markDisposed() else { return }
    httpSession.dispose()
    onDisposed(self)
    enqueueMain {
      self.driver?.dispose()
      self.driver = nil
    }
  }

  @MainActor
  func withDriver(_ body: (EngineMainDriver) -> Void) {
    guard !fence.isDisposedNow, let driver = ensureDriver() else { return }
    body(driver)
  }

  @MainActor
  func detachDestroyedPlayerViewIfLoaded(viewId: ObjectIdentifier) {
    guard !fence.isDisposedNow, let driver else { return }
    driver.detachDestroyedPlayerView(viewId: viewId)
  }

  @MainActor
  func deliverToJavaScript(_ event: EngineEventOut, driverEpoch: Int) {
    guard let filtered = fence.filterOutbound(event, driverEpoch: driverEpoch) else { return }
    emit(event: "onEngineEvent", payload: filtered.payload)
  }

  @MainActor
  func emitRemoteMediaAction(_ action: String) {
    guard !fence.isDisposedNow else { return }
    emit(event: "onRemoteMediaAction", payload: ["action": action])
  }

  @MainActor
  private func ensureDriver() -> EngineMainDriver? {
    guard !fence.isDisposedNow else { return nil }
    if let driver {
      return driver
    }
    let created = EngineMainDriver(owner: self, gate: gate, httpSession: httpSession)
    if initialAutoEnterPip {
      _ = created.setAutoEnterPictureInPicture(true)
    }
    driver = created
    return created
  }

  private func enqueueMain(_ block: @escaping @MainActor @Sendable () -> Void) {
    DispatchQueue.main.async {
      MainActor.assumeIsolated {
        block()
      }
    }
  }
}

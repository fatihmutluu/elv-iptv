import AetherEngine
import AVFoundation
import Foundation

/// Main-actor coordinator connecting `EngineCore`, `AetherBackend`, and the bound `AetherSurfaceView`.
@MainActor
final class EngineMainDriver: EngineSink {
  private weak var owner: EngineObject?
  private let ownerId: ObjectIdentifier
  let backend: AetherBackend
  private(set) var core: EngineCore!
  weak var boundSurface: AetherSurfaceView?
  var activeEpoch = 0

  init(owner: EngineObject, gate: ConnectionGate, httpSession: EngineHttpSession) {
    self.owner = owner
    self.ownerId = ObjectIdentifier(owner)
    self.backend = AetherBackend(gate: gate, httpSession: httpSession)
    self.core = EngineCore(
      backend: backend,
      sink: self,
      uptimeMs: { ProcessInfo.processInfo.systemUptime * 1_000.0 }
    )
    self.backend.onObservation = { [weak self] observation, serial in
      self?.core.observe(observation, serial: serial)
    }
    self.backend.onSubtitlePresentation = { [weak self] presentation in
      guard let self else { return }
      self.boundSurface?.applySubtitles(presentation, from: self.owner)
    }
  }

  func send(_ event: EngineEventOut) {
    owner?.deliverToJavaScript(event, driverEpoch: activeEpoch)
  }

  func setShutter(covered: Bool) {
    boundSurface?.applyShutter(covered: covered, from: owner)
  }

  func clearSubtitles() {
    backend.clearSubtitlePresentation()
    boundSurface?.applySubtitles(.empty, from: owner)
  }

  func setKeepScreenOn(_ on: Bool) {
    if let surface = boundSurface {
      surface.applyScreenOn(on, from: owner)
    }
    if !on {
      IdleTimer.setHeld(false, ownerId: ownerId)
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
    core.setOsdVisible(view.currentOsdVisible)
    let snapshot = core.viewSnapshot
    view.applyShutter(covered: snapshot.shutterCovered, from: owner)
    view.applySubtitles(backend.lastSubtitlePresentation, from: owner)
    view.applyScreenOn(snapshot.screenOn, from: owner)
    core.surfaceChanged(available: view.isSurfaceAvailable, isBackground: view.isAppInBackground)
  }

  func unbindSurface(_ view: AetherSurfaceView) {
    guard boundSurface === view else { return }
    view.applySubtitles(.empty, from: owner)
    core.surfaceChanged(available: false, isBackground: view.isAppInBackground)
    core.setOsdVisible(true)
    boundSurface = nil
    backend.bindPlayerView(nil)
    IdleTimer.setHeld(false, ownerId: ownerId)
  }

  func detachDestroyedPlayerView(viewId: ObjectIdentifier) {
    if boundSurface == nil {
      core.surfaceChanged(available: false)
      backend.unbindIfMatching(viewId: viewId)
      IdleTimer.setHeld(false, ownerId: ownerId)
    }
  }

  func surfaceAvailabilityDidChange(_ available: Bool, isBackground: Bool, from view: AetherSurfaceView) {
    guard boundSurface === view else { return }
    core.surfaceChanged(available: available, isBackground: isBackground)
  }

  func setOsdVisible(_ visible: Bool, from view: AetherSurfaceView) {
    guard boundSurface === view else { return }
    core.setOsdVisible(visible)
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
    IdleTimer.setHeld(false, ownerId: ownerId)
  }
}

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
  private var nowPlayingBridge: AetherNowPlayingBridge!
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
    self.nowPlayingBridge = AetherNowPlayingBridge(
      actions: NowPlayingRemoteActions(
        onPlay: { [weak self] in
          guard let self, self.core.nowPlayingPlaybackState.isActive else { return }
          self.core.play(self.core.currentToken)
          self.syncNowPlaying(force: true)
        },
        onPause: { [weak self] in
          guard let self, self.core.nowPlayingPlaybackState.isActive else { return }
          self.core.pause(self.core.currentToken)
          self.syncNowPlaying(force: true)
        },
        onTogglePlayPause: { [weak self] in
          guard let self else { return }
          let state = self.core.nowPlayingPlaybackState
          guard state.isActive else { return }
          if state.isPlaying {
            self.core.pause(self.core.currentToken)
          } else {
            self.core.play(self.core.currentToken)
          }
          self.syncNowPlaying(force: true)
        },
        onStop: { [weak self] in
          guard let self else { return }
          self.stopPlayback(self.core.currentToken)
          self.owner?.emitRemoteMediaAction("stop")
        },
        onSkipBy: { [weak self] deltaSeconds in
          guard let self else { return }
          let state = self.core.nowPlayingPlaybackState
          guard state.isActive, !state.isLive else { return }
          let targetMs = max(0.0, (state.positionSeconds + deltaSeconds) * 1_000.0)
          self.core.seek(self.core.currentToken, positionMs: targetMs)
          self.syncNowPlaying(force: true)
        },
        onSeekTo: { [weak self] positionSeconds in
          guard let self else { return }
          let state = self.core.nowPlayingPlaybackState
          guard state.isActive, !state.isLive else { return }
          self.core.seek(self.core.currentToken, positionMs: max(0.0, positionSeconds) * 1_000.0)
          self.syncNowPlaying(force: true)
        },
        onChangeRate: { [weak self] rate in
          guard let self else { return }
          let state = self.core.nowPlayingPlaybackState
          guard state.isActive, !state.isLive else { return }
          self.core.setSpeed(self.core.currentToken, rate: rate)
          self.syncNowPlaying(force: true)
        },
        onNextTrack: { [weak self] in
          self?.owner?.emitRemoteMediaAction("next")
        },
        onPreviousTrack: { [weak self] in
          self?.owner?.emitRemoteMediaAction("previous")
        }
      )
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
    switch event {
    case .state(_, .ended), .error:
      nowPlayingBridge.clear()
    case .state, .stall:
      syncNowPlaying(force: true)
    case .clock:
      syncNowPlaying(force: false)
    case .firstFrame, .progress, .tracks, .mediaInfo, .telemetry, .chapters, .externalPlayback, .surface:
      break
    }
  }

  func setMediaMetadata(_ metadata: NowPlayingMetadata?) {
    nowPlayingBridge.setMetadata(metadata, playbackState: core.nowPlayingPlaybackState)
  }

  func setBackgroundAudioEnabled(_ enabled: Bool) {
    backend.setBackgroundAudioEnabled(enabled)
  }

  func stopPlayback(_ attempt: Int) {
    core.stop(attempt)
    nowPlayingBridge.clear()
  }

  @discardableResult
  func recreatePlayback(_ attempt: Int) -> Bool {
    nowPlayingBridge.clear()
    return core.recreate(attempt)
  }

  private func syncNowPlaying(force: Bool) {
    nowPlayingBridge.update(state: core.nowPlayingPlaybackState, force: force)
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
    nowPlayingBridge.dispose()
    if let previous = boundSurface {
      previous.detachEngineReference(owner)
      boundSurface = nil
    }
    core.release()
    IdleTimer.setHeld(false, ownerId: ownerId)
  }
}

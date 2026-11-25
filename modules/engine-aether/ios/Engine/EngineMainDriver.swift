import AetherEngine
import AVFoundation
import Foundation
import UIKit

/// Main-actor coordinator connecting `EngineCore`, `AetherBackend`, and the bound `AetherSurfaceView`.
@MainActor
final class EngineMainDriver: EngineSink {
  private weak var owner: EngineObject?
  private let ownerId: ObjectIdentifier
  let backend: AetherBackend
  private(set) var core: EngineCore!
  private var nowPlayingBridge: AetherNowPlayingBridge!
  private var pipController: AetherPipController!
  weak var boundSurface: AetherSurfaceView?
  var activeEpoch = 0
  private var handleAudioFocus: Bool
  private var backgroundAudioEnabled = false
  private var explicitDetachedSurfaceAllowed = false
  private var pipDetachedSurfaceAllowed = false
  private var hasExplicitSubtitleStyle = false
  private var activeSubtitleStyle: UserSubtitleStyleOverride?
  private var hasExplicitDisplaySync = false
  private var activeDisplaySync: AppleDisplaySyncSettings = .default

  init(
    owner: EngineObject,
    gate: ConnectionGate,
    httpSession: EngineHttpSession,
    handleAudioFocus: Bool = true
  ) {
    self.owner = owner
    self.ownerId = ObjectIdentifier(owner)
    self.handleAudioFocus = handleAudioFocus
    self.backend = AetherBackend(gate: gate, httpSession: httpSession, handleAudioFocus: handleAudioFocus)
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
          guard state.isActive else { return }
          if state.isLive {
            guard let window = self.core.liveSeekableWindow,
                  let clampedSec = clampLiveSeek(targetSec: state.positionSeconds + deltaSeconds, window: window)
            else { return }
            self.core.seek(self.core.currentToken, positionMs: clampedSec * 1_000.0)
          } else {
            let targetMs = max(0.0, (state.positionSeconds + deltaSeconds) * 1_000.0)
            self.core.seek(self.core.currentToken, positionMs: targetMs)
          }
          self.syncNowPlaying(force: true)
        },
        onSeekTo: { [weak self] positionSeconds in
          guard let self else { return }
          let state = self.core.nowPlayingPlaybackState
          guard state.isActive else { return }
          if state.isLive {
            guard let window = self.core.liveSeekableWindow,
                  let clampedSec = clampLiveSeek(targetSec: positionSeconds, window: window)
            else { return }
            self.core.seek(self.core.currentToken, positionMs: clampedSec * 1_000.0)
          } else {
            self.core.seek(self.core.currentToken, positionMs: max(0.0, positionSeconds) * 1_000.0)
          }
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
      ),
      ownsNowPlaying: handleAudioFocus
    )
    self.pipController = AetherPipController(
      onDetachedSurfaceChanged: { [weak self] allowed in
        self?.setPipDetachedSurfaceAllowed(allowed)
      },
      onPipStateChanged: { inPip in
        AppleModuleEventHub.shared.emitPictureInPictureChanged(inPip)
      }
    )
    self.backend.onObservation = { [weak self] observation, serial in
      self?.core.observe(observation, serial: serial)
    }
    self.backend.onSubtitlePresentation = { [weak self] presentation in
      guard let self else { return }
      self.boundSurface?.applySubtitles(presentation, from: self.owner)
    }
    self.backend.onPlayerLayerMayHaveChanged = { [weak self] in
      self?.syncPipController()
    }
    self.backend.onHdmiShutterSettle = { [weak self] durationMs in
      guard let self else { return }
      self.boundSurface?.triggerHdmiShutterSettle(durationMs: durationMs, from: self.owner)
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

  /// Promotes or demotes Multi-View primary audio-focus and Now Playing ownership (`#34`).
  func configureMultiView(handleAudioFocus: Bool) {
    self.handleAudioFocus = handleAudioFocus
    backend.setHandleAudioFocus(handleAudioFocus)
    nowPlayingBridge.setHandleAudioFocus(handleAudioFocus, playbackState: core.nowPlayingPlaybackState)
  }

  func setBackgroundAudioEnabled(_ enabled: Bool) {
    backgroundAudioEnabled = enabled
    backend.setBackgroundAudioEnabled(enabled)
    syncDetachedSurfacePolicy()
  }

  func setAllowDetachedSurface(_ enabled: Bool) {
    explicitDetachedSurfaceAllowed = enabled
    syncDetachedSurfacePolicy()
  }

  /// Applies live user subtitle appearance override to the bound surface without restarting playback (`#32`).
  func setSubtitleStyle(_ style: UserSubtitleStyleOverride?) {
    hasExplicitSubtitleStyle = true
    activeSubtitleStyle = style
    boundSurface?.applySubtitleStyle(style, from: owner)
  }

  /// Updates live AFR/HDR display-sync policy without restarting playback (`#188`, `#116`).
  func setDisplaySync(_ settings: AppleDisplaySyncSettings) {
    hasExplicitDisplaySync = true
    activeDisplaySync = settings
    backend.setDisplaySync(settings)
  }

  /// Merges per-load display-sync overrides with any live `setDisplaySync` settings.
  func resolveLoadRequest(_ request: LoadRequest) -> LoadRequest {
    var effective = request
    if request.autoFrameRate != nil || request.autoDynamicRange != nil {
      let resolved = AppleDisplaySyncSettings(
        autoFrameRate: request.autoFrameRate ?? activeDisplaySync.autoFrameRate,
        autoDynamicRange: request.autoDynamicRange ?? activeDisplaySync.autoDynamicRange
      )
      hasExplicitDisplaySync = true
      activeDisplaySync = resolved
      effective.autoFrameRate = resolved.autoFrameRate
      effective.autoDynamicRange = resolved.autoDynamicRange
    } else if hasExplicitDisplaySync {
      effective.autoFrameRate = activeDisplaySync.autoFrameRate
      effective.autoDynamicRange = activeDisplaySync.autoDynamicRange
    }
    return effective
  }

  private func setPipDetachedSurfaceAllowed(_ allowed: Bool) {
    pipDetachedSurfaceAllowed = allowed
    syncDetachedSurfacePolicy()
  }

  private func syncDetachedSurfacePolicy() {
    core.setAllowDetachedSurface(
      backgroundAudioEnabled || explicitDetachedSurfaceAllowed || pipDetachedSurfaceAllowed
    )
  }

  func syncPipController() {
    pipController.sync(
      playerView: boundSurface?.playerView,
      isAvPlayerRoute: backend.isAvPlayerRouteActive
    )
  }

  func canStartPictureInPicture() -> Bool {
    pipController.canStartPictureInPicture(
      playerView: boundSurface?.playerView,
      isAvPlayerRoute: backend.isAvPlayerRouteActive
    )
  }

  func enterPictureInPicture() -> Bool {
    pipController.enterPictureInPicture(
      playerView: boundSurface?.playerView,
      isAvPlayerRoute: backend.isAvPlayerRouteActive
    )
  }

  func setAutoEnterPictureInPicture(_ enabled: Bool) -> Bool {
    pipController.setAutoEnterPictureInPicture(
      enabled,
      playerView: boundSurface?.playerView,
      isAvPlayerRoute: backend.isAvPlayerRouteActive
    )
  }

  func stopPlayback(_ attempt: Int) {
    pipController.reset()
    core.stop(attempt)
    backend.stopDisplayCriteriaForUserStop()
    nowPlayingBridge.clear()
  }

  @discardableResult
  func recreatePlayback(_ attempt: Int) -> Bool {
    pipController.reset()
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
      core.surfaceChanged(available: false, isBackground: previous.isDetachingInBackground)
      previous.detachEngineReference(owner)
    }
    boundSurface = view
    backend.setVideoGravity(view.currentVideoGravity)
    backend.bindPlayerView(view.playerView)
    syncPipController()
    core.setOsdVisible(view.currentOsdVisible)
    let snapshot = core.viewSnapshot
    view.applyShutter(covered: snapshot.shutterCovered, from: owner)
    if hasExplicitSubtitleStyle {
      view.applySubtitleStyle(activeSubtitleStyle, from: owner)
    }
    view.applySubtitles(backend.lastSubtitlePresentation, from: owner)
    view.applyScreenOn(snapshot.screenOn, from: owner)
    let available = view.isSurfaceAvailable
    core.surfaceChanged(available: available, isBackground: available ? false : view.isDetachingInBackground)
  }

  func unbindSurface(_ view: AetherSurfaceView) {
    guard boundSurface === view else { return }
    view.applySubtitles(.empty, from: owner)
    core.surfaceChanged(available: false, isBackground: view.isDetachingInBackground)
    core.setOsdVisible(true)
    boundSurface = nil
    backend.bindPlayerView(nil)
    pipController.handleSurfaceUnbound()
    IdleTimer.setHeld(false, ownerId: ownerId)
  }

  func detachDestroyedPlayerView(viewId: ObjectIdentifier) {
    if boundSurface == nil {
      let inBackground = UIApplication.shared.applicationState != .active
      core.surfaceChanged(available: false, isBackground: inBackground)
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
    pipController.dispose()
    nowPlayingBridge.dispose()
    if let previous = boundSurface {
      previous.detachEngineReference(owner)
      boundSurface = nil
    }
    core.release()
    IdleTimer.setHeld(false, ownerId: ownerId)
  }
}

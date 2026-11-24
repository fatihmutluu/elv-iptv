import AetherEngine
import AVFoundation
import Combine
import Foundation

/// `PlayerBackend` adapter over a single lazily-allocated `AetherEngine` instance on the main actor.
@MainActor
final class AetherBackend: PlayerBackend {
  nonisolated static func onMainActor(_ block: @escaping @MainActor @Sendable () -> Void) {
    if Thread.isMainThread {
      MainActor.assumeIsolated {
        block()
      }
    } else {
      DispatchQueue.main.async {
        MainActor.assumeIsolated {
          block()
        }
      }
    }
  }

  var onObservation: ((BackendObservation, Int) -> Void)?
  var onSubtitlePresentation: ((SubtitlePresentation) -> Void)?

  let gate: ConnectionGate
  let httpSession: EngineHttpSession
  var legacyHttpSession: EngineHttpSession?

  var engine: AetherEngine?
  var cancellables = Set<AnyCancellable>()
  var avPlayerBufferCancellables = Set<AnyCancellable>()
  var avPlayerItemBufferCancellables = Set<AnyCancellable>()
  var observedAVPlayerId: ObjectIdentifier?
  var observedAVPlayerItemId: ObjectIdentifier?
  var itemProgressCancellable: AnyCancellable?
  var subtitleClockCancellable: AnyCancellable?
  var externalSubtitleClockCancellable: AnyCancellable?
  let audioSessionController = AetherAudioSessionController()
  private var audioSessionObserver: AetherAudioSessionObserver?
  weak var boundPlayerView: AetherPlayerView?
  var gravity: AVLayerVideoGravity = .resizeAspect
  var lastSubtitlePresentation: SubtitlePresentation = .empty

  var activeLoadSerial = 0
  var engineLoadSerial = 0
  var readySerial = 0
  var tracksEmittedSerial = 0
  var pendingTracksSerial = 0
  var tracksDeferredForReload = false
  var inReloadFromState = false
  var errorReportedSerial = 0
  var loggedRouteSerial = 0
  var gateGeneration = 0
  var loadTaskId = 0
  private var seekTaskId = 0
  var audioSwitchTaskId = 0
  var liveRecoveryTaskId = 0
  var mediaInfoTaskId = 0
  var pausedLiveClockTaskId = 0

  var loadStartUptimeMs: Double = 0
  var openedMsForSerial: Double?

  var currentPlan: MediaPlan?
  var currentLoadOptions: EngineLoadOptions?
  var currentReader: LiveTsReader?
  var desiredAudioStreamId: Int?
  var desiredSubtitleStreamId: Int?
  var externalSubtitles: [String: LoadedExternalSubtitle] = [:]
  var externalSubtitleOrder: [String] = []
  var externalSubtitleTasks: [String: Task<Void, Never>] = [:]
  var activeExternalPrimaryId: String?
  var activeSecondarySubtitleId: String?

  var loadTask: Task<Void, Never>?
  var seekTask: Task<Void, Never>?
  var audioSwitchTask: Task<Void, Never>?
  var liveRecoveryTask: Task<Void, Never>?
  var mediaInfoTask: Task<Void, Never>?
  var pausedLiveClockTask: Task<Void, Never>?
  var liveRecoveryPolicy = LiveRecoveryPolicy()

  var audioSessionPolicy = AudioSessionPolicy()
  var airPlayTracker = AirPlayCapabilityTracker()
  var airPlayMonitor: AetherAirPlayMonitor?
  var osdClockThrottle = OsdClockThrottle(hiddenIntervalSeconds: 5.0, osdVisible: true)
  var requestedRate: Double = 1.0
  var requestedAudioDelaySeconds: Double = 0
  var requestedSubtitleDelaySeconds: Double = 0
  var requestedVideoQualityCap: VideoQualityCap?
  var backgroundAudioEnabled = false
  var desiredMuted = false
  var desiredVolume: Float = 1.0
  var lastAVBufferReportedBuffering = false
  var playbackActiveIntent = false
  var lastDroppedVideoFrames = 0
  var lastLiveSeekableWindow: LiveSeekableWindow?

  init(gate: ConnectionGate, httpSession: EngineHttpSession) {
    self.gate = gate
    self.httpSession = httpSession
    self.audioSessionObserver = AetherAudioSessionObserver { [weak self] event in
      self?.handleAudioSessionEvent(event)
    }
    self.airPlayMonitor = AetherAirPlayMonitor { [weak self] services in
      self?.handleAirPlayServicesUpdated(services)
    }
    _ = try? installFreshEngine()
  }

  func bindPlayerView(_ view: AetherPlayerView?) {
    guard boundPlayerView !== view else { return }
    if let previous = boundPlayerView {
      engine?.unbind(view: previous)
    }
    boundPlayerView = view
    if let view {
      if let engine {
        engine.videoGravity = gravity
        engine.bind(view: view)
        refreshSubtitleGeometry(from: engine)
      } else {
        // Pre-warm AetherEngine when a surface mounts so cold-start load() does not pay init cost.
        _ = try? installFreshEngine()
      }
    }
  }

  func unbindIfMatching(viewId: ObjectIdentifier) {
    guard let current = boundPlayerView, ObjectIdentifier(current) == viewId else { return }
    engine?.unbind(view: current)
    boundPlayerView = nil
  }

  func setVideoGravity(_ newGravity: AVLayerVideoGravity) {
    guard gravity != newGravity else { return }
    gravity = newGravity
    engine?.videoGravity = newGravity
    refreshSubtitleGravity()
  }

  func clearSubtitlePresentation() {
    lastSubtitlePresentation = .empty
    onSubtitlePresentation?(.empty)
  }

  func start(_ plan: MediaPlan, options: EngineLoadOptions, serial: Int) {
    resetSerialBookkeeping()
    resetExternalSubtitles()
    cancelTasksAndReader()
    publishSubtitlePresentation(.empty)

    let currentEngine: AetherEngine
    do {
      currentEngine = try ensureEngine()
    } catch {
      let nsError = error as NSError
      onObservation?(
        .failure(.engine(kind: "sourceOpenFailed", underlyingDomain: nsError.domain, underlyingCode: nsError.code)),
        serial
      )
      return
    }

    activeLoadSerial = serial
    loadStartUptimeMs = ProcessInfo.processInfo.systemUptime * 1_000.0
    currentPlan = plan
    currentLoadOptions = options
    desiredAudioStreamId = options.audioStreamIndex.map(Int.init)
    desiredSubtitleStreamId = options.subtitlesDisabled ? nil : options.initialSubtitleTrackId
    activeSecondarySubtitleId = options.secondarySubtitleTrackId
    for extTrack in options.externalSubtitles {
      addExternalSubtitle(extTrack)
    }
    let isExternal = currentEngine.currentAVPlayer?.isExternalPlaybackActive ?? false
    airPlayTracker.updateRoute(airPlayPortName: AetherAudioSessionObserver.currentAirPlayPortName())
    airPlayTracker.updateExternalPlayback(active: isExternal)
    syncAirPlayState()
    audioSessionPolicy.clearLatchesOnUserPlay()
    audioSessionController.activateForPlayback()

    runMediaLoad(plan: plan, fallbackOptions: options, serial: serial, currentEngine: currentEngine)
    if isExternal {
      onObservation?(.externalPlayback(true), serial)
    }
  }

  func stopMedia() {
    resetSerialBookkeeping()
    resetExternalSubtitles()
    audioSessionPolicy.reset()
    resetAirPlayState()
    currentPlan = nil
    currentLoadOptions = nil
    desiredAudioStreamId = nil
    desiredSubtitleStreamId = nil
    gateGeneration += 1
    gate.advance(to: gateGeneration)
    cancelTasksAndReader()
    publishSubtitlePresentation(.empty)
    resetSyncDelaysAndQualityOnEngine()
    engine?.stop(resetDisplayCriteria: false, finalTeardown: false)
    audioSessionController.deactivateIfOwned()
  }

  func play() {
    cancelPausedLiveClockTask()
    if activeLoadSerial > 0 {
      playbackActiveIntent = true
    }
    audioSessionPolicy.clearLatchesOnUserPlay()
    audioSessionController.activateForPlayback()
    engine?.play()
  }

  func pause() {
    playbackActiveIntent = false
    engine?.pause()
    if let engine {
      syncPausedLiveClockTask(for: engine)
    }
  }

  func setRate(_ rate: Double) {
    guard rate.isFinite, rate > 0 else { return }
    requestedRate = rate
    engine?.setRate(Float(rate))
  }

  /// Toggles opt-in background audio playback (`false` by default for single-connection IPTV safety, `#413`).
  func setBackgroundAudioEnabled(_ enabled: Bool) {
    backgroundAudioEnabled = enabled
    engine?.backgroundPlaybackEnabled = enabled
  }

  func setOsdVisible(_ visible: Bool) {
    let becameVisible = osdClockThrottle.setOsdVisible(visible)
    guard becameVisible,
          let target = engine,
          engineLoadSerial > 0,
          target.videoRoute != .none,
          target.hasFirstFrameReadyForDisplay || target.videoRoute == .audio
    else { return }
    let phase = target.playbackPhase
    guard phase != .idle, phase != .loading, phase != .seeking,
          target.state != .idle, target.state != .loading, target.state != .seeking
    else { return }
    emitClockSnapshot(
      from: target,
      positionSeconds: target.currentTime,
      rateOverride: nil,
      durationOverride: nil,
      serial: engineLoadSerial
    )
  }

  func seek(toSeconds: Double) {
    guard toSeconds.isFinite, let engine else { return }
    let targetSeconds: Double
    if engine.isLive {
      guard currentPlan?.isLiveTs != true,
            let window = lastLiveSeekableWindow ?? readLiveSeekableWindow(from: engine),
            let clamped = clampLiveSeek(targetSec: toSeconds, window: window)
      else {
        return
      }
      targetSeconds = clamped
    } else {
      targetSeconds = max(0, toSeconds)
    }
    let serial = engineLoadSerial
    guard serial > 0 else { return }
    seekTask?.cancel()
    seekTaskId &+= 1
    let id = seekTaskId
    seekTask = Task { @MainActor [weak self, weak engine] in
      defer {
        if let self, self.seekTaskId == id {
          self.seekTask = nil
        }
      }
      guard let self, let engine, !Task.isCancelled, self.engine === engine, self.engineLoadSerial == serial else { return }
      await engine.seek(to: targetSeconds)
    }
  }

  func rebuild() throws {
    resetSerialBookkeeping()
    resetExternalSubtitles()
    audioSessionPolicy.reset()
    resetAirPlayState()
    currentPlan = nil
    currentLoadOptions = nil
    desiredAudioStreamId = nil
    desiredSubtitleStreamId = nil
    gateGeneration += 1
    gate.advance(to: gateGeneration)
    cancelTasksAndReader()
    publishSubtitlePresentation(.empty)
    clearEngineSubscriptions()

    if let previous = engine {
      previous.stop(resetDisplayCriteria: false, finalTeardown: true)
      if let view = boundPlayerView {
        previous.unbind(view: view)
      }
      engine = nil
    }
    audioSessionController.deactivateIfOwned()
    _ = try installFreshEngine()
  }

  func dispose() {
    resetSerialBookkeeping()
    resetExternalSubtitles()
    audioSessionPolicy.reset()
    resetAirPlayState()
    airPlayMonitor = nil
    currentPlan = nil
    currentLoadOptions = nil
    desiredAudioStreamId = nil
    desiredSubtitleStreamId = nil
    gateGeneration += 1
    gate.advance(to: gateGeneration)
    cancelTasksAndReader()
    publishSubtitlePresentation(.empty)
    clearEngineSubscriptions()
    audioSessionObserver?.dispose()
    audioSessionObserver = nil
    legacyHttpSession?.dispose()
    legacyHttpSession = nil

    if let previous = engine {
      previous.stop(resetDisplayCriteria: true, finalTeardown: true)
      if let view = boundPlayerView {
        previous.unbind(view: view)
      }
      engine = nil
    }
    audioSessionController.deactivateIfOwned()
    boundPlayerView = nil
    httpSession.dispose()
  }

  func cancelTasksAndReader() {
    clearPlayerItemObservers()
    loadTaskId &+= 1
    loadTask?.cancel()
    loadTask = nil
    seekTaskId &+= 1
    seekTask?.cancel()
    seekTask = nil
    audioSwitchTaskId &+= 1
    audioSwitchTask?.cancel()
    audioSwitchTask = nil
    liveRecoveryTaskId &+= 1
    liveRecoveryTask?.cancel()
    liveRecoveryTask = nil
    mediaInfoTaskId &+= 1
    mediaInfoTask?.cancel()
    mediaInfoTask = nil
    cancelPausedLiveClockTask()
    closeCurrentReader()
  }

  func cancelPausedLiveClockTask() {
    pausedLiveClockTaskId &+= 1
    pausedLiveClockTask?.cancel()
    pausedLiveClockTask = nil
  }

  func syncPausedLiveClockTask(for target: AetherEngine) {
    let serial = engineLoadSerial
    let isPaused =
      (target.playbackPhase == .paused || target.state == .paused)
      && target.playbackPhase != .playing
      && target.state != .loading
      && target.state != .ended
    let hasWindow = lastLiveSeekableWindow != nil || readLiveSeekableWindow(from: target) != nil
    guard serial > 0,
          engine === target,
          shouldTickLiveWindowWhilePaused(
            isLive: target.isLive,
            isLiveTs: currentPlan?.isLiveTs == true,
            isPaused: isPaused,
            hasSeekableWindow: hasWindow
          )
    else {
      cancelPausedLiveClockTask()
      return
    }
    guard pausedLiveClockTask == nil else { return }
    pausedLiveClockTaskId &+= 1
    let id = pausedLiveClockTaskId
    pausedLiveClockTask = Task { @MainActor [weak self, weak target] in
      defer {
        if let self, self.pausedLiveClockTaskId == id {
          self.pausedLiveClockTask = nil
        }
      }
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        guard !Task.isCancelled,
              let self,
              let target,
              self.engine === target,
              self.engineLoadSerial == serial
        else {
          return
        }
        let stillPaused =
          (target.playbackPhase == .paused || target.state == .paused)
          && target.playbackPhase != .playing
          && target.state != .loading
          && target.state != .ended
        let window = self.readLiveSeekableWindow(from: target)
        guard shouldTickLiveWindowWhilePaused(
          isLive: target.isLive,
          isLiveTs: self.currentPlan?.isLiveTs == true,
          isPaused: stillPaused,
          hasSeekableWindow: window != nil || self.lastLiveSeekableWindow != nil
        ) else {
          return
        }
        self.emitClockSnapshot(
          from: target,
          positionSeconds: target.currentTime,
          rateOverride: 0.0,
          durationOverride: nil,
          serial: serial
        )
      }
    }
  }

  private func clearEngineSubscriptions() {
    clearPlayerItemObservers()
    observedAVPlayerId = nil
    for cancellable in avPlayerBufferCancellables {
      cancellable.cancel()
    }
    avPlayerBufferCancellables.removeAll()
    for cancellable in cancellables {
      cancellable.cancel()
    }
    cancellables.removeAll()
  }

  private func resetSerialBookkeeping() {
    activeLoadSerial = 0
    engineLoadSerial = 0
    readySerial = 0
    tracksEmittedSerial = 0
    pendingTracksSerial = 0
    tracksDeferredForReload = false
    inReloadFromState = false
    errorReportedSerial = 0
    loggedRouteSerial = 0
    openedMsForSerial = nil
    requestedRate = 1.0
    requestedAudioDelaySeconds = 0
    requestedSubtitleDelaySeconds = 0
    requestedVideoQualityCap = nil
    lastAVBufferReportedBuffering = false
    playbackActiveIntent = false
    lastDroppedVideoFrames = 0
    lastLiveSeekableWindow = nil
    liveRecoveryPolicy.reset()
    osdClockThrottle.reset()
  }

  private func handleAudioSessionEvent(_ event: AudioSessionEvent) {
    let activeSerial = engineLoadSerial > 0 ? engineLoadSerial : activeLoadSerial
    switch event {
    case .interruptionBegan:
      let currentlyPlaying = playbackActiveIntent
        || engine?.playbackPhase == .playing
        || engine?.state == .playing
      let action = audioSessionPolicy.handleInterruptionBegan(currentlyPlaying: currentlyPlaying)
      applyAudioSessionAction(action, serial: activeSerial)

    case let .interruptionEnded(shouldResume):
      let action = audioSessionPolicy.handleInterruptionEnded(shouldResume: shouldResume)
      applyAudioSessionAction(action, serial: activeSerial)

    case let .oldDeviceUnavailable(isRemovedAudioRoute):
      let action = audioSessionPolicy.handleOldDeviceUnavailable(isRemovedAudioRoute: isRemovedAudioRoute)
      applyAudioSessionAction(action, serial: activeSerial)

    case let .routeChanged(activeAirPlayPortName):
      handleAirPlayRouteChanged(activeAirPlayPortName)
    }
  }

  private func applyAudioSessionAction(_ action: AudioSessionAction, serial: Int) {
    switch action {
    case .none:
      break
    case .systemPause:
      playbackActiveIntent = false
      if serial > 0 {
        engine?.pause()
        onObservation?(.phase(.systemPaused), serial)
      }
    case .pauseAndSystemPause:
      playbackActiveIntent = false
      engine?.pause()
      if serial > 0 {
        onObservation?(.phase(.systemPaused), serial)
      }
    case .resume:
      guard serial > 0 else { return }
      playbackActiveIntent = true
      audioSessionController.activateForPlayback()
      engine?.play()
    }
  }

  private func resetSyncDelaysAndQualityOnEngine() {
    engine?.setAudioDelay(0)
    engine?.setSoftwareSubtitleDelay(0)
    if let item = engine?.currentAVPlayer?.currentItem ?? engine?.currentAVPlayerItem {
      item.preferredMaximumResolution = .zero
      item.preferredPeakBitRate = 0
    }
  }

  private func ensureEngine() throws -> AetherEngine {
    if let engine { return engine }
    return try installFreshEngine()
  }

  @discardableResult
  private func installFreshEngine() throws -> AetherEngine {
    let fresh = try AetherEngine()
    engine = fresh
    fresh.backgroundPlaybackEnabled = backgroundAudioEnabled
    fresh.videoGravity = gravity
    fresh.currentAVPlayer?.preventsDisplaySleepDuringVideoPlayback = true
    fresh.currentAVPlayer?.allowsExternalPlayback = true
    applyOutputAudioPreferences(to: fresh.currentAVPlayer)
    subscribe(to: fresh)
    if let view = boundPlayerView {
      fresh.bind(view: view)
    }
    return fresh
  }
}

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

  var engine: AetherEngine?
  var cancellables = Set<AnyCancellable>()
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
  var errorReportedSerial = 0
  var loggedRouteSerial = 0
  var gateGeneration = 0
  private var seekTaskId = 0

  var loadStartUptimeMs: Double = 0
  var openedMsForSerial: Double?

  var currentPlan: MediaPlan?
  var currentLoadOptions: EngineLoadOptions?
  var currentReader: LiveTsReader?
  var desiredAudioStreamId: Int?
  var desiredSubtitleStreamId: Int?

  var loadTask: Task<Void, Never>?
  var seekTask: Task<Void, Never>?
  var audioSwitchTask: Task<Void, Never>?
  var liveRecoveryTask: Task<Void, Never>?
  var liveRecoveryPolicy = LiveRecoveryPolicy()

  var audioInterrupted = false
  var systemPauseUntilUptimeMs: Double = 0

  init(gate: ConnectionGate, httpSession: EngineHttpSession) {
    self.gate = gate
    self.httpSession = httpSession
    self.audioSessionObserver = AetherAudioSessionObserver { [weak self] interrupted, holdWindowMs in
      guard let self else { return }
      if let interrupted {
        self.audioInterrupted = interrupted
      }
      let nowMs = ProcessInfo.processInfo.systemUptime * 1_000.0
      self.systemPauseUntilUptimeMs = max(self.systemPauseUntilUptimeMs, nowMs + holdWindowMs)
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

    runMediaLoad(plan: plan, fallbackOptions: options, serial: serial, currentEngine: currentEngine)
  }

  func stopMedia() {
    resetSerialBookkeeping()
    currentPlan = nil
    currentLoadOptions = nil
    desiredAudioStreamId = nil
    desiredSubtitleStreamId = nil
    gateGeneration += 1
    gate.advance(to: gateGeneration)
    cancelTasksAndReader()
    publishSubtitlePresentation(.empty)
    engine?.stop(resetDisplayCriteria: false, finalTeardown: false)
  }

  func play() {
    systemPauseUntilUptimeMs = 0
    engine?.play()
  }

  func pause() {
    engine?.pause()
  }

  func seek(toSeconds: Double) {
    guard toSeconds.isFinite, let engine, !engine.isLive else { return }
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
      guard let self, let engine, !Task.isCancelled, self.engineLoadSerial == serial else { return }
      await engine.seek(to: max(0, toSeconds))
    }
  }

  func rebuild() throws {
    resetSerialBookkeeping()
    currentPlan = nil
    currentLoadOptions = nil
    desiredAudioStreamId = nil
    desiredSubtitleStreamId = nil
    gateGeneration += 1
    gate.advance(to: gateGeneration)
    cancelTasksAndReader()
    publishSubtitlePresentation(.empty)
    cancellables.removeAll()

    if let previous = engine {
      previous.stop(resetDisplayCriteria: false, finalTeardown: true)
      if let view = boundPlayerView {
        previous.unbind(view: view)
      }
      engine = nil
    }
    _ = try installFreshEngine()
  }

  func dispose() {
    resetSerialBookkeeping()
    currentPlan = nil
    currentLoadOptions = nil
    desiredAudioStreamId = nil
    desiredSubtitleStreamId = nil
    gateGeneration += 1
    gate.advance(to: gateGeneration)
    cancelTasksAndReader()
    publishSubtitlePresentation(.empty)
    cancellables.removeAll()
    audioSessionObserver?.dispose()
    audioSessionObserver = nil

    if let previous = engine {
      previous.stop(resetDisplayCriteria: true, finalTeardown: true)
      if let view = boundPlayerView {
        previous.unbind(view: view)
      }
      engine = nil
    }
    boundPlayerView = nil
    httpSession.dispose()
  }

  func cancelTasksAndReader() {
    loadTask?.cancel()
    loadTask = nil
    seekTask?.cancel()
    seekTask = nil
    audioSwitchTask?.cancel()
    audioSwitchTask = nil
    liveRecoveryTask?.cancel()
    liveRecoveryTask = nil
    closeCurrentReader()
  }

  private func resetSerialBookkeeping() {
    activeLoadSerial = 0
    engineLoadSerial = 0
    readySerial = 0
    tracksEmittedSerial = 0
    pendingTracksSerial = 0
    tracksDeferredForReload = false
    errorReportedSerial = 0
    loggedRouteSerial = 0
    openedMsForSerial = nil
    liveRecoveryPolicy.reset()
  }

  private func ensureEngine() throws -> AetherEngine {
    if let engine { return engine }
    return try installFreshEngine()
  }

  @discardableResult
  private func installFreshEngine() throws -> AetherEngine {
    let fresh = try AetherEngine()
    fresh.backgroundPlaybackEnabled = false
    fresh.videoGravity = gravity
    fresh.currentAVPlayer?.preventsDisplaySleepDuringVideoPlayback = true
    subscribe(to: fresh)
    if let view = boundPlayerView {
      fresh.bind(view: view)
    }
    engine = fresh
    return fresh
  }
}

import AetherEngine
import AVFoundation
import Combine
import Foundation

/// `PlayerBackend` adapter over a single `AetherEngine` instance on the main actor.
@MainActor
final class AetherBackend: PlayerBackend {
  var onObservation: ((BackendObservation, Int) -> Void)?

  private var engine: AetherEngine?
  private var cancellables = Set<AnyCancellable>()
  private weak var boundPlayerView: AetherPlayerView?
  private var gravity: AVLayerVideoGravity = .resizeAspect

  private var activeLoadSerial = 0
  private var errorReportedSerial = 0
  private var loadTask: Task<Void, Never>?
  private var seekTask: Task<Void, Never>?

  init() {
    _ = try? installFreshEngine()
  }

  func bindPlayerView(_ view: AetherPlayerView?) {
    guard boundPlayerView !== view else { return }
    if let previous = boundPlayerView {
      engine?.unbind(view: previous)
    }
    boundPlayerView = view
    if let view, let engine {
      engine.videoGravity = gravity
      engine.bind(view: view)
    }
  }

  func unbindIfMatching(_ view: AetherPlayerView) {
    guard boundPlayerView === view else { return }
    engine?.unbind(view: view)
    boundPlayerView = nil
  }

  func setVideoGravity(_ newGravity: AVLayerVideoGravity) {
    guard gravity != newGravity else { return }
    gravity = newGravity
    engine?.videoGravity = newGravity
  }

  func start(_ plan: MediaPlan, options: EngineLoadOptions, serial: Int) {
    loadTask?.cancel()
    loadTask = nil
    seekTask?.cancel()
    seekTask = nil

    let currentEngine: AetherEngine
    do {
      currentEngine = try ensureEngine()
    } catch {
      let nsError = error as NSError
      onObservation?(
        .failure(
          .engine(
            kind: "sourceOpenFailed",
            underlyingDomain: nsError.domain,
            underlyingCode: nsError.code
          )
        ),
        serial
      )
      return
    }

    activeLoadSerial = serial
    errorReportedSerial = 0
    let loadOpts = aetherOptions(options)

    loadTask = Task { @MainActor [weak self] in
      guard let self, self.activeLoadSerial == serial else { return }
      do {
        switch plan {
        case let .hls(url, _):
          _ = try await currentEngine.load(url: url, options: loadOpts)
        case let .vod(url, startSeconds):
          _ = try await currentEngine.load(url: url, startPosition: startSeconds, options: loadOpts)
        case let .liveTs(url):
          _ = try await currentEngine.load(url: url, options: loadOpts)
        }
      } catch is CancellationError {
        return
      } catch {
        guard self.activeLoadSerial == serial, self.errorReportedSerial != serial else { return }
        self.errorReportedSerial = serial
        let nsError = error as NSError
        self.onObservation?(
          .failure(
            .engine(
              kind: "sourceOpenFailed",
              underlyingDomain: nsError.domain,
              underlyingCode: nsError.code
            )
          ),
          serial
        )
      }
    }
  }

  func stopMedia() {
    activeLoadSerial = 0
    loadTask?.cancel()
    loadTask = nil
    seekTask?.cancel()
    seekTask = nil
    engine?.stop(resetDisplayCriteria: false, finalTeardown: false)
  }

  func play() {
    engine?.play()
  }

  func pause() {
    engine?.pause()
  }

  func seek(toSeconds: Double) {
    guard let engine, !engine.isLive else { return }
    let serial = activeLoadSerial
    guard serial > 0 else { return }
    seekTask?.cancel()
    seekTask = Task { @MainActor [weak self] in
      guard let self, self.activeLoadSerial == serial else { return }
      await engine.seek(to: toSeconds)
    }
  }

  func rebuild() throws {
    activeLoadSerial = 0
    loadTask?.cancel()
    loadTask = nil
    seekTask?.cancel()
    seekTask = nil
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
    activeLoadSerial = 0
    loadTask?.cancel()
    loadTask = nil
    seekTask?.cancel()
    seekTask = nil
    cancellables.removeAll()

    if let previous = engine {
      previous.stop(resetDisplayCriteria: true, finalTeardown: true)
      if let view = boundPlayerView {
        previous.unbind(view: view)
      }
      engine = nil
    }
    boundPlayerView = nil
  }

  private func ensureEngine() throws -> AetherEngine {
    if let engine {
      return engine
    }
    return try installFreshEngine()
  }

  @discardableResult
  private func installFreshEngine() throws -> AetherEngine {
    let fresh = try AetherEngine()
    fresh.backgroundPlaybackEnabled = false
    fresh.videoGravity = gravity
    subscribe(to: fresh)
    if let view = boundPlayerView {
      fresh.bind(view: view)
    }
    engine = fresh
    return fresh
  }

  private func subscribe(to target: AetherEngine) {
    target.$startupProgress
      .sink { [weak self] progress in
        MainActor.assumeIsolated {
          guard let self, self.activeLoadSerial > 0, let progress else { return }
          let serial = self.activeLoadSerial
          if progress.checkpoint >= .sourceOpened {
            self.onObservation?(.opened, serial)
          }
          if progress.checkpoint == .ready {
            self.onObservation?(.ready, serial)
          }
        }
      }
      .store(in: &cancellables)

    target.$videoRoute
      .sink { [weak self] route in
        MainActor.assumeIsolated {
          guard let self, self.activeLoadSerial > 0 else { return }
          if route == .audio {
            self.onObservation?(.audioOnly, self.activeLoadSerial)
          }
        }
      }
      .store(in: &cancellables)

    target.$hasFirstFrameReadyForDisplay
      .sink { [weak self] ready in
        MainActor.assumeIsolated {
          guard let self, self.activeLoadSerial > 0, ready else { return }
          self.onObservation?(.firstFrame, self.activeLoadSerial)
        }
      }
      .store(in: &cancellables)

    target.$playbackPhase
      .sink { [weak self] phase in
        MainActor.assumeIsolated {
          guard let self, self.activeLoadSerial > 0 else { return }
          let serial = self.activeLoadSerial
          switch phase {
          case .idle, .error:
            break
          case .loading:
            self.onObservation?(.phase(.loading), serial)
          case .playing:
            self.onObservation?(.phase(.playing), serial)
          case .paused:
            self.onObservation?(.phase(.paused), serial)
          case .seeking:
            self.onObservation?(.phase(.seeking), serial)
          case .rebuffering:
            self.onObservation?(.phase(.rebuffering), serial)
          case .stalled:
            self.onObservation?(.phase(.stalled), serial)
          case .ended:
            self.onObservation?(.phase(.ended), serial)
          }
        }
      }
      .store(in: &cancellables)

    target.$state
      .sink { [weak self, weak target] state in
        MainActor.assumeIsolated {
          guard let self, let target, self.activeLoadSerial > 0 else { return }
          let serial = self.activeLoadSerial
          switch state {
          case .error:
            guard self.errorReportedSerial != serial else { return }
            self.errorReportedSerial = serial
            let kind = target.errorInfo?.kind.rawValue ?? "unknown"
            let domain = target.errorInfo?.underlyingDomain
            let code = target.errorInfo?.underlyingCode
            self.onObservation?(
              .failure(.engine(kind: kind, underlyingDomain: domain, underlyingCode: code)),
              serial
            )
          case .ended:
            self.onObservation?(.phase(.ended), serial)
          default:
            break
          }
        }
      }
      .store(in: &cancellables)

    target.liveSourceReset
      .sink { [weak self] in
        MainActor.assumeIsolated {
          guard let self, self.activeLoadSerial > 0 else { return }
          let serial = self.activeLoadSerial
          guard self.errorReportedSerial != serial else { return }
          self.errorReportedSerial = serial
          self.onObservation?(.failure(.liveSourceReset), serial)
        }
      }
      .store(in: &cancellables)

    target.clock.$currentTime
      .sink { [weak self, weak target] currentTime in
        MainActor.assumeIsolated {
          guard let self, let target, self.activeLoadSerial > 0 else { return }
          self.emitClockSnapshot(from: target, positionSeconds: currentTime, durationOverride: nil)
        }
      }
      .store(in: &cancellables)

    target.$duration
      .sink { [weak self, weak target] newDuration in
        MainActor.assumeIsolated {
          guard let self, let target, self.activeLoadSerial > 0, newDuration > 0, !target.isLive else {
            return
          }
          self.emitClockSnapshot(
            from: target,
            positionSeconds: target.currentTime,
            durationOverride: newDuration
          )
        }
      }
      .store(in: &cancellables)
  }

  private func emitClockSnapshot(
    from target: AetherEngine,
    positionSeconds: Double,
    durationOverride: Double?
  ) {
    let rate: Double = (target.playbackPhase == .playing || target.state == .playing) ? 1.0 : 0.0
    let rawDuration = durationOverride ?? target.duration
    let durationSeconds: Double? = (!target.isLive && rawDuration > 0) ? rawDuration : nil
    let liveEdgeSeconds: Double? = (target.isLive && target.liveEdgeTime > 0) ? target.liveEdgeTime : nil
    onObservation?(
      .clock(
        positionSeconds: positionSeconds,
        rate: rate,
        durationSeconds: durationSeconds,
        liveEdgeSeconds: liveEdgeSeconds
      ),
      activeLoadSerial
    )
  }
}

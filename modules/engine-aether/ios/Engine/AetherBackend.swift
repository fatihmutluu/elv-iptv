import AetherEngine
import AVFoundation
import Combine
import Foundation

/// `PlayerBackend` adapter over a single `AetherEngine` instance on the main actor.
@MainActor
final class AetherBackend: PlayerBackend {
  var onObservation: ((BackendObservation, Int) -> Void)?

  private let gate: ConnectionGate
  private let httpSession: EngineHttpSession

  private var engine: AetherEngine?
  var cancellables = Set<AnyCancellable>()
  private weak var boundPlayerView: AetherPlayerView?
  private var gravity: AVLayerVideoGravity = .resizeAspect

  var activeLoadSerial = 0
  var engineLoadSerial = 0
  var errorReportedSerial = 0
  var loggedRouteSerial = 0
  private var gateGeneration = 0

  var loadStartUptimeMs: Double = 0
  var openedMsForSerial: Double?

  private var currentReader: LiveTsReader?
  private var loadTask: Task<Void, Never>?
  private var seekTask: Task<Void, Never>?

  init(gate: ConnectionGate, httpSession: EngineHttpSession) {
    self.gate = gate
    self.httpSession = httpSession
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
    activeLoadSerial = 0
    engineLoadSerial = 0
    cancelTasksAndReader()

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
    engineLoadSerial = 0
    errorReportedSerial = 0
    loggedRouteSerial = 0
    loadStartUptimeMs = ProcessInfo.processInfo.systemUptime * 1_000.0
    openedMsForSerial = nil

    gateGeneration += 1
    let generation = gateGeneration
    gate.advance(to: generation)
    let loadOpts = aetherOptions(options)

    loadTask = Task { @MainActor [weak self] in
      guard let self, self.activeLoadSerial == serial, !Task.isCancelled else { return }
      do {
        switch plan {
        case let .hls(url, _):
          guard await self.gate.waitForClosed(before: generation),
                self.activeLoadSerial == serial,
                !Task.isCancelled
          else { return }
          self.engineLoadSerial = serial
          _ = try await currentEngine.load(url: url, options: loadOpts)

        case let .vod(url, startSeconds):
          guard await self.gate.waitForClosed(before: generation),
                self.activeLoadSerial == serial,
                !Task.isCancelled
          else { return }
          self.engineLoadSerial = serial
          _ = try await currentEngine.load(url: url, startPosition: startSeconds, options: loadOpts)

        case let .liveTs(url):
          let session = self.httpSession
          let reader = LiveTsReader(
            url: url,
            headers: options.httpHeaders,
            generation: generation,
            gate: self.gate,
            makeTransport: { URLSessionTransport(session: session) }
          )
          self.currentReader = reader
          let verdict = await reader.open()
          guard self.activeLoadSerial == serial, !Task.isCancelled else {
            reader.close()
            if self.currentReader === reader { self.currentReader = nil }
            return
          }
          switch verdict {
          case let .media(hint):
            self.engineLoadSerial = serial
            _ = try await currentEngine.load(source: .custom(reader, formatHint: hint), options: loadOpts)

          case .playlist:
            reader.close()
            if self.currentReader === reader { self.currentReader = nil }
            self.gateGeneration += 1
            let playlistGeneration = self.gateGeneration
            self.gate.advance(to: playlistGeneration)
            guard await self.gate.waitForClosed(before: playlistGeneration),
                  self.activeLoadSerial == serial,
                  !Task.isCancelled
            else { return }
            var hlsOpts = options
            hlsOpts.isLive = true
            self.engineLoadSerial = serial
            _ = try await currentEngine.load(url: url, options: aetherOptions(hlsOpts))

          case let .failed(rf):
            reader.close()
            if self.currentReader === reader { self.currentReader = nil }
            guard self.errorReportedSerial != serial else { return }
            self.errorReportedSerial = serial
            self.onObservation?(.failure(.reader(rf)), serial)

          case .superseded:
            reader.close()
            if self.currentReader === reader { self.currentReader = nil }
          }
        }
      } catch is CancellationError {
        return
      } catch {
        guard self.activeLoadSerial == serial, self.errorReportedSerial != serial else { return }
        self.errorReportedSerial = serial
        self.forwardReaderFaultIfPresent(serial: serial)
        let nsError = error as NSError
        self.onObservation?(
          .failure(.engine(kind: "sourceOpenFailed", underlyingDomain: nsError.domain, underlyingCode: nsError.code)),
          serial
        )
      }
    }
  }

  func stopMedia() {
    activeLoadSerial = 0
    engineLoadSerial = 0
    gateGeneration += 1
    gate.advance(to: gateGeneration)
    cancelTasksAndReader()
    engine?.stop(resetDisplayCriteria: false, finalTeardown: false)
  }

  func play() { engine?.play() }
  func pause() { engine?.pause() }

  func seek(toSeconds: Double) {
    guard let engine, !engine.isLive else { return }
    let serial = engineLoadSerial
    guard serial > 0 else { return }
    seekTask?.cancel()
    seekTask = Task { @MainActor [weak self] in
      guard let self, self.engineLoadSerial == serial else { return }
      await engine.seek(to: toSeconds)
    }
  }

  func rebuild() throws {
    activeLoadSerial = 0
    engineLoadSerial = 0
    gateGeneration += 1
    gate.advance(to: gateGeneration)
    cancelTasksAndReader()
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
    engineLoadSerial = 0
    gateGeneration += 1
    gate.advance(to: gateGeneration)
    cancelTasksAndReader()
    cancellables.removeAll()

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

  private func cancelTasksAndReader() {
    loadTask?.cancel()
    loadTask = nil
    seekTask?.cancel()
    seekTask = nil
    currentReader?.close()
    currentReader = nil
  }

  func forwardReaderFaultIfPresent(serial: Int) {
    if let rf = currentReader?.lastFailure {
      onObservation?(.readerFault(rf), serial)
    }
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
    subscribe(to: fresh)
    if let view = boundPlayerView {
      fresh.bind(view: view)
    }
    engine = fresh
    return fresh
  }
}

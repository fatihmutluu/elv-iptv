import AetherEngine
import Combine
import Foundation

extension AetherBackend {
  func subscribe(to target: AetherEngine) {
    target.$startupProgress
      .sink { [weak self, weak target] progress in
        MainActor.assumeIsolated {
          guard let self, let target, self.engineLoadSerial > 0, let progress else { return }
          let serial = self.engineLoadSerial
          if progress.checkpoint >= .sourceOpened {
            if self.openedMsForSerial == nil {
              self.openedMsForSerial = max(0, (ProcessInfo.processInfo.systemUptime * 1_000.0) - self.loadStartUptimeMs)
            }
            self.onObservation?(.opened, serial)
          }
          if progress.checkpoint == .ready {
            self.onObservation?(.ready, serial)
            self.maybeLogRouteDiagnostics(from: target, serial: serial)
          }
        }
      }
      .store(in: &cancellables)

    target.$videoRoute
      .sink { [weak self, weak target] route in
        MainActor.assumeIsolated {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          let serial = self.engineLoadSerial
          if route == .audio {
            self.onObservation?(.audioOnly, serial)
          }
          self.maybeLogRouteDiagnostics(from: target, serial: serial)
        }
      }
      .store(in: &cancellables)

    target.$audioDelivery
      .sink { [weak self, weak target] _ in
        MainActor.assumeIsolated {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          self.maybeLogRouteDiagnostics(from: target, serial: self.engineLoadSerial)
        }
      }
      .store(in: &cancellables)

    target.$hasFirstFrameReadyForDisplay
      .sink { [weak self, weak target] ready in
        MainActor.assumeIsolated {
          guard let self, let target, self.engineLoadSerial > 0, ready else { return }
          let serial = self.engineLoadSerial
          self.maybeLogRouteDiagnostics(from: target, serial: serial)
          self.onObservation?(.firstFrame, serial)
        }
      }
      .store(in: &cancellables)

    target.$playbackPhase
      .sink { [weak self, weak target] phase in
        MainActor.assumeIsolated {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          let serial = self.engineLoadSerial
          switch phase {
          case .idle, .error: break
          case .loading: self.onObservation?(.phase(.loading), serial)
          case .playing:
            self.maybeLogRouteDiagnostics(from: target, serial: serial)
            self.onObservation?(.phase(.playing), serial)
          case .paused: self.onObservation?(.phase(.paused), serial)
          case .seeking: self.onObservation?(.phase(.seeking), serial)
          case .rebuffering: self.onObservation?(.phase(.rebuffering), serial)
          case .stalled: self.onObservation?(.phase(.stalled), serial)
          case .ended:
            self.forwardReaderFaultIfPresent(serial: serial)
            self.onObservation?(.phase(.ended), serial)
          }
        }
      }
      .store(in: &cancellables)

    target.$state
      .sink { [weak self, weak target] state in
        MainActor.assumeIsolated {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          let serial = self.engineLoadSerial
          switch state {
          case .error:
            guard self.errorReportedSerial != serial else { return }
            self.errorReportedSerial = serial
            self.forwardReaderFaultIfPresent(serial: serial)
            let kind = target.errorInfo?.kind.rawValue ?? "unknown"
            let domain = target.errorInfo?.underlyingDomain
            let code = target.errorInfo?.underlyingCode
            self.onObservation?(
              .failure(.engine(kind: kind, underlyingDomain: domain, underlyingCode: code)),
              serial
            )
          case .ended:
            self.forwardReaderFaultIfPresent(serial: serial)
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
          guard let self, self.engineLoadSerial > 0 else { return }
          let serial = self.engineLoadSerial
          guard self.errorReportedSerial != serial else { return }
          self.errorReportedSerial = serial
          self.forwardReaderFaultIfPresent(serial: serial)
          self.onObservation?(.failure(.liveSourceReset), serial)
        }
      }
      .store(in: &cancellables)

    target.clock.$currentTime
      .sink { [weak self, weak target] currentTime in
        MainActor.assumeIsolated {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          self.emitClockSnapshot(
            from: target,
            positionSeconds: currentTime,
            durationOverride: nil,
            serial: self.engineLoadSerial
          )
        }
      }
      .store(in: &cancellables)

    target.$duration
      .sink { [weak self, weak target] newDuration in
        MainActor.assumeIsolated {
          guard let self, let target, self.engineLoadSerial > 0, newDuration > 0, !target.isLive else { return }
          self.emitClockSnapshot(
            from: target,
            positionSeconds: target.currentTime,
            durationOverride: newDuration,
            serial: self.engineLoadSerial
          )
        }
      }
      .store(in: &cancellables)
  }

  func maybeLogRouteDiagnostics(from target: AetherEngine, serial: Int) {
    guard loggedRouteSerial != serial, target.videoRoute != .none else { return }
    let audioReady = target.audioDelivery != .none
      || target.playbackPhase == .playing
      || target.hasFirstFrameReadyForDisplay
    guard audioReady else { return }
    loggedRouteSerial = serial
    let openMs = openedMsForSerial ?? max(0, (ProcessInfo.processInfo.systemUptime * 1_000.0) - loadStartUptimeMs)
    NSLog("ELV_AETHER route=%@ open=%.0f audio=%@", target.videoRoute.rawValue, openMs, target.audioDelivery.rawValue)
  }

  func emitClockSnapshot(
    from target: AetherEngine,
    positionSeconds: Double,
    durationOverride: Double?,
    serial: Int
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
      serial
    )
  }
}

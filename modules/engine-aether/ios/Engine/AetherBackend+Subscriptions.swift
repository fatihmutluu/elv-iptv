import AetherEngine
import AVFoundation
import Combine
import Foundation

extension AetherBackend {
  func subscribe(to target: AetherEngine) {
    target.$startupProgress
      .sink { [weak self, weak target] progress in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0, let progress else { return }
          let serial = self.engineLoadSerial
          if progress.checkpoint >= .sourceOpened {
            if self.openedMsForSerial == nil {
              self.openedMsForSerial = max(0, (ProcessInfo.processInfo.systemUptime * 1_000.0) - self.loadStartUptimeMs)
            }
            self.onObservation?(.opened, serial)
          }
          if progress.checkpoint == .ready {
            self.readySerial = serial
            self.onObservation?(.ready, serial)
            self.scheduleTracksSnapshot(from: target, serial: serial)
            self.maybeLogRouteDiagnostics(from: target, serial: serial)
          }
        }
      }
      .store(in: &cancellables)

    target.$videoRoute
      .sink { [weak self, weak target] route in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          let serial = self.engineLoadSerial
          if route == .audio {
            self.onObservation?(.audioOnly, serial)
          }
          self.maybeLogRouteDiagnostics(from: target, serial: serial, routeOverride: route)
        }
      }
      .store(in: &cancellables)

    target.$audioDelivery
      .sink { [weak self, weak target] delivery in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          self.maybeLogRouteDiagnostics(from: target, serial: self.engineLoadSerial, audioOverride: delivery)
        }
      }
      .store(in: &cancellables)

    target.$hasFirstFrameReadyForDisplay
      .sink { [weak self, weak target] ready in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0, ready else { return }
          let serial = self.engineLoadSerial
          self.maybeLogRouteDiagnostics(from: target, serial: serial, firstFrameOverride: true)
          self.onObservation?(.firstFrame, serial)
          self.refreshSubtitleGeometry(from: target)
        }
      }
      .store(in: &cancellables)

    target.$currentAVPlayer
      .sink { [weak target] player in
        if Thread.isMainThread {
          MainActor.assumeIsolated {
            player?.preventsDisplaySleepDuringVideoPlayback = true
          }
        } else {
          Self.onMainActor {
            target?.currentAVPlayer?.preventsDisplaySleepDuringVideoPlayback = true
          }
        }
      }
      .store(in: &cancellables)

    target.$currentAVPlayerItem
      .sink { [weak self, weak target] _ in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          self.refreshSubtitleGeometry(from: target)
        }
      }
      .store(in: &cancellables)

    target.$playbackPhase
      .sink { [weak self, weak target] phase in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          let serial = self.engineLoadSerial
          switch phase {
          case .idle, .error:
            break
          case .loading:
            self.onObservation?(.phase(.loading), serial)
          case .playing:
            self.readySerial = serial
            self.maybeLogRouteDiagnostics(from: target, serial: serial, phaseOverride: .playing)
            self.onObservation?(.phase(.playing), serial)
            if self.tracksEmittedSerial != serial || self.tracksDeferredForReload {
              self.tracksDeferredForReload = false
              self.scheduleTracksSnapshot(from: target, serial: serial)
            }
            self.refreshSubtitleGeometry(from: target)
            if target.currentTime > 0 {
              self.emitClockSnapshot(
                from: target,
                positionSeconds: target.currentTime,
                rateOverride: 1.0,
                durationOverride: nil,
                serial: serial
              )
            }
          case .paused:
            if target.state == .loading {
              self.onObservation?(.phase(.loading), serial)
            } else {
              let nowMs = ProcessInfo.processInfo.systemUptime * 1_000.0
              let bySystem = self.audioInterrupted || nowMs <= self.systemPauseUntilUptimeMs
              self.onObservation?(.phase(bySystem ? .systemPaused : .paused), serial)
            }
          case .seeking:
            self.onObservation?(.phase(.seeking), serial)
          case .rebuffering:
            self.onObservation?(.phase(.rebuffering), serial)
          case .stalled:
            self.onObservation?(.phase(.stalled), serial)
          case .ended:
            self.forwardVodDurationBeforeEnd(from: target, serial: serial)
            self.forwardReaderFaultIfPresent(serial: serial)
            self.onObservation?(.phase(.ended), serial)
          }
        }
      }
      .store(in: &cancellables)

    target.$state
      .sink { [weak self, weak target] state in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          let serial = self.engineLoadSerial
          switch state {
          case .error:
            guard self.errorReportedSerial != serial else { return }
            DispatchQueue.main.async { [weak self, weak target] in
              MainActor.assumeIsolated {
                guard let self, let target,
                      self.engineLoadSerial == serial,
                      self.errorReportedSerial != serial
                else { return }
                self.errorReportedSerial = serial
                self.forwardReaderFaultIfPresent(serial: serial)
                let kind = target.errorInfo?.kind.rawValue ?? "unknown"
                let domain = target.errorInfo?.underlyingDomain
                let code = target.errorInfo?.underlyingCode
                self.onObservation?(
                  .failure(.engine(kind: kind, underlyingDomain: domain, underlyingCode: code)),
                  serial
                )
              }
            }
          case .loading:
            if self.readySerial == serial {
              self.onObservation?(.phase(.loading), serial)
            }
          case .playing, .paused:
            if self.tracksDeferredForReload {
              self.tracksDeferredForReload = false
              self.scheduleTracksSnapshot(from: target, serial: serial)
            }
          case .ended:
            self.forwardVodDurationBeforeEnd(from: target, serial: serial)
            self.forwardReaderFaultIfPresent(serial: serial)
            self.onObservation?(.phase(.ended), serial)
          default:
            break
          }
        }
      }
      .store(in: &cancellables)

    target.liveSourceReplayExhausted
      .sink { [weak self, weak target] in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0 else { return }
          self.handleLiveReplayExhausted(from: target, serial: self.engineLoadSerial)
        }
      }
      .store(in: &cancellables)

    target.liveSourceReset
      .sink { [weak self] in
        Self.onMainActor {
          guard let self, self.engineLoadSerial > 0 else { return }
          self.escalateLiveSourceReset(serial: self.engineLoadSerial)
        }
      }
      .store(in: &cancellables)

    target.clock.$currentTime
      .sink { [weak self, weak target] currentTime in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0, target.videoRoute != .none else { return }
          guard target.hasFirstFrameReadyForDisplay || target.videoRoute == .audio else { return }
          let phase = target.playbackPhase
          guard phase != .idle, phase != .loading, phase != .seeking,
                target.state != .idle, target.state != .loading, target.state != .seeking
          else { return }
          self.emitClockSnapshot(
            from: target,
            positionSeconds: currentTime,
            rateOverride: nil,
            durationOverride: nil,
            serial: self.engineLoadSerial
          )
        }
      }
      .store(in: &cancellables)

    target.$duration
      .sink { [weak self, weak target] newDuration in
        Self.onMainActor {
          guard let self, let target, self.engineLoadSerial > 0, newDuration.isFinite, newDuration > 0, !target.isLive else {
            return
          }
          self.onObservation?(.duration(newDuration), self.engineLoadSerial)
        }
      }
      .store(in: &cancellables)

    subscribeTracksAndSubtitles(to: target)
  }

  private func forwardVodDurationBeforeEnd(from target: AetherEngine, serial: Int) {
    guard !target.isLive, target.duration.isFinite, target.duration > 0 else { return }
    onObservation?(.duration(target.duration), serial)
  }

  func maybeLogRouteDiagnostics(
    from target: AetherEngine,
    serial: Int,
    routeOverride: VideoRoute? = nil,
    audioOverride: AudioDelivery? = nil,
    phaseOverride: PlaybackPhase? = nil,
    firstFrameOverride: Bool? = nil
  ) {
    let route = routeOverride ?? target.videoRoute
    guard loggedRouteSerial != serial, route != .none else { return }
    let audio = audioOverride ?? target.audioDelivery
    let phase = phaseOverride ?? target.playbackPhase
    let firstFrame = firstFrameOverride ?? target.hasFirstFrameReadyForDisplay
    let audioReady = audio != .none || phase == .playing || firstFrame
    guard audioReady else { return }
    loggedRouteSerial = serial
    let openMs = openedMsForSerial ?? max(0, (ProcessInfo.processInfo.systemUptime * 1_000.0) - loadStartUptimeMs)
    NSLog("ELV_AETHER route=%@ open=%.0f audio=%@", route.rawValue, openMs, audio.rawValue)
  }

  func emitClockSnapshot(
    from target: AetherEngine,
    positionSeconds: Double,
    rateOverride: Double?,
    durationOverride: Double?,
    serial: Int
  ) {
    let isPlaying = (rateOverride ?? 0) > 0 || target.playbackPhase == .playing || target.state == .playing
    let rate: Double = rateOverride ?? (isPlaying ? 1.0 : 0.0)
    if target.isLive {
      liveRecoveryPolicy.noteClockProgress(positionSeconds: positionSeconds, isPlaying: isPlaying)
    }
    let rawDuration = durationOverride ?? target.duration
    let durationSeconds: Double? = (!target.isLive && rawDuration.isFinite && rawDuration > 0) ? rawDuration : nil
    let liveEdgeSeconds: Double? = (target.isLive && target.liveEdgeTime.isFinite && target.liveEdgeTime > 0) ? target.liveEdgeTime : nil
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

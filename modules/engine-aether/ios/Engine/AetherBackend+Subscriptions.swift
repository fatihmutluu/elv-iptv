import AetherEngine
import AVFoundation
import Combine
import CoreMedia
import Foundation
#if canImport(UIKit)
import UIKit
#endif

extension AetherBackend {
  func subscribe(to target: AetherEngine) {
    target.$startupProgress
      .sink { [weak self, weak target] progress in
        Self.onMainActor {
          guard let self, let target, self.engine === target, self.engineLoadSerial > 0, let progress else { return }
          let serial = self.engineLoadSerial
          if progress.checkpoint >= .sourceOpened {
            if self.openedMsForSerial == nil {
              self.openedMsForSerial = max(0, (ProcessInfo.processInfo.systemUptime * 1_000.0) - self.loadStartUptimeMs)
              self.onObservation?(.progress(bytesReceived: nil, bufferedSeconds: nil), serial)
            }
            self.onObservation?(.opened, serial)
          }
          if progress.checkpoint == .ready {
            if self.readySerial != serial {
              self.onObservation?(.progress(bytesReceived: nil, bufferedSeconds: nil), serial)
            }
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
          guard let self, let target, self.engine === target, self.engineLoadSerial > 0 else { return }
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
          guard let self, let target, self.engine === target, self.engineLoadSerial > 0 else { return }
          self.maybeLogRouteDiagnostics(from: target, serial: self.engineLoadSerial, audioOverride: delivery)
        }
      }
      .store(in: &cancellables)

    target.$hasFirstFrameReadyForDisplay
      .sink { [weak self, weak target] ready in
        Self.onMainActor {
          guard let self, let target, self.engine === target, self.engineLoadSerial > 0, ready else { return }
          let serial = self.engineLoadSerial
          self.maybeLogRouteDiagnostics(from: target, serial: serial, firstFrameOverride: true)
          self.onObservation?(.firstFrame, serial)
          self.refreshSubtitleGeometry(from: target)
          self.inspectAndEmitVideoInfo(from: target, serial: serial)
          self.onPlayerLayerMayHaveChanged?()
        }
      }
      .store(in: &cancellables)

    target.$currentAVPlayer
      .sink { [weak self, weak target] player in
        if Thread.isMainThread {
          MainActor.assumeIsolated {
            guard let self, let target, self.engine === target else { return }
            self.observeAVPlayer(player, target: target)
          }
        } else {
          Self.onMainActor {
            guard let self, let target, self.engine === target else { return }
            self.observeAVPlayer(target.currentAVPlayer, target: target)
          }
        }
      }
      .store(in: &cancellables)

    target.$currentAVPlayerItem
      .sink { [weak self, weak target] item in
        if Thread.isMainThread {
          MainActor.assumeIsolated {
            guard let self, let target, self.engine === target else { return }
            self.observeAVPlayerItem(item, target: target)
          }
        } else {
          Self.onMainActor {
            guard let self, let target, self.engine === target else { return }
            self.observeAVPlayerItem(target.currentAVPlayerItem, target: target)
          }
        }
      }
      .store(in: &cancellables)

    target.$playbackPhase
      .sink { [weak self, weak target] phase in
        Self.onMainActor {
          guard let self, let target, self.engine === target, self.engineLoadSerial > 0 else { return }
          let serial = self.engineLoadSerial
          switch phase {
          case .idle, .error:
            self.cancelPausedLiveClockTask()
          case .loading:
            self.cancelPausedLiveClockTask()
            self.onObservation?(.phase(.loading), serial)
          case .playing:
            self.cancelPausedLiveClockTask()
            self.readySerial = serial
            self.inReloadFromState = false
            self.lastAVBufferReportedBuffering = false
            self.playbackActiveIntent = true
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
                rateOverride: self.requestedRate,
                durationOverride: nil,
                serial: serial
              )
            }
          case .paused:
            if target.state == .loading {
              self.cancelPausedLiveClockTask()
              self.inReloadFromState = true
              self.onObservation?(.phase(.loading), serial)
            } else {
              self.inReloadFromState = false
              let bySystem = self.audioSessionPolicy.shouldTreatPauseAsSystem
              self.onObservation?(.phase(bySystem ? .systemPaused : .paused), serial)
              self.syncPausedLiveClockTask(for: target)
            }
          case .seeking:
            self.cancelPausedLiveClockTask()
            self.onObservation?(.phase(.seeking), serial)
          case .rebuffering:
            self.cancelPausedLiveClockTask()
            self.onObservation?(.phase(.rebuffering), serial)
          case .stalled:
            self.cancelPausedLiveClockTask()
            self.onObservation?(.phase(.stalled), serial)
          case .ended:
            self.cancelPausedLiveClockTask()
            self.playbackActiveIntent = false
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
          guard let self, let target, self.engine === target else { return }
          if case .error = state {
            self.cancelPausedLiveClockTask()
            let errorSerial = self.engineLoadSerial > 0 ? self.engineLoadSerial : self.activeLoadSerial
            guard errorSerial > 0, self.errorReportedSerial != errorSerial else { return }
            self.playbackActiveIntent = false
            let capturedReaderFault = self.currentReader?.lastFailure
            if let info = target.errorInfo {
              let capturedKind = info.kind.rawValue
              let capturedDomain = info.underlyingDomain
              let capturedCode = info.underlyingCode
              self.errorReportedSerial = errorSerial
              self.recordVodThrottleIfNeeded(kind: capturedKind, underlyingCode: capturedCode, serial: errorSerial)
              if let capturedReaderFault {
                self.onObservation?(.readerFault(capturedReaderFault), errorSerial)
              }
              self.onObservation?(
                .failure(.engine(kind: capturedKind, underlyingDomain: capturedDomain, underlyingCode: capturedCode)),
                errorSerial
              )
            } else {
              DispatchQueue.main.async { [weak self, weak target] in
                MainActor.assumeIsolated {
                  guard let self, let target,
                        self.engine === target,
                        (self.engineLoadSerial == errorSerial || self.activeLoadSerial == errorSerial),
                        self.errorReportedSerial != errorSerial
                  else { return }
                  self.errorReportedSerial = errorSerial
                  if let readerFault = capturedReaderFault ?? self.currentReader?.lastFailure {
                    self.onObservation?(.readerFault(readerFault), errorSerial)
                  }
                  let kind = target.errorInfo?.kind.rawValue ?? "unknown"
                  let domain = target.errorInfo?.underlyingDomain
                  let code = target.errorInfo?.underlyingCode
                  self.recordVodThrottleIfNeeded(kind: kind, underlyingCode: code, serial: errorSerial)
                  self.onObservation?(
                    .failure(.engine(kind: kind, underlyingDomain: domain, underlyingCode: code)),
                    errorSerial
                  )
                }
              }
            }
            return
          }
          guard self.engineLoadSerial > 0 else { return }
          let serial = self.engineLoadSerial
          switch state {
          case .error:
            break
          case .loading:
            self.cancelPausedLiveClockTask()
            if self.readySerial == serial {
              self.inReloadFromState = true
              self.onObservation?(.phase(.loading), serial)
            }
          case .playing:
            self.cancelPausedLiveClockTask()
            if self.inReloadFromState && target.playbackPhase == .playing {
              self.inReloadFromState = false
              self.playbackActiveIntent = true
              self.onObservation?(.phase(.playing), serial)
            }
            if self.tracksDeferredForReload {
              self.tracksDeferredForReload = false
              self.scheduleTracksSnapshot(from: target, serial: serial)
            }
          case .paused:
            if self.inReloadFromState {
              self.inReloadFromState = false
              let bySystem = self.audioSessionPolicy.shouldTreatPauseAsSystem
              self.onObservation?(.phase(bySystem ? .systemPaused : .paused), serial)
            }
            self.syncPausedLiveClockTask(for: target)
            if self.tracksDeferredForReload {
              self.tracksDeferredForReload = false
              self.scheduleTracksSnapshot(from: target, serial: serial)
            }
          case .ended:
            self.cancelPausedLiveClockTask()
            self.playbackActiveIntent = false
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
          guard let self, let target, self.engine === target, self.engineLoadSerial > 0 else { return }
          self.handleLiveReplayExhausted(from: target, serial: self.engineLoadSerial)
        }
      }
      .store(in: &cancellables)

    target.liveSourceReset
      .sink { [weak self, weak target] in
        Self.onMainActor {
          guard let self, let target, self.engine === target, self.engineLoadSerial > 0 else { return }
          self.escalateLiveSourceReset(serial: self.engineLoadSerial)
        }
      }
      .store(in: &cancellables)

    target.clock.$currentTime
      .sink { [weak self, weak target] currentTime in
        Self.onMainActor {
          guard let self, let target, self.engine === target, self.engineLoadSerial > 0, target.videoRoute != .none else { return }
          guard target.hasFirstFrameReadyForDisplay || target.videoRoute == .audio else { return }
          let phase = target.playbackPhase
          guard phase != .idle, phase != .loading, phase != .seeking,
                target.state != .idle, target.state != .loading, target.state != .seeking
          else { return }
          let isPlaying = phase == .playing || target.state == .playing
          if target.isLive {
            self.liveRecoveryPolicy.noteClockProgress(positionSeconds: currentTime, isPlaying: isPlaying)
          }
          let rate = isPlaying ? self.requestedRate : 0.0
          let nowSeconds = ProcessInfo.processInfo.systemUptime
          guard self.osdClockThrottle.shouldEmit(nowSeconds: nowSeconds, rate: rate, isPlaying: isPlaying) else {
            return
          }
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
          guard let self, let target, self.engine === target, self.engineLoadSerial > 0, newDuration.isFinite, newDuration > 0, !target.isLive else {
            return
          }
          self.onObservation?(.duration(newDuration), self.engineLoadSerial)
        }
      }
      .store(in: &cancellables)

    subscribeTracksAndSubtitles(to: target)
  }

  /// Explicitly cancels and clears `AVPlayerItem` KVO/Combine and subtitle-clock observers before item replacement, stop, rebuild, or dispose (`#117`).
  func clearPlayerItemObservers() {
    observedAVPlayerItemId = nil
    itemProgressCancellable?.cancel()
    itemProgressCancellable = nil
    for cancellable in avPlayerItemBufferCancellables {
      cancellable.cancel()
    }
    avPlayerItemBufferCancellables.removeAll()
    subtitleClockCancellable?.cancel()
    subtitleClockCancellable = nil
    externalSubtitleClockCancellable?.cancel()
    externalSubtitleClockCancellable = nil
    lastAVBufferReportedBuffering = false
    lastObservedErrorLogCount = 0
    latestVodBufferHealth = nil
  }

  private func observeAVPlayer(_ player: AVPlayer?, target: AetherEngine) {
    observedAVPlayerId = nil
    for cancellable in avPlayerBufferCancellables {
      cancellable.cancel()
    }
    avPlayerBufferCancellables.removeAll()
    lastAVBufferReportedBuffering = false
    guard let player else {
      onPlayerLayerMayHaveChanged?()
      return
    }
    player.preventsDisplaySleepDuringVideoPlayback = true
    player.allowsExternalPlayback = true
    applyOutputAudioPreferences(to: player)
    onPlayerLayerMayHaveChanged?()
    let playerId = ObjectIdentifier(player)
    observedAVPlayerId = playerId
    player.publisher(for: \.isExternalPlaybackActive, options: [.initial, .new])
      .sink { [weak self, weak target] active in
        Self.onMainActor {
          guard let self, let target,
                self.engine === target,
                self.observedAVPlayerId == playerId
          else { return }
          self.handleExternalPlaybackChange(active)
        }
      }
      .store(in: &avPlayerBufferCancellables)
    player.publisher(for: \.timeControlStatus, options: [.new])
      .sink { [weak self, weak target] _ in
        Self.onMainActor {
          guard let self, let target,
                self.engine === target,
                self.observedAVPlayerId == playerId
          else { return }
          self.evaluateAVPlayerBufferingState(from: target)
        }
      }
      .store(in: &avPlayerBufferCancellables)
    player.publisher(for: \.reasonForWaitingToPlay, options: [.new])
      .sink { [weak self, weak target] _ in
        Self.onMainActor {
          guard let self, let target,
                self.engine === target,
                self.observedAVPlayerId == playerId
          else { return }
          self.evaluateAVPlayerBufferingState(from: target)
        }
      }
      .store(in: &avPlayerBufferCancellables)
  }

  private func observeAVPlayerItem(_ item: AVPlayerItem?, target: AetherEngine) {
    clearPlayerItemObservers()
    guard self.engine === target, engineLoadSerial > 0 else { return }
    refreshSubtitleGeometry(from: target)
    guard let item else { return }
    applyVideoQualityCap(to: item)
    applyVodBufferBudget(to: item, target: target)
    updateSubtitleClockSubscription(
      target: target,
      cues: target.subtitleCues,
      followsPicture: target.clock.sourceTimeFollowsPicture,
      isSubActive: target.isSubtitleActive,
      softwareSize: target.softwareDisplaySize
    )
    let observedSerial = engineLoadSerial
    let itemId = ObjectIdentifier(item)
    observedAVPlayerItemId = itemId
    itemProgressCancellable = item.publisher(for: \.loadedTimeRanges)
      .sink { [weak self, weak target] ranges in
        var samples: [LoadedTimeRangeSample] = []
        samples.reserveCapacity(ranges.count)
        let bufferedEnd = ranges.reduce(0.0) { acc, value in
          let range = value.timeRangeValue
          let start = CMTimeGetSeconds(range.start)
          let duration = CMTimeGetSeconds(range.duration)
          if start.isFinite, duration.isFinite {
            samples.append(LoadedTimeRangeSample(startSeconds: start, durationSeconds: duration))
          }
          let end = CMTimeGetSeconds(CMTimeRangeGetEnd(range))
          return (end.isFinite && end > acc) ? end : acc
        }
        let capturedSamples = samples
        Self.onMainActor {
          guard let self, let target,
                self.engine === target,
                self.engineLoadSerial == observedSerial,
                self.observedAVPlayerItemId == itemId
          else { return }
          if !self.isCurrentStreamLive(target: target),
             let health = extractAppleBufferHealth(
               ranges: capturedSamples,
               currentTimeSeconds: target.currentTime,
               throttled: self.vodThrottleBackoffLevel > 0
             )
          {
            self.latestVodBufferHealth = health
            self.onObservation?(.bufferHealth(health), observedSerial)
          }
          let accessEvents = target.currentAVPlayerItem?.accessLog()?.events ?? []
          let bytes = accessEvents.reduce(Int64(0)) { acc, ev in
            acc + max(0, ev.numberOfBytesTransferred)
          }
          self.pollDroppedVideoFrames(from: target, serial: observedSerial, accessEvents: accessEvents)
          if bytes > 0 || bufferedEnd > 0 {
            self.onObservation?(
              .progress(
                bytesReceived: bytes > 0 ? bytes : nil,
                bufferedSeconds: bufferedEnd > 0 ? bufferedEnd : nil
              ),
              observedSerial
            )
          }
        }
      }

    NotificationCenter.default.publisher(for: AVPlayerItem.newErrorLogEntryNotification, object: item)
      .sink { [weak self, weak target] _ in
        Self.onMainActor {
          guard let self, let target,
                let item = self.activeObservedAVPlayerItem(target: target, observedSerial: observedSerial, itemId: itemId)
          else { return }
          self.handleVodErrorLogUpdate(for: item, target: target)
        }
      }
      .store(in: &avPlayerItemBufferCancellables)

    NotificationCenter.default.publisher(for: ProcessInfo.thermalStateDidChangeNotification)
      .sink { [weak self, weak target] _ in
        Self.onMainActor {
          guard let self, let target,
                let item = self.activeObservedAVPlayerItem(target: target, observedSerial: observedSerial, itemId: itemId)
          else { return }
          self.applyVodBufferBudget(to: item, target: target)
        }
      }
      .store(in: &avPlayerItemBufferCancellables)

    #if canImport(UIKit)
    NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)
      .sink { [weak self, weak target] _ in
        Self.onMainActor {
          guard let self, let target,
                let item = self.activeObservedAVPlayerItem(target: target, observedSerial: observedSerial, itemId: itemId)
          else { return }
          self.vodMemoryWarningLatched = true
          self.applyVodBufferBudget(to: item, target: target)
        }
      }
      .store(in: &avPlayerItemBufferCancellables)
    #endif

    item.publisher(for: \.isPlaybackBufferEmpty, options: [.new])
      .sink { [weak self, weak target] _ in
        Self.onMainActor {
          guard let self, let target,
                self.engine === target,
                self.engineLoadSerial == observedSerial,
                self.observedAVPlayerItemId == itemId
          else { return }
          self.evaluateAVPlayerBufferingState(from: target)
        }
      }
      .store(in: &avPlayerItemBufferCancellables)
    item.publisher(for: \.isPlaybackBufferFull, options: [.new])
      .sink { [weak self, weak target] _ in
        Self.onMainActor {
          guard let self, let target,
                self.engine === target,
                self.engineLoadSerial == observedSerial,
                self.observedAVPlayerItemId == itemId
          else { return }
          self.evaluateAVPlayerBufferingState(from: target)
        }
      }
      .store(in: &avPlayerItemBufferCancellables)
    item.publisher(for: \.isPlaybackLikelyToKeepUp, options: [.new])
      .sink { [weak self, weak target] _ in
        Self.onMainActor {
          guard let self, let target,
                self.engine === target,
                self.engineLoadSerial == observedSerial,
                self.observedAVPlayerItemId == itemId
          else { return }
          self.evaluateAVPlayerBufferingState(from: target)
        }
      }
      .store(in: &avPlayerItemBufferCancellables)
  }

  private func evaluateAVPlayerBufferingState(from target: AetherEngine) {
    guard engineLoadSerial > 0,
          target.hasFirstFrameReadyForDisplay || target.videoRoute == .audio
    else {
      lastAVBufferReportedBuffering = false
      return
    }
    let phase = target.playbackPhase
    guard phase != .idle, phase != .loading, phase != .seeking, phase != .ended,
          target.state != .idle, target.state != .loading, target.state != .seeking, target.state != .ended
    else {
      lastAVBufferReportedBuffering = false
      return
    }
    guard let player = target.currentAVPlayer, let item = target.currentAVPlayerItem else {
      lastAVBufferReportedBuffering = false
      return
    }
    if player.isExternalPlaybackActive {
      lastAVBufferReportedBuffering = false
      return
    }

    let isWaiting = player.timeControlStatus == .waitingToPlayAtSpecifiedRate
    let waitingReason = player.reasonForWaitingToPlay
    let waitingToMinimizeStallsOrEvaluating = waitingReason == .toMinimizeStalls
      || waitingReason == .evaluatingBufferingRate
    let isUserPaused = player.timeControlStatus == .paused
      || phase == .paused
      || target.state == .paused
      || audioSessionPolicy.shouldTreatPauseAsSystem

    let snapshot = AVBufferSnapshot(
      isPlaybackBufferEmpty: item.isPlaybackBufferEmpty,
      isPlaybackBufferFull: item.isPlaybackBufferFull,
      isPlaybackLikelyToKeepUp: item.isPlaybackLikelyToKeepUp,
      isWaitingToPlay: isWaiting,
      waitingToMinimizeStallsOrEvaluating: waitingToMinimizeStallsOrEvaluating,
      isUserPaused: isUserPaused
    )
    let isBuffering = evaluateAVPlayerBuffering(snapshot)
    if isBuffering && !lastAVBufferReportedBuffering {
      lastAVBufferReportedBuffering = true
      onObservation?(.phase(.rebuffering), engineLoadSerial)
    } else if !isBuffering && lastAVBufferReportedBuffering {
      lastAVBufferReportedBuffering = false
      if player.timeControlStatus == .playing && (phase == .playing || target.state == .playing) {
        onObservation?(.phase(.playing), engineLoadSerial)
      }
    }
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

  func pollDroppedVideoFrames(
    from target: AetherEngine,
    serial: Int,
    accessEvents: [AVPlayerItemAccessLogEvent]? = nil
  ) {
    let events = accessEvents ?? target.currentAVPlayerItem?.accessLog()?.events ?? []
    guard !events.isEmpty else { return }
    let dropped = events.reduce(0) { acc, ev in
      acc + max(0, ev.numberOfDroppedVideoFrames)
    }
    guard dropped > lastDroppedVideoFrames else { return }
    lastDroppedVideoFrames = dropped
    onObservation?(.telemetry(droppedFrames: dropped), serial)
  }

  func readLiveSeekableWindow(from target: AetherEngine) -> LiveSeekableWindow? {
    guard target.isLive, currentPlan?.isLiveTs != true else { return nil }
    guard let item = target.currentAVPlayerItem ?? target.currentAVPlayer?.currentItem else {
      return nil
    }
    let ranges: [(startSec: Double, endSec: Double)] = item.seekableTimeRanges.compactMap { value in
      let range = value.timeRangeValue
      let start = CMTimeGetSeconds(range.start)
      let end = CMTimeGetSeconds(CMTimeRangeGetEnd(range))
      guard start.isFinite, end.isFinite else { return nil }
      return (startSec: start, endSec: end)
    }
    return evaluateLiveSeekRanges(ranges)
  }

  func isCurrentStreamLive(target: AetherEngine) -> Bool {
    currentLoadOptions?.isLive ?? target.isLive
  }

  private func activeObservedAVPlayerItem(
    target: AetherEngine,
    observedSerial: Int,
    itemId: ObjectIdentifier
  ) -> AVPlayerItem? {
    guard engine === target,
          engineLoadSerial == observedSerial,
          observedAVPlayerItemId == itemId,
          let item = target.currentAVPlayerItem ?? target.currentAVPlayer?.currentItem,
          ObjectIdentifier(item) == itemId
    else { return nil }
    return item
  }

  func applyVodBufferBudget(to item: AVPlayerItem, target: AetherEngine) {
    let currentIsLive = isCurrentStreamLive(target: target)
    if currentIsLive {
      item.preferredForwardBufferDuration = 0
      return
    }
    let preset = currentLoadOptions?.bufferPreset ?? .auto
    let lowMemoryPressure = shouldApplyAppleLowMemoryPressure(
      thermalState: ProcessInfo.processInfo.thermalState,
      memoryWarningActive: vodMemoryWarningLatched
    )
    let budget = computeAppleVodBufferBudget(
      isLive: false,
      preset: preset,
      physicalMemoryBytes: ProcessInfo.processInfo.physicalMemory,
      throttleBackoffLevel: vodThrottleBackoffLevel,
      lowMemoryPressure: lowMemoryPressure
    )
    item.preferredForwardBufferDuration = budget.enabled ? budget.preferredForwardBufferDurationSeconds : 0
  }

  func recordVodThrottleIfNeeded(kind: String?, underlyingCode: Int?, serial: Int) {
    guard !(currentLoadOptions?.isLive ?? engine?.isLive ?? true),
          vodThrottleRecordedSerial != serial
    else { return }
    let status: Int?
    if underlyingCode == 429 || underlyingCode == 509 {
      status = underlyingCode
    } else if kind == "sourceRateLimited" {
      status = 429
    } else {
      status = nil
    }
    guard let status else { return }
    vodThrottleRecordedSerial = serial
    vodThrottleBackoffLevel = nextAppleThrottleBackoffLevel(current: vodThrottleBackoffLevel, httpStatus: status)
    if let target = engine, let item = target.currentAVPlayerItem ?? target.currentAVPlayer?.currentItem {
      applyVodBufferBudget(to: item, target: target)
    }
  }

  private func handleVodErrorLogUpdate(for item: AVPlayerItem, target: AetherEngine) {
    guard !isCurrentStreamLive(target: target) else { return }
    let events = item.errorLog()?.events ?? []
    guard events.count > lastObservedErrorLogCount else { return }
    let newEvents = events[lastObservedErrorLogCount...]
    lastObservedErrorLogCount = events.count
    var updated = false
    for event in newEvents {
      let nextLevel = nextAppleThrottleBackoffLevel(
        current: vodThrottleBackoffLevel,
        httpStatus: event.errorStatusCode
      )
      if nextLevel != vodThrottleBackoffLevel {
        vodThrottleBackoffLevel = nextLevel
        updated = true
      }
    }
    if updated {
      applyVodBufferBudget(to: item, target: target)
    }
  }

  func readVodBufferHealth(from target: AetherEngine, currentTimeSeconds: Double) -> AppleBufferHealth? {
    guard !isCurrentStreamLive(target: target),
          let item = target.currentAVPlayerItem ?? target.currentAVPlayer?.currentItem
    else { return nil }
    let samples: [LoadedTimeRangeSample] = item.loadedTimeRanges.compactMap { value in
      let range = value.timeRangeValue
      let start = CMTimeGetSeconds(range.start)
      let duration = CMTimeGetSeconds(range.duration)
      guard start.isFinite, duration.isFinite else { return nil }
      return LoadedTimeRangeSample(startSeconds: start, durationSeconds: duration)
    }
    return extractAppleBufferHealth(
      ranges: samples,
      currentTimeSeconds: currentTimeSeconds,
      throttled: vodThrottleBackoffLevel > 0
    )
  }

  func emitClockSnapshot(
    from target: AetherEngine,
    positionSeconds: Double,
    rateOverride: Double?,
    durationOverride: Double?,
    serial: Int
  ) {
    pollDroppedVideoFrames(from: target, serial: serial)
    let isPlaying = (rateOverride ?? 0) > 0 || target.playbackPhase == .playing || target.state == .playing
    let rate: Double = rateOverride ?? (isPlaying ? requestedRate : 0.0)
    if target.isLive {
      liveRecoveryPolicy.noteClockProgress(positionSeconds: positionSeconds, isPlaying: isPlaying)
    }
    let rawDuration = durationOverride ?? target.duration
    let durationSeconds: Double? = (!target.isLive && rawDuration.isFinite && rawDuration > 0) ? rawDuration : nil
    let liveWindow = readLiveSeekableWindow(from: target)
    lastLiveSeekableWindow = liveWindow
    let fallbackLiveEdge: Double? =
      (target.isLive && target.liveEdgeTime.isFinite && target.liveEdgeTime > 0) ? target.liveEdgeTime : nil
    let liveEdgeSeconds: Double? = liveWindow?.endSec ?? fallbackLiveEdge
    let bufferHealth: AppleBufferHealth?
    if !isCurrentStreamLive(target: target) {
      let current = readVodBufferHealth(from: target, currentTimeSeconds: positionSeconds) ?? latestVodBufferHealth
      latestVodBufferHealth = current
      bufferHealth = current
    } else {
      bufferHealth = nil
    }
    onObservation?(
      .clock(
        positionSeconds: positionSeconds,
        rate: rate,
        durationSeconds: durationSeconds,
        liveEdgeSeconds: liveEdgeSeconds,
        liveSeekableStartSeconds: liveWindow?.startSec,
        timeShiftSupported: target.isLive ? (liveWindow != nil) : nil,
        bufferHealth: bufferHealth
      ),
      serial
    )
  }
}

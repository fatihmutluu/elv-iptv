import Foundation

extension EngineCore {
  func handlePhase(_ phase: BackendPhase) {
    switch phase {
    case .loading:
      break

    case .seeking:
      seeking = true

    case .playing:
      seeking = false
      userPaused = false
      if !framed {
        if audioOnly {
          framed = true
          emit(.firstFrame(attempt: token, atMs: uptimeMs()))
          enterPlaying()
        } else {
          pendingPlaying = true
        }
        return
      }
      enterPlaying()

    case .systemPaused:
      seeking = false
      userPaused = true
      applyGenuinePause()

    case .paused:
      seeking = false
      let isLive = currentRequest?.live ?? true
      if isLive && !userPaused {
        handleUnrequestedLivePause()
      } else {
        applyGenuinePause()
      }

    case .rebuffering, .stalled:
      seeking = false
      beginStallIfPlayed()

    case .ended:
      seeking = false
      pendingPlaying = false
      stalled = false
      active = false
      setScreenOn(false)
      sink?.clearSubtitles()
      let isLive = currentRequest?.live ?? true
      let validVodEof = !isLive
        && (lastDurationSeconds ?? 0) > 0
        && lastPositionSeconds > 0
        && latchedReaderFailure == nil
      if isLive || (!played && !framed && !validVodEof) {
        if let rf = latchedReaderFailure {
          reportFailure(.reader(rf))
          return
        }
        errorReported = true
        let kind = isLive ? "liveEnded" : "vodEndedBeforePlay"
        let redacted = redactUrl(currentRequest?.url ?? "")
        let detail = redacted.isEmpty ? kind : "\(kind) \(redacted)"
        emit(.error(attempt: token, error: MappedError(code: "network", detail: detail)))
      } else {
        emit(.state(attempt: token, state: .ended))
      }
    }
  }

  func enterPlaying() {
    let wasStalled = stalled
    stalled = false
    played = true
    setScreenOn(true)
    if wasStalled {
      let now = uptimeMs()
      emit(.stall(attempt: token, phase: .end, atMs: now))
      emit(.state(attempt: token, state: .playing))
      emitAnchor(rate: 1.0, atMs: now)
    } else {
      emit(.state(attempt: token, state: .playing))
    }
  }

  func handleClock(
    positionSeconds: Double,
    rate: Double,
    durationSeconds: Double?,
    liveEdgeSeconds: Double?
  ) {
    if let d = durationSeconds, d.isFinite, d > 0 { lastDurationSeconds = d }
    if let e = liveEdgeSeconds, e.isFinite, e >= 0 { lastLiveEdgeSeconds = e }
    guard framed, !seeking else { return }
    if positionSeconds.isFinite { lastPositionSeconds = max(0, positionSeconds) }
    guard played, !stalled else { return }
    let now = uptimeMs()
    let elapsed = lastClockUptimeMs.map { now - $0 >= 1_000 } ?? true
    guard forceNextClock || lastClockRate != rate || elapsed else { return }
    forceNextClock = false
    emitAnchor(rate: rate, atMs: now)
  }

  func emitAnchor(rate: Double, atMs: Double) {
    let positionMs = lastPositionSeconds * 1_000.0
    lastAnchoredPositionMs = positionMs
    lastClockRate = rate
    lastClockUptimeMs = atMs
    let anchor = ClockAnchorOut(
      positionMs: positionMs,
      atMs: atMs,
      rate: rate,
      durationMs: lastDurationSeconds.map { $0 * 1_000.0 },
      liveEdgeMs: lastLiveEdgeSeconds.map { $0 * 1_000.0 }
    )
    emit(.clock(attempt: token, anchor: anchor))
  }

  func reportFailure(_ failure: BackendFailure) {
    errorReported = true
    active = false
    pendingPlaying = false
    stalled = false
    seeking = false
    setScreenOn(false)
    sink?.clearSubtitles()
    let live = currentRequest?.live ?? true
    emit(.error(attempt: token, error: mapFailure(failure, url: currentRequest?.url ?? "", live: live, played: played)))
  }

  private func applyGenuinePause() {
    pendingPlaying = false
    stalled = false
    setScreenOn(false)
    emit(.state(attempt: token, state: .paused))
    if framed && !seeking {
      emitAnchor(rate: 0, atMs: uptimeMs())
    }
  }

  private func handleUnrequestedLivePause() {
    if played {
      beginStallIfPlayed()
    } else if !openedReported {
      openedReported = true
      emit(.state(attempt: token, state: .buffering))
    }
    backend.play()
  }

  private func beginStallIfPlayed() {
    guard played, !stalled else { return }
    stalled = true
    let now = uptimeMs()
    emit(.stall(attempt: token, phase: .start, atMs: now))
    setScreenOn(true)
    emit(.state(attempt: token, state: .buffering))
    emitAnchor(rate: 0, atMs: now)
  }
}

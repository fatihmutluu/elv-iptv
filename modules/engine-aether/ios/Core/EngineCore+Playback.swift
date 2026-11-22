import Foundation

extension EngineCore {
  func handlePhase(_ phase: BackendPhase) {
    switch phase {
    case .loading:
      if played && !stalled && !reloading {
        reloading = true
        let now = uptimeMs()
        setScreenOn(!externalPlaybackActive)
        emit(.state(attempt: token, state: .buffering))
        emitAnchor(rate: 0, atMs: now)
      }

    case .seeking:
      seeking = true

    case .playing:
      let wasInterrupted = seeking || reloading
      seeking = false
      reloading = false
      userPaused = false
      if wasInterrupted {
        forceNextClock = true
      }
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
      reloading = false
      userPaused = true
      applyGenuinePause()

    case .paused:
      seeking = false
      reloading = false
      let isLive = currentRequest?.live ?? true
      if isLive && !userPaused && !externalPlaybackActive {
        handleUnrequestedLivePause()
      } else {
        if externalPlaybackActive {
          userPaused = true
        }
        applyGenuinePause()
      }

    case .rebuffering, .stalled:
      seeking = false
      reloading = false
      beginStallIfPlayed()

    case .ended:
      seeking = false
      reloading = false
      pendingPlaying = false
      stalled = false
      externalPlaybackActive = false
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
    setScreenOn(!externalPlaybackActive)
    if wasStalled {
      let now = uptimeMs()
      emit(.stall(attempt: token, phase: .end, atMs: now))
      emit(.state(attempt: token, state: .playing))
      emitAnchor(rate: playbackRate, atMs: now)
    } else {
      emit(.state(attempt: token, state: .playing))
      if lastClockRate == 0 {
        emitAnchor(rate: playbackRate, atMs: uptimeMs())
      }
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
    guard framed, !seeking, !reloading else { return }
    if positionSeconds.isFinite { lastPositionSeconds = max(0, positionSeconds) }
    guard played, !stalled else { return }
    let now = uptimeMs()
    let elapsed = lastClockUptimeMs.map { now - $0 >= 1_000 } ?? true
    guard forceNextClock || lastClockRate != rate || elapsed else { return }
    forceNextClock = false
    emitAnchor(rate: rate, atMs: now)
  }

  func handleDuration(_ durationSeconds: Double) {
    guard durationSeconds.isFinite, durationSeconds > 0 else { return }
    let changed = lastDurationSeconds != durationSeconds
    lastDurationSeconds = durationSeconds
    guard changed, framed, !seeking, !reloading, played, !stalled, let rate = lastClockRate else { return }
    emitAnchor(rate: rate, atMs: uptimeMs())
  }

  func handleProgress(bytesReceived: Int64?, bufferedSeconds: Double?) {
    var bytesAdvanced = false
    if let bytes = bytesReceived, bytes > 0, bytes > lastProgressBytes {
      bytesAdvanced = true
    }
    var bufferAdvanced = false
    if let buffered = bufferedSeconds, buffered.isFinite, buffered >= 0 {
      if buffered > lastProgressBufferedSeconds {
        bufferAdvanced = true
      } else if buffered < lastProgressBufferedSeconds {
        lastProgressBufferedSeconds = buffered
      }
    }

    let waiting = !played || stalled || reloading
    guard waiting else {
      if bytesAdvanced, let bytes = bytesReceived { lastProgressBytes = bytes }
      if bufferAdvanced, let buffered = bufferedSeconds { lastProgressBufferedSeconds = buffered }
      return
    }

    let isCheckpointAdvance = bytesReceived == nil && bufferedSeconds == nil
    guard bytesAdvanced || bufferAdvanced || isCheckpointAdvance else { return }
    let now = uptimeMs()
    if let prev = lastProgressUptimeMs, now - prev < 500.0 {
      return
    }
    lastProgressUptimeMs = now
    if bytesAdvanced, let bytes = bytesReceived { lastProgressBytes = bytes }
    if bufferAdvanced, let buffered = bufferedSeconds { lastProgressBufferedSeconds = buffered }
    emit(
      .progress(
        attempt: token,
        bytesReceived: bytesAdvanced ? bytesReceived.map(Double.init) : nil,
        atMs: now
      )
    )
  }

  func handleMediaInfo(_ incoming: StreamVideoInfo) {
    let trimmedCodec = incoming.codec?.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedHdr = incoming.hdr?.trimmingCharacters(in: .whitespacesAndNewlines)
    let merged = StreamVideoInfo(
      width: incoming.width.flatMap { $0 > 0 ? $0 : nil } ?? lastVideoInfo?.width,
      height: incoming.height.flatMap { $0 > 0 ? $0 : nil } ?? lastVideoInfo?.height,
      fps: incoming.fps.flatMap { ($0.isFinite && $0 > 0) ? $0 : nil } ?? lastVideoInfo?.fps,
      codec: (trimmedCodec?.isEmpty == false ? trimmedCodec : nil) ?? lastVideoInfo?.codec,
      hdr: (trimmedHdr?.isEmpty == false ? trimmedHdr : nil) ?? lastVideoInfo?.hdr,
      droppedFrames: incoming.droppedFrames.flatMap { $0 >= 0 ? $0 : nil } ?? lastVideoInfo?.droppedFrames
    )
    guard !merged.isEmpty, merged != lastVideoInfo else { return }
    lastVideoInfo = merged
    emit(.mediaInfo(attempt: token, info: merged))
  }

  func handleTelemetry(droppedFrames: Int) {
    guard droppedFrames > 0, droppedFrames > lastDroppedFrames else { return }
    lastDroppedFrames = droppedFrames
    emit(.telemetry(attempt: token, droppedFrames: droppedFrames))
  }

  func handleChapters(_ chapters: [ChapterInfoOut]) {
    guard chapters != lastChapters else { return }
    lastChapters = chapters
    emit(.chapters(attempt: token, chapters: chapters))
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
      liveEdgeMs: lastLiveEdgeSeconds.map { $0 * 1_000.0 },
      isLiveTs: (currentPlan?.isLiveTs == true) ? true : nil
    )
    emit(.clock(attempt: token, anchor: anchor))
  }

  func handleExternalPlayback(_ isExternal: Bool) {
    guard isExternal != externalPlaybackActive else { return }
    externalPlaybackActive = isExternal
    emit(.externalPlayback(attempt: token, active: isExternal))
    if isExternal {
      setScreenOn(false)
      if stalled {
        stalled = false
        emit(.stall(attempt: token, phase: .end, atMs: uptimeMs()))
      }
    } else {
      setScreenOn(played && !userPaused && !stalled)
    }
  }

  func reportFailure(_ failure: BackendFailure) {
    errorReported = true
    active = false
    pendingPlaying = false
    stalled = false
    externalPlaybackActive = false
    seeking = false
    reloading = false
    setScreenOn(false)
    sink?.clearSubtitles()
    let live = currentRequest?.live ?? true
    let allowDvFallback = !(currentRequest?.preferHevcOverDolbyVision ?? false) && !dolbyVisionFallbackLatched
    if case let .engine(kind, _, _) = failure, kind == "dolbyVisionRequiresHardware", allowDvFallback {
      dolbyVisionFallbackLatched = true
    }
    emit(
      .error(
        attempt: token,
        error: mapFailure(
          failure,
          url: currentRequest?.url ?? "",
          live: live,
          played: played,
          allowDolbyVisionFallback: allowDvFallback
        )
      )
    )
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
    guard !externalPlaybackActive, played, !stalled else { return }
    stalled = true
    let now = uptimeMs()
    emit(.stall(attempt: token, phase: .start, atMs: now))
    setScreenOn(true)
    emit(.state(attempt: token, state: .buffering))
    emitAnchor(rate: 0, atMs: now)
  }
}

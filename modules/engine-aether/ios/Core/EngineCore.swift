import Foundation

/// Pure state machine enforcing attempt-token adoption, media serial fencing, zap shutter, and screen-on rules.
@MainActor
public final class EngineCore {
  private let backend: PlayerBackend
  private weak var sink: EngineSink?
  private let uptimeMs: () -> Double

  private var token = 0
  private var serial = 0
  private var released = false
  private var currentRequest: LoadRequest?
  private var active = false

  private var openedReported = false
  private var framed = false
  private var audioOnly = false
  private var pendingPlaying = false
  private var played = false
  private var stalled = false
  private var errorReported = false
  private var latchedReaderFailure: ReaderFailure?
  private var forceNextClock = false

  private var lastClockUptimeMs: Double?
  private var lastClockRate: Double?
  private var lastPositionSeconds: Double = 0
  private var lastDurationSeconds: Double?
  private var lastLiveEdgeSeconds: Double?
  private var lastAnchoredPositionMs: Double?

  private var shutterCovered = true
  private var screenOn = false
  private var surfaceAvailable = false

  public init(backend: PlayerBackend, sink: EngineSink, uptimeMs: @escaping () -> Double) {
    self.backend = backend
    self.sink = sink
    self.uptimeMs = uptimeMs
  }

  public func load(_ request: LoadRequest, attempt: Int) {
    guard !released else { return }
    token = attempt
    serial += 1
    backend.stopMedia()

    resetSerialState(startMs: request.startMs)
    currentRequest = request
    setShutter(covered: true)

    guard let plan = planMedia(request) else {
      active = false
      errorReported = true
      setScreenOn(false)
      emit(.state(attempt: token, state: .opening))
      let redacted = redactUrl(request.url)
      let detail = redacted.isEmpty ? "invalidUrl" : "invalidUrl \(redacted)"
      emit(.error(attempt: token, error: MappedError(code: "unsupported-format", detail: detail)))
      return
    }

    active = true
    emit(.state(attempt: token, state: .opening))
    backend.start(plan, options: loadOptions(for: plan, request: request), serial: serial)
  }

  public func retry(_ attempt: Int) {
    guard !released else { return }
    adopt(attempt)
    guard var request = currentRequest else { return }

    let resumeMs: Double?
    if request.live {
      resumeMs = nil
      request.startMs = nil
    } else {
      resumeMs = lastAnchoredPositionMs ?? request.startMs
      request.startMs = resumeMs
    }

    guard let plan = planMedia(request) else { return }
    serial += 1
    backend.stopMedia()
    resetSerialState(startMs: resumeMs)
    active = true
    emit(.state(attempt: token, state: .opening))
    backend.start(plan, options: loadOptions(for: plan, request: request), serial: serial)
  }

  public func play(_ attempt: Int) {
    guard !released else { return }
    adopt(attempt)
    guard active else { return }
    backend.play()
  }

  public func pause(_ attempt: Int) {
    guard !released else { return }
    adopt(attempt)
    guard active else { return }
    backend.pause()
  }

  public func seek(_ attempt: Int, positionMs: Double) {
    guard !released else { return }
    adopt(attempt)
    guard active else { return }
    let clampedMs = max(0, positionMs)
    lastPositionSeconds = clampedMs / 1_000.0
    lastAnchoredPositionMs = clampedMs
    forceNextClock = true
    backend.seek(toSeconds: clampedMs / 1_000.0)
  }

  public func stop(_ attempt: Int) {
    guard !released else { return }
    adopt(attempt)
    serial += 1
    active = false
    currentRequest = nil
    backend.stopMedia()
    setScreenOn(false)
  }

  public func recreate(_ attempt: Int) {
    guard !released else { return }
    adopt(attempt)
    serial += 1
    active = false
    backend.stopMedia()
    do {
      try backend.rebuild()
    } catch {
      let url = currentRequest?.url ?? ""
      let mapped = mapFailure(.rebuildFailed, url: url, live: currentRequest?.live ?? true, played: false)
      setScreenOn(false)
      emit(.error(attempt: token, error: mapped))
    }
  }

  public func release() {
    guard !released else { return }
    released = true
    serial += 1
    active = false
    currentRequest = nil
    backend.stopMedia()
    backend.dispose()
    setScreenOn(false)
  }

  public func observe(_ observation: BackendObservation, serial observedSerial: Int) {
    guard !released, active, observedSerial == serial, !errorReported else { return }

    switch observation {
    case .opened:
      guard !openedReported, !played else { return }
      openedReported = true
      emit(.state(attempt: token, state: .buffering))

    case .ready:
      guard !played else { return }
      emit(.state(attempt: token, state: .ready))

    case .audioOnly:
      audioOnly = true
      if pendingPlaying && !framed {
        framed = true
        pendingPlaying = false
        emit(.firstFrame(attempt: token, atMs: uptimeMs()))
        enterPlaying()
      }

    case .firstFrame:
      guard !framed else { return }
      framed = true
      if !audioOnly {
        setShutter(covered: false)
      }
      emit(.firstFrame(attempt: token, atMs: uptimeMs()))
      if pendingPlaying {
        pendingPlaying = false
        enterPlaying()
      }

    case let .phase(phase):
      handlePhase(phase)

    case let .clock(positionSeconds, rate, durationSeconds, liveEdgeSeconds):
      handleClock(
        positionSeconds: positionSeconds,
        rate: rate,
        durationSeconds: durationSeconds,
        liveEdgeSeconds: liveEdgeSeconds
      )

    case let .readerFault(readerFailure):
      if latchedReaderFailure == nil { latchedReaderFailure = readerFailure }

    case let .failure(failure):
      reportFailure(latchedReaderFailure.map { .reader($0) } ?? failure)
    }
  }

  public func surfaceChanged(available: Bool) {
    guard !released, available != surfaceAvailable else { return }
    surfaceAvailable = available
    if available {
      emit(.surface(attempt: token, change: .created))
    } else {
      emit(.surface(attempt: token, change: .destroyed))
      if active && !errorReported {
        serial += 1
        active = false
        errorReported = true
        backend.stopMedia()
        setScreenOn(false)
        let redacted = redactUrl(currentRequest?.url ?? "")
        let detail = redacted.isEmpty ? "surfaceLost" : "surfaceLost \(redacted)"
        emit(.error(attempt: token, error: MappedError(code: "surface-lost", detail: detail)))
      }
    }
  }

  /// Snapshot of shutter and screen-on state for newly bound surface views.
  public var viewSnapshot: (shutterCovered: Bool, screenOn: Bool) {
    (shutterCovered, screenOn)
  }

  private func emit(_ event: EngineEventOut) {
    sink?.send(event)
  }

  private func adopt(_ attempt: Int) {
    if attempt > token { token = attempt }
  }

  private func resetSerialState(startMs: Double?) {
    openedReported = false
    framed = false
    audioOnly = false
    pendingPlaying = false
    played = false
    stalled = false
    errorReported = false
    latchedReaderFailure = nil
    forceNextClock = false
    lastClockUptimeMs = nil
    lastClockRate = nil
    lastPositionSeconds = max(0, startMs ?? 0) / 1_000.0
    lastDurationSeconds = nil
    lastLiveEdgeSeconds = nil
    lastAnchoredPositionMs = startMs
  }

  private func handlePhase(_ phase: BackendPhase) {
    switch phase {
    case .loading, .seeking:
      break

    case .playing:
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

    case .paused:
      pendingPlaying = false
      stalled = false
      setScreenOn(false)
      emit(.state(attempt: token, state: .paused))
      emitAnchor(rate: 0, atMs: uptimeMs())

    case .rebuffering, .stalled:
      guard played, !stalled else { return }
      stalled = true
      let now = uptimeMs()
      emit(.stall(attempt: token, phase: .start, atMs: now))
      setScreenOn(true)
      emit(.state(attempt: token, state: .buffering))
      emitAnchor(rate: 0, atMs: now)

    case .ended:
      pendingPlaying = false
      stalled = false
      active = false
      setScreenOn(false)
      let isLive = currentRequest?.live ?? true
      if isLive || (!played && !framed) {
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

  private func enterPlaying() {
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

  private func handleClock(
    positionSeconds: Double,
    rate: Double,
    durationSeconds: Double?,
    liveEdgeSeconds: Double?
  ) {
    if positionSeconds.isFinite { lastPositionSeconds = max(0, positionSeconds) }
    if let durationSeconds, durationSeconds.isFinite, durationSeconds > 0 {
      lastDurationSeconds = durationSeconds
    }
    if let liveEdgeSeconds, liveEdgeSeconds.isFinite, liveEdgeSeconds >= 0 {
      lastLiveEdgeSeconds = liveEdgeSeconds
    }

    guard played, !stalled else { return }
    let now = uptimeMs()
    let rateChanged = lastClockRate != rate
    let elapsed = lastClockUptimeMs.map { now - $0 >= 1_000 } ?? true
    guard forceNextClock || rateChanged || elapsed else { return }
    forceNextClock = false
    emitAnchor(rate: rate, atMs: now)
  }

  private func emitAnchor(rate: Double, atMs: Double) {
    let positionMs = lastPositionSeconds * 1_000.0
    let durationMs = lastDurationSeconds.map { $0 * 1_000.0 }
    let liveEdgeMs = lastLiveEdgeSeconds.map { $0 * 1_000.0 }
    lastAnchoredPositionMs = positionMs
    lastClockRate = rate
    lastClockUptimeMs = atMs
    emit(
      .clock(
        attempt: token,
        anchor: ClockAnchorOut(
          positionMs: positionMs,
          atMs: atMs,
          rate: rate,
          durationMs: durationMs,
          liveEdgeMs: liveEdgeMs
        )
      )
    )
  }

  private func reportFailure(_ failure: BackendFailure) {
    errorReported = true
    active = false
    pendingPlaying = false
    stalled = false
    setScreenOn(false)
    let mapped = mapFailure(
      failure,
      url: currentRequest?.url ?? "",
      live: currentRequest?.live ?? true,
      played: played
    )
    emit(.error(attempt: token, error: mapped))
  }

  private func setShutter(covered: Bool) {
    shutterCovered = covered
    sink?.setShutter(covered: covered)
  }

  private func setScreenOn(_ on: Bool) {
    guard on != screenOn else { return }
    screenOn = on
    sink?.setKeepScreenOn(on)
  }
}

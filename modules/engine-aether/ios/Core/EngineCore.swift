import Foundation

/// Pure state machine enforcing attempt-token adoption, media serial fencing, zap shutter, and screen-on rules.
@MainActor
public final class EngineCore {
  let backend: PlayerBackend
  weak var sink: EngineSink?
  let uptimeMs: () -> Double

  var token = 0
  var serial = 0
  var released = false
  var currentRequest: LoadRequest?
  var currentPlan: MediaPlan?
  var active = false
  var trackState = TrackSelectionState()

  var openedReported = false
  var framed = false
  var audioOnly = false
  var pendingPlaying = false
  var played = false
  var stalled = false
  var externalPlaybackActive = false
  var seeking = false
  var reloading = false
  var userPaused = false
  var errorReported = false
  var latchedReaderFailure: ReaderFailure?
  var forceNextClock = false
  var playbackRate: Double = 1.0
  var audioDelaySeconds: Double = 0
  var subtitleDelaySeconds: Double = 0
  var dolbyVisionFallbackLatched = false

  var lastClockUptimeMs: Double?
  var lastClockRate: Double?
  var lastPositionSeconds: Double = 0
  var lastDurationSeconds: Double?
  var lastLiveEdgeSeconds: Double?
  var lastLiveSeekableStartSeconds: Double?
  var lastTimeShiftSupported: Bool?
  var lastAnchoredPositionMs: Double?
  var lastProgressUptimeMs: Double?
  var lastProgressBytes: Int64 = 0
  var lastProgressBufferedSeconds: Double = 0
  var lastVideoInfo: StreamVideoInfo?
  var lastDroppedFrames: Int = 0
  var lastChapters: [ChapterInfoOut]?

  private var shutterCovered = true
  private var screenOn = false
  private var surfaceAvailable = false
  public private(set) var allowDetachedSurface = false
  public private(set) var isSurfaceDetached = false

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
    audioDelaySeconds = 0
    subtitleDelaySeconds = 0
    if currentRequest?.url != request.url && !request.preferHevcOverDolbyVision {
      dolbyVisionFallbackLatched = false
    }
    trackState.onLoad(request)
    sink?.clearSubtitles()
    currentRequest = request
    currentPlan = nil
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

    currentPlan = plan
    active = true
    emit(.state(attempt: token, state: .opening))
    backend.start(plan, options: configuredLoadOptions(for: plan, request: request), serial: serial)
    reapplySessionSyncAndQuality()
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
    trackState.onPrepareReuse()
    sink?.clearSubtitles()
    currentPlan = plan
    active = true
    emit(.state(attempt: token, state: .opening))
    backend.start(plan, options: configuredLoadOptions(for: plan, request: request), serial: serial)
    reapplySessionSyncAndQuality()
  }

  public func play(_ attempt: Int) {
    guard !released else { return }
    adopt(attempt)
    userPaused = false
    guard active else { return }
    backend.play()
  }

  public func pause(_ attempt: Int) {
    guard !released else { return }
    adopt(attempt)
    userPaused = true
    guard active else { return }
    backend.pause()
  }

  public func seek(_ attempt: Int, positionMs: Double) {
    guard !released else { return }
    adopt(attempt)
    guard active, positionMs.isFinite else { return }
    let clampedMs: Double
    if currentRequest?.live == true {
      guard let window = liveSeekableWindow,
            let clampedSec = clampLiveSeek(targetSec: positionMs / 1_000.0, window: window)
      else {
        return
      }
      clampedMs = clampedSec * 1_000.0
    } else {
      var target = max(0, positionMs)
      if let durationSeconds = lastDurationSeconds, durationSeconds.isFinite, durationSeconds > 0 {
        target = min(target, durationSeconds * 1_000.0)
      }
      clampedMs = target
    }
    lastPositionSeconds = clampedMs / 1_000.0
    lastAnchoredPositionMs = clampedMs
    forceNextClock = true
    backend.seek(toSeconds: clampedMs / 1_000.0)
  }

  /// Adjusts VOD playback speed within `[0.25, 4.0]`; ignored for live streams and non-positive or non-finite rates.
  public func setSpeed(_ attempt: Int, rate: Double) {
    guard !released else { return }
    adopt(attempt)
    guard active, currentRequest?.live == false, rate.isFinite, rate > 0 else { return }
    let clamped = min(4.0, max(0.25, rate))
    playbackRate = clamped
    backend.setRate(clamped)
    forceNextClock = true
    if played && !userPaused && !stalled && !seeking && !reloading {
      emitAnchor(rate: playbackRate, atMs: uptimeMs())
    }
  }

  /// Forwards player overlay visibility so the backend can throttle clock emissions while controls are hidden.
  public func setOsdVisible(_ visible: Bool) {
    guard !released else { return }
    backend.setOsdVisible(visible)
  }

  /// Allows local surface detachment (background audio, PiP, AirPlay) without terminating active playback (`#117`).
  public func setAllowDetachedSurface(_ enabled: Bool) {
    guard !released else { return }
    allowDetachedSurface = enabled
  }

  public func stop(_ attempt: Int) {
    guard !released else { return }
    adopt(attempt)
    serial += 1
    active = false
    userPaused = false
    externalPlaybackActive = false
    isSurfaceDetached = false
    playbackRate = 1.0
    audioDelaySeconds = 0
    subtitleDelaySeconds = 0
    currentRequest = nil
    currentPlan = nil
    dolbyVisionFallbackLatched = false
    trackState.onStop()
    sink?.clearSubtitles()
    backend.stopMedia()
    setScreenOn(false)
  }

  @discardableResult
  public func recreate(_ attempt: Int) -> Bool {
    guard !released else { return false }
    adopt(attempt)
    serial += 1
    active = false
    userPaused = false
    externalPlaybackActive = false
    isSurfaceDetached = false
    playbackRate = 1.0
    trackState.onPrepareReuse()
    sink?.clearSubtitles()
    backend.stopMedia()
    do {
      try backend.rebuild()
      return true
    } catch {
      let url = currentRequest?.url ?? ""
      let mapped = mapFailure(.rebuildFailed, url: url, live: currentRequest?.live ?? true, played: false)
      setScreenOn(false)
      emit(.error(attempt: token, error: mapped))
      return false
    }
  }

  public func release() {
    guard !released else { return }
    released = true
    serial += 1
    active = false
    userPaused = false
    externalPlaybackActive = false
    isSurfaceDetached = false
    playbackRate = 1.0
    audioDelaySeconds = 0
    subtitleDelaySeconds = 0
    currentRequest = nil
    currentPlan = nil
    dolbyVisionFallbackLatched = false
    trackState.onStop()
    sink?.clearSubtitles()
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

    case let .clock(
      positionSeconds,
      rate,
      durationSeconds,
      liveEdgeSeconds,
      liveSeekableStartSeconds,
      timeShiftSupported
    ):
      handleClock(
        positionSeconds: positionSeconds,
        rate: rate,
        durationSeconds: durationSeconds,
        liveEdgeSeconds: liveEdgeSeconds,
        liveSeekableStartSeconds: liveSeekableStartSeconds,
        timeShiftSupported: timeShiftSupported
      )

    case let .duration(durationSeconds):
      handleDuration(durationSeconds)

    case let .tracks(observedTracks):
      handleTracksObservation(observedTracks)

    case let .mediaInfo(info):
      handleMediaInfo(info)

    case let .telemetry(droppedFrames):
      handleTelemetry(droppedFrames: droppedFrames)

    case let .chapters(chapters):
      handleChapters(chapters)

    case let .progress(bytesReceived, bufferedSeconds):
      handleProgress(bytesReceived: bytesReceived, bufferedSeconds: bufferedSeconds)

    case let .externalPlayback(active):
      handleExternalPlayback(active)

    case let .readerFault(readerFailure):
      if latchedReaderFailure == nil { latchedReaderFailure = readerFailure }

    case let .failure(failure):
      reportFailure(latchedReaderFailure.map { .reader($0) } ?? failure)
    }
  }

  /// Reports native surface availability transitions, decoupling background/allowed/AirPlay detach from fatal foreground surface loss (`#117`).
  public func surfaceChanged(available: Bool, isBackground: Bool = false) {
    guard !released, available != surfaceAvailable else { return }
    surfaceAvailable = available
    if available {
      isSurfaceDetached = false
      emit(.surface(attempt: token, change: .created))
      if active && played && !userPaused && !stalled && !externalPlaybackActive {
        setScreenOn(true)
      }
    } else {
      sink?.clearSubtitles()
      if isBackground || allowDetachedSurface || externalPlaybackActive {
        isSurfaceDetached = true
        setScreenOn(false)
        emit(.surface(attempt: token, change: .destroyed))
        return
      }
      isSurfaceDetached = false
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

  /// Whether the active stream is live (`true` when idle or live, `false` for VOD).
  public var isLivePlayback: Bool {
    currentRequest?.live ?? true
  }

  /// Active bounded live seekable window (seconds), or `nil` when time-shift is unavailable (`#28`).
  public var liveSeekableWindow: LiveSeekableWindow? {
    guard active,
          !released,
          currentRequest?.live == true,
          currentPlan?.isLiveTs != true,
          lastTimeShiftSupported == true
    else {
      return nil
    }
    return evaluateLiveSeekWindow(startSec: lastLiveSeekableStartSeconds, endSec: lastLiveEdgeSeconds)
  }

  /// Whether bounded live time-shift seeking is currently available on the active live stream (`#28`).
  public var isLiveTimeShiftSupported: Bool {
    liveSeekableWindow != nil
  }

  /// Current adopted attempt token for synchronizing native remote commands with `CommandFence`.
  public var currentToken: Int {
    token
  }

  /// Current `NowPlayingPlaybackState` snapshot for `MPNowPlayingInfoCenter` / `MPRemoteCommandCenter` (`#413`).
  public var nowPlayingPlaybackState: NowPlayingPlaybackState {
    NowPlayingPlaybackState(
      isActive: active && !released && !errorReported,
      isPlaying: active && played && !userPaused && !stalled && !seeking && !reloading,
      isLive: currentRequest?.live ?? true,
      rate: playbackRate,
      positionSeconds: lastPositionSeconds,
      durationSeconds: lastDurationSeconds
    )
  }

  func emit(_ event: EngineEventOut) { sink?.send(event) }

  func adopt(_ attempt: Int) {
    if attempt > token { token = attempt }
  }

  func setShutter(covered: Bool) {
    shutterCovered = covered
    sink?.setShutter(covered: covered)
  }

  func setScreenOn(_ on: Bool) {
    guard on != screenOn else { return }
    screenOn = on
    sink?.setKeepScreenOn(on)
  }

  private func resetSerialState(startMs: Double?) {
    openedReported = false
    framed = false
    audioOnly = false
    pendingPlaying = false
    played = false
    stalled = false
    externalPlaybackActive = false
    seeking = false
    reloading = false
    userPaused = false
    errorReported = false
    latchedReaderFailure = nil
    forceNextClock = false
    playbackRate = 1.0
    lastClockUptimeMs = nil
    lastClockRate = nil
    let validStartMs = startMs.flatMap { $0.isFinite ? max(0, $0) : nil }
    lastPositionSeconds = (validStartMs ?? 0) / 1_000.0
    lastDurationSeconds = nil
    lastLiveEdgeSeconds = nil
    lastLiveSeekableStartSeconds = nil
    lastTimeShiftSupported = nil
    lastAnchoredPositionMs = validStartMs
    lastProgressUptimeMs = nil
    lastProgressBytes = 0
    lastProgressBufferedSeconds = 0
    lastVideoInfo = nil
    lastDroppedFrames = 0
    lastChapters = nil
  }
}

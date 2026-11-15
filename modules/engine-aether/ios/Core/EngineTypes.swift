import Foundation

/// Stream open parameters passed from JavaScript to the Apple playback engine.
public struct LoadRequest: Equatable, Sendable {
  public var url: String
  public var headers: [String: String]
  public var live: Bool
  public var startMs: Double?
  public var softwareAudio: Bool

  public init(
    url: String,
    headers: [String: String] = [:],
    live: Bool = true,
    startMs: Double? = nil,
    softwareAudio: Bool = false
  ) {
    self.url = url
    self.headers = headers
    self.live = live
    self.startMs = startMs
    self.softwareAudio = softwareAudio
  }
}

/// Transport route chosen for a `LoadRequest`.
public enum MediaPlan: Equatable, Sendable {
  case hls(URL, live: Bool)
  case vod(URL, startSeconds: Double?)
  case liveTs(URL)
}

/// Engine-neutral load options mapped onto `AetherEngine.LoadOptions`.
public struct EngineLoadOptions: Equatable, Sendable {
  public var isLive: Bool
  public var httpHeaders: [String: String]
  public var maxConcurrentSourceRequests: Int?
  public var preferSoftwareDecode: Bool
  public var liveStartupGraceSeconds: Double?
  public var liveStartupSingleSegmentMinimumSeconds: Double?
  public var probesize: Int?
  public var maxAnalyzeDurationMicros: Int?

  public init(
    isLive: Bool,
    httpHeaders: [String: String] = [:],
    maxConcurrentSourceRequests: Int? = nil,
    preferSoftwareDecode: Bool = false,
    liveStartupGraceSeconds: Double? = nil,
    liveStartupSingleSegmentMinimumSeconds: Double? = nil,
    probesize: Int? = nil,
    maxAnalyzeDurationMicros: Int? = nil
  ) {
    self.isLive = isLive
    self.httpHeaders = httpHeaders
    self.maxConcurrentSourceRequests = maxConcurrentSourceRequests
    self.preferSoftwareDecode = preferSoftwareDecode
    self.liveStartupGraceSeconds = liveStartupGraceSeconds
    self.liveStartupSingleSegmentMinimumSeconds = liveStartupSingleSegmentMinimumSeconds
    self.probesize = probesize
    self.maxAnalyzeDurationMicros = maxAnalyzeDurationMicros
  }
}

/// Failure reported by our forward-only live MPEG-TS reader.
public enum ReaderFailure: Equatable, Sendable {
  case status(Int)
  case notice
  case transport(domain: String, code: Int)
}

/// Outcome of opening `LiveTsReader` against the live stream endpoint.
public enum ReaderOpen: Equatable, Sendable {
  case media(formatHint: String?)
  case playlist
  case failed(ReaderFailure)
  case superseded
}

/// Failure observed from `AetherEngine` or `LiveTsReader`.
public enum BackendFailure: Equatable, Sendable {
  case engine(kind: String, underlyingDomain: String?, underlyingCode: Int?)
  case liveSourceReset
  case reader(ReaderFailure)
  case rebuildFailed
}

/// Stable `EngineError` payload fields emitted to JavaScript.
public struct MappedError: Equatable, Sendable {
  public let code: String
  public let httpStatus: Int?
  public let detail: String

  public init(code: String, httpStatus: Int? = nil, detail: String) {
    self.code = code
    self.httpStatus = httpStatus
    self.detail = detail
  }
}

/// Transport phase mirrored from `AetherEngine.PlaybackPhase`.
public enum BackendPhase: Equatable, Sendable {
  case loading
  case playing
  case paused
  case seeking
  case rebuffering
  case stalled
  case ended
}

/// Observation sent from `PlayerBackend` into `EngineCore` for a media serial.
public enum BackendObservation: Equatable, Sendable {
  case opened
  case ready
  case phase(BackendPhase)
  case firstFrame
  case audioOnly
  case clock(positionSeconds: Double, rate: Double, durationSeconds: Double?, liveEdgeSeconds: Double?)
  case readerFault(ReaderFailure)
  case failure(BackendFailure)
}

/// Coarse playback state emitted on `onEngineEvent`.
public enum EngineStateOut: String, Equatable, Sendable {
  case opening
  case buffering
  case ready
  case playing
  case paused
  case ended
}

/// Stall transition phase emitted on `onEngineEvent`.
public enum StallPhaseOut: String, Equatable, Sendable {
  case start
  case end
}

/// Native surface lifecycle transition emitted on `onEngineEvent`.
public enum SurfaceChangeOut: String, Equatable, Sendable {
  case created
  case destroyed
}

/// Monotonic clock anchor emitted on `onEngineEvent`.
public struct ClockAnchorOut: Equatable, Sendable {
  public let positionMs: Double
  public let atMs: Double
  public let rate: Double
  public let durationMs: Double?
  public let liveEdgeMs: Double?

  public init(
    positionMs: Double,
    atMs: Double,
    rate: Double,
    durationMs: Double? = nil,
    liveEdgeMs: Double? = nil
  ) {
    self.positionMs = positionMs
    self.atMs = atMs
    self.rate = rate
    self.durationMs = durationMs
    self.liveEdgeMs = liveEdgeMs
  }
}

/// Typed representation of every event emitted to JavaScript on `onEngineEvent`.
public enum EngineEventOut: Equatable, Sendable {
  case state(attempt: Int, state: EngineStateOut)
  case firstFrame(attempt: Int, atMs: Double)
  case clock(attempt: Int, anchor: ClockAnchorOut)
  case stall(attempt: Int, phase: StallPhaseOut, atMs: Double)
  case error(attempt: Int, error: MappedError)
  case surface(attempt: Int, change: SurfaceChangeOut)

  /// Dictionary delivered through Expo Modules `SharedObject.emit`.
  public var payload: [String: Any] {
    switch self {
    case let .state(attempt, state):
      return ["attempt": attempt, "type": "state", "state": state.rawValue]
    case let .firstFrame(attempt, atMs):
      return ["attempt": attempt, "type": "firstFrame", "atMs": atMs]
    case let .clock(attempt, anchor):
      var anchorDict: [String: Any] = [
        "positionMs": anchor.positionMs,
        "atMs": anchor.atMs,
        "rate": anchor.rate,
      ]
      if let durationMs = anchor.durationMs {
        anchorDict["durationMs"] = durationMs
      }
      if let liveEdgeMs = anchor.liveEdgeMs {
        anchorDict["liveEdgeMs"] = liveEdgeMs
      }
      return ["attempt": attempt, "type": "clock", "anchor": anchorDict]
    case let .stall(attempt, phase, atMs):
      return ["attempt": attempt, "type": "stall", "phase": phase.rawValue, "atMs": atMs]
    case let .error(attempt, error):
      var errorDict: [String: Any] = [
        "code": error.code,
        "detail": error.detail,
      ]
      if let httpStatus = error.httpStatus {
        errorDict["httpStatus"] = httpStatus
      }
      return ["attempt": attempt, "type": "error", "error": errorDict]
    case let .surface(attempt, change):
      return ["attempt": attempt, "type": "surface", "change": change.rawValue]
    }
  }
}

/// Native media player seam driven by `EngineCore` on the main actor.
@MainActor
public protocol PlayerBackend: AnyObject {
  func start(_ plan: MediaPlan, options: EngineLoadOptions, serial: Int)
  func stopMedia()
  func play()
  func pause()
  func seek(toSeconds: Double)
  func rebuild() throws
  func dispose()
}

/// Output seam receiving events, zap-shutter updates, and idle-timer requests from `EngineCore`.
@MainActor
public protocol EngineSink: AnyObject {
  func send(_ event: EngineEventOut)
  func setShutter(covered: Bool)
  func setKeepScreenOn(_ on: Bool)
}

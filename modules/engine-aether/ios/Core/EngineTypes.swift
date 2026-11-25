import Foundation

/// Who controls `AVDisplayManager.preferredDisplayCriteria` on tvOS.
public enum DisplayCriteriaOwnerOption: String, Equatable, Sendable {
  case engine
  case avKit
  case host
}

/// External sidecar subtitle track descriptor passed on load or live via `addExternalSubtitle` (`#32`, `#308`).
public struct ExternalSubtitleDescriptor: Equatable, Sendable {
  public var id: String
  public var uri: String
  public var label: String?
  public var language: String?
  public var mimeType: String?
  /// Track-scoped HTTP headers — never inherited from primary stream headers (`#308`).
  public var headers: [String: String]

  public init(
    id: String,
    uri: String,
    label: String? = nil,
    language: String? = nil,
    mimeType: String? = nil,
    headers: [String: String] = [:]
  ) {
    self.id = id
    self.uri = uri
    self.label = label
    self.language = language
    self.mimeType = mimeType
    self.headers = headers
  }
}

/// Stream open parameters passed from JavaScript to the Apple playback engine.
public struct LoadRequest: Equatable, Sendable {
  public var url: String
  public var headers: [String: String]
  public var live: Bool
  public var startMs: Double?
  public var softwareAudio: Bool
  public var preferHevcOverDolbyVision: Bool
  public var filterSdhSubtitles: Bool
  public var allowLegacyTls: Bool
  public var audioTrackId: String?
  public var subtitlePreference: SubtitlePreference
  public var secondarySubtitleTrackId: String?
  public var externalSubtitles: [ExternalSubtitleDescriptor]
  public var subtitleStyle: UserSubtitleStyleOverride?
  public var liveEdgeCushionSeconds: Double?
  public var dnsFamily: DnsFamilyPreference
  public var hostOverride: String?
  public var autoFrameRate: AppleAutoFrameRateMode?
  public var autoDynamicRange: Bool?

  public init(
    url: String,
    headers: [String: String] = [:],
    live: Bool = true,
    startMs: Double? = nil,
    softwareAudio: Bool = false,
    preferHevcOverDolbyVision: Bool = false,
    filterSdhSubtitles: Bool = false,
    allowLegacyTls: Bool = false,
    audioTrackId: String? = nil,
    subtitlePreference: SubtitlePreference = .default,
    secondarySubtitleTrackId: String? = nil,
    externalSubtitles: [ExternalSubtitleDescriptor] = [],
    subtitleStyle: UserSubtitleStyleOverride? = nil,
    liveEdgeCushionSeconds: Double? = nil,
    dnsFamily: DnsFamilyPreference = .system,
    hostOverride: String? = nil,
    autoFrameRate: AppleAutoFrameRateMode? = nil,
    autoDynamicRange: Bool? = nil
  ) {
    self.url = url
    self.headers = headers
    self.live = live
    self.startMs = startMs
    self.softwareAudio = softwareAudio
    self.preferHevcOverDolbyVision = preferHevcOverDolbyVision
    self.filterSdhSubtitles = filterSdhSubtitles
    self.allowLegacyTls = allowLegacyTls
    self.audioTrackId = audioTrackId
    self.subtitlePreference = subtitlePreference
    self.secondarySubtitleTrackId = secondarySubtitleTrackId
    self.externalSubtitles = externalSubtitles
    self.subtitleStyle = subtitleStyle
    self.liveEdgeCushionSeconds = liveEdgeCushionSeconds
    self.dnsFamily = dnsFamily
    self.hostOverride = hostOverride
    self.autoFrameRate = autoFrameRate
    self.autoDynamicRange = autoDynamicRange
  }
}

/// Transport route chosen for a `LoadRequest`.
public enum MediaPlan: Equatable, Sendable {
  case hls(URL, live: Bool)
  case vod(URL, startSeconds: Double?)
  case liveTs(URL)

  public var isLiveTs: Bool {
    if case .liveTs = self { return true }
    return false
  }
}

/// Engine-neutral load options mapped onto `AetherEngine.LoadOptions`.
public struct EngineLoadOptions: Equatable, Sendable {
  public var isLive: Bool
  public var httpHeaders: [String: String]
  public var maxConcurrentSourceRequests: Int?
  public var preferSoftwareDecode: Bool
  public var displayCriteriaOwner: DisplayCriteriaOwnerOption
  public var displaySync: AppleDisplaySyncSettings
  public var liveStartupGraceSeconds: Double?
  public var liveStartupSingleSegmentMinimumSeconds: Double?
  public var liveEdgeCushionSeconds: Double?
  public var probesize: Int?
  public var maxAnalyzeDurationMicros: Int?
  public var generatesBackgroundScrubPreviews: Bool
  public var skipsContainerAttachments: Bool
  public var hostRetriesExhaustedLiveReplay: Bool
  public var audioStreamIndex: Int32?
  public var preferredAudioLanguages: [String]
  public var initialSubtitleTrackId: Int?
  public var preferredSubtitleLanguages: [String]
  public var subtitlesDisabled: Bool
  public var filterSdhSubtitles: Bool
  public var allowLegacyTls: Bool
  public var dnsFamily: DnsFamilyPreference
  public var hostOverride: String?
  public var secondarySubtitleTrackId: String?
  public var externalSubtitles: [ExternalSubtitleDescriptor]

  public init(
    isLive: Bool,
    httpHeaders: [String: String] = [:],
    maxConcurrentSourceRequests: Int? = nil,
    preferSoftwareDecode: Bool = false,
    displayCriteriaOwner: DisplayCriteriaOwnerOption = .engine,
    displaySync: AppleDisplaySyncSettings = .default,
    liveStartupGraceSeconds: Double? = nil,
    liveStartupSingleSegmentMinimumSeconds: Double? = nil,
    liveEdgeCushionSeconds: Double? = nil,
    probesize: Int? = nil,
    maxAnalyzeDurationMicros: Int? = nil,
    generatesBackgroundScrubPreviews: Bool = false,
    skipsContainerAttachments: Bool = true,
    hostRetriesExhaustedLiveReplay: Bool = false,
    audioStreamIndex: Int32? = nil,
    preferredAudioLanguages: [String] = [],
    initialSubtitleTrackId: Int? = nil,
    preferredSubtitleLanguages: [String] = [],
    subtitlesDisabled: Bool = false,
    filterSdhSubtitles: Bool = false,
    allowLegacyTls: Bool = false,
    dnsFamily: DnsFamilyPreference = .system,
    hostOverride: String? = nil,
    secondarySubtitleTrackId: String? = nil,
    externalSubtitles: [ExternalSubtitleDescriptor] = []
  ) {
    self.isLive = isLive
    self.httpHeaders = httpHeaders
    self.maxConcurrentSourceRequests = maxConcurrentSourceRequests
    self.preferSoftwareDecode = preferSoftwareDecode
    self.displayCriteriaOwner = displayCriteriaOwner
    self.displaySync = displaySync
    self.liveStartupGraceSeconds = liveStartupGraceSeconds
    self.liveStartupSingleSegmentMinimumSeconds = liveStartupSingleSegmentMinimumSeconds
    self.liveEdgeCushionSeconds = liveEdgeCushionSeconds
    self.probesize = probesize
    self.maxAnalyzeDurationMicros = maxAnalyzeDurationMicros
    self.generatesBackgroundScrubPreviews = generatesBackgroundScrubPreviews
    self.skipsContainerAttachments = skipsContainerAttachments
    self.hostRetriesExhaustedLiveReplay = hostRetriesExhaustedLiveReplay
    self.audioStreamIndex = audioStreamIndex
    self.preferredAudioLanguages = preferredAudioLanguages
    self.initialSubtitleTrackId = initialSubtitleTrackId
    self.preferredSubtitleLanguages = preferredSubtitleLanguages
    self.subtitlesDisabled = subtitlesDisabled
    self.filterSdhSubtitles = filterSdhSubtitles
    self.allowLegacyTls = allowLegacyTls
    self.dnsFamily = dnsFamily
    self.hostOverride = hostOverride
    self.secondarySubtitleTrackId = secondarySubtitleTrackId
    self.externalSubtitles = externalSubtitles
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
  case systemPaused
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
  case clock(
    positionSeconds: Double,
    rate: Double,
    durationSeconds: Double?,
    liveEdgeSeconds: Double?,
    liveSeekableStartSeconds: Double? = nil,
    timeShiftSupported: Bool? = nil
  )
  case duration(Double)
  case tracks(MediaTracksOut)
  case mediaInfo(StreamVideoInfo)
  case telemetry(droppedFrames: Int)
  case chapters([ChapterInfoOut])
  case progress(bytesReceived: Int64?, bufferedSeconds: Double?)
  case externalPlayback(Bool)
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
  public let liveSeekableStartMs: Double?
  public let timeShiftSupported: Bool?
  public let isLiveTs: Bool?

  public init(
    positionMs: Double,
    atMs: Double,
    rate: Double,
    durationMs: Double? = nil,
    liveEdgeMs: Double? = nil,
    liveSeekableStartMs: Double? = nil,
    timeShiftSupported: Bool? = nil,
    isLiveTs: Bool? = nil
  ) {
    self.positionMs = positionMs
    self.atMs = atMs
    self.rate = rate
    self.durationMs = durationMs
    self.liveEdgeMs = liveEdgeMs
    self.liveSeekableStartMs = liveSeekableStartMs
    self.timeShiftSupported = timeShiftSupported
    self.isLiveTs = isLiveTs
  }
}

/// One container chapter marker emitted on `onEngineEvent` (`#118`).
public struct ChapterInfoOut: Equatable, Sendable {
  public let id: String
  public let title: String?
  public let startMs: Double
  public let endMs: Double?

  public init(id: String, title: String? = nil, startMs: Double, endMs: Double? = nil) {
    self.id = id
    self.title = title
    self.startMs = startMs
    self.endMs = endMs
  }

  public func toDictionary() -> [String: Any] {
    var out: [String: Any] = ["id": id, "startMs": startMs]
    if let title, !title.isEmpty { out["title"] = title }
    if let endMs { out["endMs"] = endMs }
    return out
  }
}

/// Decoded video stream metadata emitted on `onEngineEvent` (`#58`, `#160`).
public struct StreamVideoInfo: Equatable, Sendable {
  public let width: Int?
  public let height: Int?
  public let fps: Double?
  public let codec: String?
  public let hdr: String?
  public let droppedFrames: Int?

  public init(
    width: Int? = nil,
    height: Int? = nil,
    fps: Double? = nil,
    codec: String? = nil,
    hdr: String? = nil,
    droppedFrames: Int? = nil
  ) {
    self.width = width
    self.height = height
    self.fps = fps
    self.codec = codec
    self.hdr = hdr
    self.droppedFrames = droppedFrames
  }

  public var isEmpty: Bool {
    width == nil && height == nil && fps == nil && codec == nil && hdr == nil && droppedFrames == nil
  }

  public func toDictionary() -> [String: Any] {
    var out: [String: Any] = [:]
    if let width { out["width"] = width }
    if let height { out["height"] = height }
    if let fps { out["fps"] = fps }
    if let codec { out["codec"] = codec }
    if let hdr { out["hdr"] = hdr }
    if let droppedFrames { out["droppedFrames"] = droppedFrames }
    return out
  }
}

/// Typed representation of every event emitted to JavaScript on `onEngineEvent`.
public enum EngineEventOut: Equatable, Sendable {
  case state(attempt: Int, state: EngineStateOut)
  case firstFrame(attempt: Int, atMs: Double)
  case clock(attempt: Int, anchor: ClockAnchorOut)
  case stall(attempt: Int, phase: StallPhaseOut, atMs: Double)
  case progress(attempt: Int, bytesReceived: Double?, atMs: Double)
  case tracks(attempt: Int, tracks: MediaTracksOut)
  case mediaInfo(attempt: Int, info: StreamVideoInfo)
  case telemetry(attempt: Int, droppedFrames: Int)
  case chapters(attempt: Int, chapters: [ChapterInfoOut])
  case externalPlayback(attempt: Int, active: Bool)
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
      if let liveSeekableStartMs = anchor.liveSeekableStartMs {
        anchorDict["liveSeekableStartMs"] = liveSeekableStartMs
      }
      if let timeShiftSupported = anchor.timeShiftSupported {
        anchorDict["timeShiftSupported"] = timeShiftSupported
      }
      if let isLiveTs = anchor.isLiveTs {
        anchorDict["isLiveTs"] = isLiveTs
      }
      return ["attempt": attempt, "type": "clock", "anchor": anchorDict]
    case let .stall(attempt, phase, atMs):
      return ["attempt": attempt, "type": "stall", "phase": phase.rawValue, "atMs": atMs]
    case let .progress(attempt, bytesReceived, atMs):
      var out: [String: Any] = ["attempt": attempt, "type": "progress", "atMs": atMs]
      if let bytesReceived {
        out["bytesReceived"] = bytesReceived
      }
      return out
    case let .tracks(attempt, tracks):
      return ["attempt": attempt, "type": "tracks", "tracks": tracks.toDictionary()]
    case let .mediaInfo(attempt, info):
      return ["attempt": attempt, "type": "mediaInfo", "info": info.toDictionary()]
    case let .telemetry(attempt, droppedFrames):
      return ["attempt": attempt, "type": "telemetry", "droppedFrames": droppedFrames]
    case let .chapters(attempt, chapters):
      return ["attempt": attempt, "type": "chapters", "chapters": chapters.map { $0.toDictionary() }]
    case let .externalPlayback(attempt, active):
      return ["attempt": attempt, "type": "externalPlayback", "active": active]
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
  func setRate(_ rate: Double)
  func setOsdVisible(_ visible: Bool)
  func selectAudioTrack(_ streamId: Int)
  func selectSubtitleTrack(_ streamId: Int?)
  func selectExternalSubtitleTrack(_ id: String?)
  func selectSecondarySubtitleTrack(_ id: String?)
  func addExternalSubtitle(_ track: ExternalSubtitleDescriptor)
  func setAudioDelay(_ seconds: Double)
  func setSubtitleDelay(_ seconds: Double)
  func selectVideoQuality(_ cap: VideoQualityCap?)
  func rebuild() throws
  func dispose()
}

/// Output seam receiving events, zap-shutter updates, subtitle clears, and idle-timer requests from `EngineCore`.
@MainActor
public protocol EngineSink: AnyObject {
  func send(_ event: EngineEventOut)
  func setShutter(covered: Bool)
  func setKeepScreenOn(_ on: Bool)
  func clearSubtitles()
}

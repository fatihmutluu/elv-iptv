import Foundation

/// Initial or reloaded subtitle selection preference passed from JavaScript.
public enum SubtitlePreference: Equatable, Sendable {
  case `default`
  case off
  case selected(String)
}

/// One selectable audio or subtitle stream advertised on `onEngineEvent`.
public struct TrackInfoOut: Equatable, Sendable {
  public var id: String
  public var language: String?
  public var label: String?
  public var codec: String?
  public var channels: Int?
  public var forced: Bool
  public var isDefault: Bool

  public init(
    id: String,
    language: String? = nil,
    label: String? = nil,
    codec: String? = nil,
    channels: Int? = nil,
    forced: Bool = false,
    isDefault: Bool = false
  ) {
    self.id = id
    self.language = language
    self.label = label
    self.codec = codec
    self.channels = channels
    self.forced = forced
    self.isDefault = isDefault
  }

  public func toDictionary() -> [String: Any] {
    var out: [String: Any] = ["id": id]
    if let language { out["language"] = language }
    if let label { out["label"] = label }
    if let codec { out["codec"] = codec }
    if let channels { out["channels"] = channels }
    if forced { out["forced"] = true }
    if isDefault { out["isDefault"] = true }
    return out
  }
}

/// Available audio and subtitle tracks and active selection IDs emitted on `onEngineEvent`.
public struct MediaTracksOut: Equatable, Sendable {
  public static let empty = MediaTracksOut(audio: [], subtitles: [], selectedAudioId: nil, selectedSubtitleId: nil)

  public var audio: [TrackInfoOut]
  public var subtitles: [TrackInfoOut]
  public var selectedAudioId: String?
  public var selectedSubtitleId: String?

  public init(audio: [TrackInfoOut], subtitles: [TrackInfoOut], selectedAudioId: String?, selectedSubtitleId: String?) {
    self.audio = audio
    self.subtitles = subtitles
    self.selectedAudioId = selectedAudioId
    self.selectedSubtitleId = selectedSubtitleId
  }

  public func toDictionary() -> [String: Any] {
    [
      "audio": audio.map { $0.toDictionary() },
      "subtitles": subtitles.map { $0.toDictionary() },
      "selectedAudioId": selectedAudioId ?? NSNull(),
      "selectedSubtitleId": selectedSubtitleId ?? NSNull(),
    ]
  }
}

/// Pure track-preference state machine reconciling IDs and `(language, label)` fallbacks at most once per load.
public struct TrackSelectionState: Equatable, Sendable {
  public struct Choice: Equatable, Sendable {
    public var id: String
    public var language: String?
    public var label: String?
  }

  public enum SubChoice: Equatable, Sendable {
    case `default`
    case off
    case selected(Choice)
  }

  public private(set) var audioChoice: Choice?
  public private(set) var subtitleChoice: SubChoice = .default
  public private(set) var latestTracks: MediaTracksOut?
  public private(set) var lastEmitted: MediaTracksOut?
  private var audioReapplied = false
  private var subtitleReapplied = false
  private var subtitleOffApplied = false

  public init() {}

  public mutating func onLoad(_ request: LoadRequest) {
    latestTracks = nil
    lastEmitted = nil
    audioReapplied = false
    subtitleReapplied = false
    subtitleOffApplied = false

    if let rawAudio = request.audioTrackId, let streamId = parseAudioTrackStreamId(rawAudio) {
      let wantedAudio = formatAudioTrackId(streamId)
      if let current = audioChoice, current.id == wantedAudio {
        audioChoice = current
      } else {
        audioChoice = Choice(id: wantedAudio, language: nil, label: nil)
      }
    } else {
      audioChoice = nil
    }

    switch request.subtitlePreference {
    case .default:
      subtitleChoice = .default
    case .off:
      subtitleChoice = .off
    case let .selected(rawSub):
      if let streamId = parseSubtitleTrackStreamId(rawSub) {
        let wantedSub = formatSubtitleTrackId(streamId)
        if case let .selected(current) = subtitleChoice, current.id == wantedSub {
          subtitleChoice = .selected(current)
        } else {
          subtitleChoice = .selected(Choice(id: wantedSub, language: nil, label: nil))
        }
      } else {
        subtitleChoice = .default
      }
    }
  }

  public mutating func onPrepareReuse() {
    latestTracks = nil
    lastEmitted = nil
    audioReapplied = false
    subtitleReapplied = false
    subtitleOffApplied = false
  }

  public mutating func onStop() {
    audioChoice = nil
    subtitleChoice = .default
    latestTracks = nil
    lastEmitted = nil
    audioReapplied = false
    subtitleReapplied = false
    subtitleOffApplied = false
  }

  public func apply(to options: inout EngineLoadOptions) {
    if let audioChoice {
      options.audioStreamIndex = parseAudioTrackStreamId(audioChoice.id).flatMap { Int32(exactly: $0) }
      options.preferredAudioLanguages = audioChoice.language.map { [$0] } ?? []
    }
    switch subtitleChoice {
    case .default:
      options.initialSubtitleTrackId = nil
      options.preferredSubtitleLanguages = []
      options.subtitlesDisabled = false
    case .off:
      options.initialSubtitleTrackId = nil
      options.preferredSubtitleLanguages = []
      options.subtitlesDisabled = true
    case let .selected(choice):
      options.initialSubtitleTrackId = parseSubtitleTrackStreamId(choice.id)
      options.preferredSubtitleLanguages = choice.language.map { [$0] } ?? []
      options.subtitlesDisabled = false
    }
  }

  public mutating func selectAudio(_ id: String) -> Int? {
    guard let streamId = parseAudioTrackStreamId(id) else { return nil }
    let canonicalId = formatAudioTrackId(streamId)
    let matched = latestTracks?.audio.first { $0.id == canonicalId }
    audioChoice = Choice(id: canonicalId, language: matched?.language, label: matched?.label)
    audioReapplied = true
    return streamId
  }

  public mutating func selectSubtitle(_ id: String?) -> (streamId: Int?, clear: Bool, immediateTracks: MediaTracksOut?) {
    guard let id else {
      subtitleChoice = .off
      subtitleReapplied = false
      subtitleOffApplied = true
      guard var updated = latestTracks else {
        return (nil, true, nil)
      }
      updated.selectedSubtitleId = nil
      latestTracks = updated
      if updated != lastEmitted {
        lastEmitted = updated
        return (nil, true, updated)
      }
      return (nil, true, nil)
    }

    guard let streamId = parseSubtitleTrackStreamId(id) else {
      return (nil, false, nil)
    }
    let canonicalId = formatSubtitleTrackId(streamId)
    let matched = latestTracks?.subtitles.first { $0.id == canonicalId }
    subtitleChoice = .selected(Choice(id: canonicalId, language: matched?.language, label: matched?.label))
    subtitleReapplied = true
    subtitleOffApplied = false
    return (streamId, false, nil)
  }

  public mutating func reconcile(
    observed: MediaTracksOut
  ) -> (toEmit: MediaTracksOut?, selectAudioStreamId: Int?, selectSubtitleStreamId: Int?, clearSubtitle: Bool) {
    var effective = observed
    var selectAudioStreamId: Int?
    var selectSubtitleStreamId: Int?
    var clearSubtitle = false

    if let wantedAudio = audioChoice, let resolved = Self.resolve(in: observed.audio, wanted: wantedAudio) {
      audioChoice = Choice(id: resolved.id, language: resolved.language, label: resolved.label)
      if observed.selectedAudioId == resolved.id {
        effective.selectedAudioId = resolved.id
      } else if !audioReapplied {
        audioReapplied = true
        selectAudioStreamId = parseAudioTrackStreamId(resolved.id)
        effective.selectedAudioId = resolved.id
      }
    }

    switch subtitleChoice {
    case .default:
      break
    case .off:
      if observed.selectedSubtitleId != nil {
        if !subtitleOffApplied {
          subtitleOffApplied = true
          clearSubtitle = true
        }
      } else {
        subtitleOffApplied = false
      }
      effective.selectedSubtitleId = nil
    case let .selected(wantedSub):
      if let resolved = Self.resolve(in: observed.subtitles, wanted: wantedSub) {
        subtitleChoice = .selected(Choice(id: resolved.id, language: resolved.language, label: resolved.label))
        if observed.selectedSubtitleId == resolved.id {
          effective.selectedSubtitleId = resolved.id
        } else if !subtitleReapplied {
          subtitleReapplied = true
          selectSubtitleStreamId = parseSubtitleTrackStreamId(resolved.id)
          effective.selectedSubtitleId = resolved.id
        }
      }
    }

    latestTracks = effective
    guard effective != lastEmitted else {
      return (nil, selectAudioStreamId, selectSubtitleStreamId, clearSubtitle)
    }
    lastEmitted = effective
    return (effective, selectAudioStreamId, selectSubtitleStreamId, clearSubtitle)
  }

  private static func resolve(in candidates: [TrackInfoOut], wanted: Choice) -> TrackInfoOut? {
    let exact = candidates.first { $0.id == wanted.id }
    if let exact, isLanguageCompatible(exact, wanted: wanted), isLabelCompatible(exact, wanted: wanted) {
      return exact
    }
    if let lang = wanted.language, let label = wanted.label,
       let both = candidates.first(where: { sameTrackLanguage($0.language, lang) && $0.label == label })
    {
      return both
    }
    if let lang = wanted.language,
       let byLang = candidates.first(where: { sameTrackLanguage($0.language, lang) })
    {
      return byLang
    }
    if let label = wanted.label, let byLabel = candidates.first(where: { $0.label == label }) {
      return byLabel
    }
    return exact
  }

  private static func isLanguageCompatible(_ candidate: TrackInfoOut, wanted: Choice) -> Bool {
    guard let wantedLang = wanted.language else { return true }
    return sameTrackLanguage(candidate.language, wantedLang)
  }

  private static func isLabelCompatible(_ candidate: TrackInfoOut, wanted: Choice) -> Bool {
    guard let wantedLabel = wanted.label, let candLabel = candidate.label else { return true }
    return candLabel == wantedLabel
  }
}

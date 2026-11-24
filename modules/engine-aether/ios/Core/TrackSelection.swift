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
  public var external: Bool

  public init(
    id: String,
    language: String? = nil,
    label: String? = nil,
    codec: String? = nil,
    channels: Int? = nil,
    forced: Bool = false,
    isDefault: Bool = false,
    external: Bool = false
  ) {
    self.id = id
    self.language = language
    self.label = label
    self.codec = codec
    self.channels = channels
    self.forced = forced
    self.isDefault = isDefault
    self.external = external
  }

  public func toDictionary() -> [String: Any] {
    var out: [String: Any] = ["id": id]
    if let language { out["language"] = language }
    if let label { out["label"] = label }
    if let codec { out["codec"] = codec }
    if let channels { out["channels"] = channels }
    if forced { out["forced"] = true }
    if isDefault { out["isDefault"] = true }
    if external { out["external"] = true }
    return out
  }
}

/// Available audio, subtitle, and adaptive video tracks and active selection IDs emitted on `onEngineEvent`.
public struct MediaTracksOut: Equatable, Sendable {
  public static let empty = MediaTracksOut(audio: [], subtitles: [], selectedAudioId: nil, selectedSubtitleId: nil)

  public var audio: [TrackInfoOut]
  public var subtitles: [TrackInfoOut]
  public var selectedAudioId: String?
  public var selectedSubtitleId: String?
  public var selectedSecondarySubtitleId: String?
  public var videoQualities: [VideoQualityOptionOut]
  public var selectedVideoQualityId: String?

  public init(
    audio: [TrackInfoOut],
    subtitles: [TrackInfoOut],
    selectedAudioId: String?,
    selectedSubtitleId: String?,
    selectedSecondarySubtitleId: String? = nil,
    videoQualities: [VideoQualityOptionOut] = [],
    selectedVideoQualityId: String? = nil
  ) {
    self.audio = audio
    self.subtitles = subtitles
    self.selectedAudioId = selectedAudioId
    self.selectedSubtitleId = selectedSubtitleId
    self.selectedSecondarySubtitleId = selectedSecondarySubtitleId
    self.videoQualities = videoQualities
    self.selectedVideoQualityId = selectedVideoQualityId
  }

  public func toDictionary() -> [String: Any] {
    var out: [String: Any] = [
      "audio": audio.map { $0.toDictionary() },
      "subtitles": subtitles.map { $0.toDictionary() },
      "selectedAudioId": selectedAudioId ?? NSNull(),
      "selectedSubtitleId": selectedSubtitleId ?? NSNull(),
      "selectedSecondarySubtitleId": selectedSecondarySubtitleId ?? NSNull(),
    ]
    if !videoQualities.isEmpty {
      out["videoQualities"] = videoQualities.map { $0.toDictionary() }
      out["selectedVideoQualityId"] = selectedVideoQualityId ?? NSNull()
    }
    return out
  }
}

/// Parsed subtitle track identifier: either an embedded `"s:<streamId>"` or a user-attached external ID (`#32`, `#402`).
public enum ParsedSubtitleId: Equatable, Sendable {
  case embedded(canonicalId: String, streamId: Int)
  case external(id: String)

  public var canonicalId: String {
    switch self {
    case let .embedded(canonicalId, _): return canonicalId
    case let .external(id): return id
    }
  }

  public var streamId: Int? {
    if case let .embedded(_, streamId) = self { return streamId }
    return nil
  }

  public var externalId: String? {
    if case let .external(id) = self { return id }
    return nil
  }
}

/// Parses an embedded (`"s:<nonNegativeInt32>"`) or external subtitle ID while rejecting `"a:*"`, malformed `"s:*"`, or control chars.
public func parseAnySubtitleTrackId(_ raw: String) -> ParsedSubtitleId? {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty, trimmed.count <= 256 else { return nil }
  for scalar in trimmed.unicodeScalars {
    if scalar.value <= 0x1F || scalar.value == 0x7F { return nil }
  }
  if trimmed.hasPrefix("a:") { return nil }
  if trimmed.hasPrefix("s:") {
    guard let streamId = parseSubtitleTrackStreamId(trimmed) else { return nil }
    return .embedded(canonicalId: formatSubtitleTrackId(streamId), streamId: streamId)
  }
  return .external(id: trimmed)
}

/// Outcome of a primary subtitle selection command.
public struct SubtitleSelectionOutcome: Equatable, Sendable {
  public let streamId: Int?
  public let externalId: String?
  public let clear: Bool
  public let clearedSecondary: Bool
  public let immediateTracks: MediaTracksOut?
}

/// Outcome of a secondary subtitle selection command (`#402`).
public struct SecondarySubtitleSelectionOutcome: Equatable, Sendable {
  public let valid: Bool
  public let secondaryId: String?
  public let immediateTracks: MediaTracksOut?
}

/// Outcome of reconciling an observed `MediaTracksOut` snapshot against persisted track preferences.
public struct TrackReconcileOutcome: Equatable, Sendable {
  public let toEmit: MediaTracksOut?
  public let selectAudioStreamId: Int?
  public let selectSubtitleStreamId: Int?
  public let selectExternalSubtitleId: String?
  public let clearSubtitle: Bool
  public let selectSecondarySubtitleId: String?
  public let clearSecondarySubtitle: Bool
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
  public private(set) var secondarySubtitleChoice: Choice?
  public private(set) var videoQualityId: String?
  public private(set) var latestTracks: MediaTracksOut?
  public private(set) var lastEmitted: MediaTracksOut?
  private var audioReapplied = false
  private var subtitleReapplied = false
  private var subtitleOffApplied = false
  private var secondarySubtitleReapplied = false

  public init() {}

  private var primaryChoiceId: String? {
    if case let .selected(choice) = subtitleChoice {
      return choice.id
    }
    return nil
  }

  /// Returns `true` when `primaryId` and `secondaryId` cannot coexist on Apple `AetherEngine`:
  /// either they refer to the same track, or both are embedded `"s:*"` tracks (since `AetherEngine`
  /// natively decodes one embedded subtitle stream at a time; external sidecars pair freely with
  /// any primary, and embedded secondary tracks pair freely when primary is external or Off, `#402`).
  private static func isIncompatibleSubtitlePair(primaryId: String?, secondaryId: String) -> Bool {
    guard let primaryId else { return false }
    if primaryId == secondaryId { return true }
    return parseSubtitleTrackStreamId(primaryId) != nil && parseSubtitleTrackStreamId(secondaryId) != nil
  }

  public mutating func onLoad(_ request: LoadRequest) {
    latestTracks = nil
    lastEmitted = nil
    videoQualityId = nil
    audioReapplied = false
    subtitleReapplied = false
    subtitleOffApplied = false
    secondarySubtitleReapplied = false

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
      if let parsed = parseAnySubtitleTrackId(rawSub) {
        let wantedSub = parsed.canonicalId
        if case let .selected(current) = subtitleChoice, current.id == wantedSub {
          subtitleChoice = .selected(current)
        } else {
          subtitleChoice = .selected(Choice(id: wantedSub, language: nil, label: nil))
        }
      } else {
        subtitleChoice = .default
      }
    }

    if let rawSecondary = request.secondarySubtitleTrackId,
       let parsed = parseAnySubtitleTrackId(rawSecondary),
       !Self.isIncompatibleSubtitlePair(primaryId: primaryChoiceId, secondaryId: parsed.canonicalId)
    {
      let wantedSec = parsed.canonicalId
      if let current = secondarySubtitleChoice, current.id == wantedSec {
        secondarySubtitleChoice = current
      } else {
        secondarySubtitleChoice = Choice(id: wantedSec, language: nil, label: nil)
      }
    } else {
      secondarySubtitleChoice = nil
    }
  }

  public mutating func onPrepareReuse() {
    latestTracks = nil
    lastEmitted = nil
    audioReapplied = false
    subtitleReapplied = false
    subtitleOffApplied = false
    secondarySubtitleReapplied = false
  }

  public mutating func onStop() {
    audioChoice = nil
    subtitleChoice = .default
    secondarySubtitleChoice = nil
    videoQualityId = nil
    latestTracks = nil
    lastEmitted = nil
    audioReapplied = false
    subtitleReapplied = false
    subtitleOffApplied = false
    secondarySubtitleReapplied = false
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
      if let streamId = parseSubtitleTrackStreamId(choice.id) {
        options.initialSubtitleTrackId = streamId
        options.preferredSubtitleLanguages = choice.language.map { [$0] } ?? []
        options.subtitlesDisabled = false
      } else {
        // Primary is an external subtitle track: keep embedded auto-selection disabled.
        options.initialSubtitleTrackId = nil
        options.preferredSubtitleLanguages = []
        options.subtitlesDisabled = true
      }
    }
    options.secondarySubtitleTrackId = secondarySubtitleChoice?.id
  }

  public mutating func selectAudio(_ id: String) -> Int? {
    guard let streamId = parseAudioTrackStreamId(id) else { return nil }
    let canonicalId = formatAudioTrackId(streamId)
    let matched = latestTracks?.audio.first { $0.id == canonicalId }
    audioChoice = Choice(id: canonicalId, language: matched?.language, label: matched?.label)
    audioReapplied = true
    return streamId
  }

  public mutating func selectSubtitle(_ id: String?) -> SubtitleSelectionOutcome {
    guard let id else {
      subtitleChoice = .off
      subtitleReapplied = false
      subtitleOffApplied = true
      guard var updated = latestTracks else {
        return SubtitleSelectionOutcome(streamId: nil, externalId: nil, clear: true, clearedSecondary: false, immediateTracks: nil)
      }
      updated.selectedSubtitleId = nil
      latestTracks = updated
      if updated != lastEmitted {
        lastEmitted = updated
        return SubtitleSelectionOutcome(streamId: nil, externalId: nil, clear: true, clearedSecondary: false, immediateTracks: updated)
      }
      return SubtitleSelectionOutcome(streamId: nil, externalId: nil, clear: true, clearedSecondary: false, immediateTracks: nil)
    }

    guard let parsed = parseAnySubtitleTrackId(id) else {
      return SubtitleSelectionOutcome(streamId: nil, externalId: nil, clear: false, clearedSecondary: false, immediateTracks: nil)
    }
    let canonicalId = parsed.canonicalId
    let matched = latestTracks?.subtitles.first { $0.id == canonicalId }
    subtitleChoice = .selected(Choice(id: canonicalId, language: matched?.language, label: matched?.label))
    subtitleReapplied = true
    subtitleOffApplied = false

    // Enforce secondary != primary and single embedded subtitle decoder (`#402`).
    var clearedSecondary = false
    let currentSecondaryId = secondarySubtitleChoice?.id ?? latestTracks?.selectedSecondarySubtitleId
    if let currentSecondaryId,
       Self.isIncompatibleSubtitlePair(primaryId: canonicalId, secondaryId: currentSecondaryId)
    {
      secondarySubtitleChoice = nil
      secondarySubtitleReapplied = true
      clearedSecondary = true
    }

    var immediate: MediaTracksOut?
    if parsed.externalId != nil || clearedSecondary, var updated = latestTracks {
      if parsed.externalId != nil {
        updated.selectedSubtitleId = canonicalId
      }
      if clearedSecondary {
        updated.selectedSecondarySubtitleId = nil
      }
      latestTracks = updated
      if updated != lastEmitted {
        lastEmitted = updated
        immediate = updated
      }
    }

    return SubtitleSelectionOutcome(
      streamId: parsed.streamId,
      externalId: parsed.externalId,
      clear: false,
      clearedSecondary: clearedSecondary,
      immediateTracks: immediate
    )
  }

  /// Selects a secondary subtitle track, or disables secondary subtitles when `nil`, enforcing `secondary != primary` (`#402`).
  public mutating func selectSecondarySubtitle(_ id: String?) -> SecondarySubtitleSelectionOutcome {
    guard let id else {
      secondarySubtitleChoice = nil
      secondarySubtitleReapplied = true
      guard var updated = latestTracks else {
        return SecondarySubtitleSelectionOutcome(valid: true, secondaryId: nil, immediateTracks: nil)
      }
      updated.selectedSecondarySubtitleId = nil
      latestTracks = updated
      if updated != lastEmitted {
        lastEmitted = updated
        return SecondarySubtitleSelectionOutcome(valid: true, secondaryId: nil, immediateTracks: updated)
      }
      return SecondarySubtitleSelectionOutcome(valid: true, secondaryId: nil, immediateTracks: nil)
    }

    guard let parsed = parseAnySubtitleTrackId(id) else {
      return SecondarySubtitleSelectionOutcome(valid: false, secondaryId: nil, immediateTracks: nil)
    }
    let canonicalId = parsed.canonicalId
    let activePrimaryId: String? =
      (subtitleChoice == .off) ? nil : (latestTracks?.selectedSubtitleId ?? primaryChoiceId)
    guard !Self.isIncompatibleSubtitlePair(primaryId: activePrimaryId, secondaryId: canonicalId) else {
      return SecondarySubtitleSelectionOutcome(valid: false, secondaryId: nil, immediateTracks: nil)
    }

    let matched = latestTracks?.subtitles.first { $0.id == canonicalId }
    secondarySubtitleChoice = Choice(id: canonicalId, language: matched?.language, label: matched?.label)
    secondarySubtitleReapplied = true

    guard var updated = latestTracks else {
      return SecondarySubtitleSelectionOutcome(valid: true, secondaryId: canonicalId, immediateTracks: nil)
    }
    updated.selectedSecondarySubtitleId = canonicalId
    latestTracks = updated
    if updated != lastEmitted {
      lastEmitted = updated
      return SecondarySubtitleSelectionOutcome(valid: true, secondaryId: canonicalId, immediateTracks: updated)
    }
    return SecondarySubtitleSelectionOutcome(valid: true, secondaryId: canonicalId, immediateTracks: nil)
  }

  public mutating func selectVideoQuality(
    _ id: String?
  ) -> (valid: Bool, cap: VideoQualityCap?, immediateTracks: MediaTracksOut?) {
    guard let id else {
      videoQualityId = nil
      guard var updated = latestTracks, !updated.videoQualities.isEmpty else {
        return (true, nil, nil)
      }
      updated.selectedVideoQualityId = nil
      latestTracks = updated
      if updated != lastEmitted {
        lastEmitted = updated
        return (true, nil, updated)
      }
      return (true, nil, nil)
    }

    guard let cap = VideoQualityPolicy.resolveCap(for: id) else {
      return (false, nil, nil)
    }
    videoQualityId = cap.id
    guard var updated = latestTracks, !updated.videoQualities.isEmpty else {
      return (true, cap, nil)
    }
    updated.selectedVideoQualityId = cap.id
    latestTracks = updated
    if updated != lastEmitted {
      lastEmitted = updated
      return (true, cap, updated)
    }
    return (true, cap, nil)
  }

  public mutating func reconcile(observed: MediaTracksOut) -> TrackReconcileOutcome {
    var effective = observed
    var selectAudioStreamId: Int?
    var selectSubtitleStreamId: Int?
    var selectExternalSubtitleId: String?
    var clearSubtitle = false
    var selectSecondarySubtitleId: String?
    var clearSecondarySubtitle = false

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
          if let streamId = parseSubtitleTrackStreamId(resolved.id) {
            selectSubtitleStreamId = streamId
          } else {
            selectExternalSubtitleId = resolved.id
          }
          effective.selectedSubtitleId = resolved.id
        }
      }
    }

    // Reconcile secondary subtitle while enforcing `secondary != primary` and single embedded decoder (`#402`).
    if let wantedSecondary = secondarySubtitleChoice,
       let resolvedSec = Self.resolve(in: observed.subtitles, wanted: wantedSecondary)
    {
      if Self.isIncompatibleSubtitlePair(primaryId: effective.selectedSubtitleId, secondaryId: resolvedSec.id) {
        secondarySubtitleChoice = nil
        effective.selectedSecondarySubtitleId = nil
        clearSecondarySubtitle = true
      } else {
        secondarySubtitleChoice = Choice(id: resolvedSec.id, language: resolvedSec.language, label: resolvedSec.label)
        effective.selectedSecondarySubtitleId = resolvedSec.id
        if observed.selectedSecondarySubtitleId != resolvedSec.id && !secondarySubtitleReapplied {
          secondarySubtitleReapplied = true
          selectSecondarySubtitleId = resolvedSec.id
        }
      }
    } else if let observedSec = effective.selectedSecondarySubtitleId,
              Self.isIncompatibleSubtitlePair(primaryId: effective.selectedSubtitleId, secondaryId: observedSec)
    {
      effective.selectedSecondarySubtitleId = nil
      clearSecondarySubtitle = true
    }

    if effective.videoQualities.isEmpty {
      effective.selectedVideoQualityId = nil
    } else if let chosenQuality = videoQualityId {
      effective.selectedVideoQualityId = chosenQuality
    }

    latestTracks = effective
    let toEmit = (effective != lastEmitted) ? effective : nil
    if let toEmit { lastEmitted = toEmit }
    return TrackReconcileOutcome(
      toEmit: toEmit,
      selectAudioStreamId: selectAudioStreamId,
      selectSubtitleStreamId: selectSubtitleStreamId,
      selectExternalSubtitleId: selectExternalSubtitleId,
      clearSubtitle: clearSubtitle,
      selectSecondarySubtitleId: selectSecondarySubtitleId,
      clearSecondarySubtitle: clearSecondarySubtitle
    )
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

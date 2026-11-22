import Foundation

/// AirPlay receiver classification derived from `_airplay._tcp` Bonjour TXT `model` metadata (`#234`).
public enum AirPlayReceiverClass: Equatable, Sendable {
  case appleSurround
  case thirdPartyStereo
  case unknown
}

/// Recommended audio output policy for the current local or AirPlay route (`#234`).
public enum AirPlayAudioMode: Equatable, Sendable {
  case surroundPassthrough
  case stereoAacLc
}

private let appleAirPlayModelPrefixes: [String] = [
  "AppleTV",
  "AudioAccessory",
  "MacBook",
  "Macmini",
  "MacPro",
  "MacStudio",
  "iMac",
  "iPad",
  "iPhone",
  "Mac",
]

/// Extracts a trimmed `model` value from a Bonjour `_airplay._tcp` TXT dictionary (case-insensitive key match).
public func parseAirPlayTxtModel(_ txtRecord: [String: String]) -> String? {
  if let exact = txtRecord["model"] {
    let trimmed = exact.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      return trimmed
    }
  }
  for (key, value) in txtRecord where key.caseInsensitiveCompare("model") == .orderedSame {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmed.isEmpty {
      return trimmed
    }
  }
  return nil
}

/// Classifies an AirPlay receiver `model` string as Apple surround-capable hardware or third-party stereo-only.
public func classifyAirPlayReceiver(model: String?) -> AirPlayReceiverClass {
  guard let trimmed = model?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
    return .unknown
  }
  for prefix in appleAirPlayModelPrefixes {
    if trimmed.range(of: prefix, options: [.anchored, .caseInsensitive]) != nil {
      return .appleSurround
    }
  }
  return .thirdPartyStereo
}

/// Pure state tracker correlating active AirPlay routes with Bonjour `_airplay._tcp` TXT models (`#234`).
public struct AirPlayCapabilityTracker: Equatable, Sendable {
  public private(set) var activeAirPlayPortName: String?
  public private(set) var isExternalPlaybackActive: Bool = false
  private var discoveredModelsByName: [String: String] = [:]

  public init() {}

  /// Whether an AirPlay audio route or `AVPlayer.isExternalPlaybackActive` is currently active.
  public var isAirPlayActive: Bool {
    isExternalPlaybackActive || activeAirPlayPortName != nil
  }

  /// Whether lazy `_airplay._tcp` Bonjour browsing should be running.
  public var shouldBrowseBonjour: Bool {
    isAirPlayActive
  }

  /// Updates the active `.airPlay` route port name (`nil` when playing locally).
  public mutating func updateRoute(airPlayPortName: String?) {
    let trimmed = airPlayPortName?.trimmingCharacters(in: .whitespacesAndNewlines)
    activeAirPlayPortName = (trimmed?.isEmpty == false) ? trimmed : nil
  }

  /// Updates `AVPlayer.isExternalPlaybackActive` status.
  public mutating func updateExternalPlayback(active: Bool) {
    isExternalPlaybackActive = active
  }

  /// Records a discovered `_airplay._tcp` service and its TXT dictionary.
  public mutating func recordDiscoveredService(name: String, txtRecord: [String: String]) {
    recordDiscoveredService(name: name, model: parseAirPlayTxtModel(txtRecord))
  }

  /// Records a discovered `_airplay._tcp` service and optional pre-parsed `model` string.
  public mutating func recordDiscoveredService(name: String, model: String?) {
    let normalized = Self.normalizeServiceName(name)
    guard !normalized.isEmpty else { return }
    guard let trimmedModel = model?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmedModel.isEmpty else {
      return
    }
    discoveredModelsByName[normalized] = trimmedModel
  }

  /// Replaces the discovered Bonjour service snapshot atomically.
  public mutating func replaceDiscoveredServices(_ services: [(name: String, model: String?)]) {
    discoveredModelsByName.removeAll(keepingCapacity: true)
    for service in services {
      recordDiscoveredService(name: service.name, model: service.model)
    }
  }

  /// Removes a single discovered Bonjour service by name.
  public mutating func removeDiscoveredService(name: String) {
    let normalized = Self.normalizeServiceName(name)
    guard !normalized.isEmpty else { return }
    discoveredModelsByName.removeValue(forKey: normalized)
  }

  /// Clears cached Bonjour discoveries without changing route flags.
  public mutating func clearDiscoveredServices() {
    discoveredModelsByName.removeAll()
  }

  /// Resets route, external playback, and discovered service state across stop/rebuild/dispose.
  public mutating func reset() {
    activeAirPlayPortName = nil
    isExternalPlaybackActive = false
    discoveredModelsByName.removeAll()
  }

  /// Classification of the currently active AirPlay receiver, or `.unknown` if unmatched or local.
  public var activeReceiverClass: AirPlayReceiverClass {
    guard isAirPlayActive, let portName = activeAirPlayPortName else {
      return .unknown
    }
    let normalized = Self.normalizeServiceName(portName)
    guard let model = discoveredModelsByName[normalized] else {
      return .unknown
    }
    return classifyAirPlayReceiver(model: model)
  }

  /// Recommended audio delivery mode: surround passthrough locally or on verified Apple receivers, stereo AAC-LC otherwise.
  public var recommendedAudioMode: AirPlayAudioMode {
    guard isAirPlayActive else {
      return .surroundPassthrough
    }
    return activeReceiverClass == .appleSurround ? .surroundPassthrough : .stereoAacLc
  }

  static func normalizeServiceName(_ raw: String) -> String {
    let unifiedQuotes = raw
      .replacingOccurrences(of: "\u{2019}", with: "'")
      .replacingOccurrences(of: "\u{2018}", with: "'")
    let folded = unifiedQuotes.folding(
      options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive],
      locale: Locale(identifier: "en_US_POSIX")
    )
    return folded
      .components(separatedBy: .whitespacesAndNewlines)
      .filter { !$0.isEmpty }
      .joined(separator: " ")
  }
}

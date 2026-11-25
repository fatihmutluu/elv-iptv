import Foundation

/// Pure platform-agnostic state machine queuing cold-launch scene URLs until React Native JS loads,
/// deduplicating replays, and passing warm scene links straight through (`#258`).
public struct SceneLinkReplay: Equatable, Sendable {
  public static let openURLNotificationName = "RCTOpenURLNotification"
  public static let openURLUserInfoKey = "url"
  public static let javaScriptDidLoadNotificationName = "RCTJavaScriptDidLoadNotification"

  public private(set) var isJavaScriptLoaded: Bool
  public private(set) var pendingColdLaunchURLs: [String]
  public private(set) var deliveredColdLaunchURLs: Set<String>

  public init(isJavaScriptLoaded: Bool = false) {
    self.isJavaScriptLoaded = isJavaScriptLoaded
    self.pendingColdLaunchURLs = []
    self.deliveredColdLaunchURLs = []
  }

  /// Extracts a normalized URL string when a user activity represents a web universal link.
  public static func extractBrowsingWebURL(activityType: String, webpageURL: URL?) -> String? {
    guard activityType == NSUserActivityTypeBrowsingWeb, let raw = webpageURL?.absoluteString else {
      return nil
    }
    return normalizeURL(raw)
  }

  /// Records cold-launch URLs from `UIScene.ConnectionOptions`.
  /// Returns URLs to emit immediately if JavaScript is already loaded; otherwise queues them once for replay.
  @discardableResult
  public mutating func enqueueColdLaunchURLs(_ rawURLs: [String]) -> [String] {
    var accepted: [String] = []
    for raw in rawURLs {
      guard let normalized = Self.normalizeURL(raw) else { continue }
      if deliveredColdLaunchURLs.contains(normalized)
        || pendingColdLaunchURLs.contains(normalized)
        || accepted.contains(normalized)
      {
        continue
      }
      accepted.append(normalized)
    }
    guard !accepted.isEmpty else { return [] }

    if isJavaScriptLoaded {
      for url in accepted {
        deliveredColdLaunchURLs.insert(url)
      }
      return accepted
    }

    pendingColdLaunchURLs.append(contentsOf: accepted)
    return []
  }

  /// Marks React Native JavaScript as loaded and drains any queued cold-launch URLs exactly once.
  @discardableResult
  public mutating func markJavaScriptLoaded() -> [String] {
    isJavaScriptLoaded = true
    return drainPendingColdLaunchURLs()
  }

  /// Drains any still-pending cold-launch URLs for the `didBecomeActive` fallback without firing twice.
  @discardableResult
  public mutating func flushPendingForActiveFallback() -> [String] {
    drainPendingColdLaunchURLs()
  }

  /// Prepares warm-launch URLs (`scene(_:openURLContexts:)` / `scene(_:continue:)`) for immediate delivery.
  /// Deduplicates within the batch and clears any matching pending cold-launch entry so it does not replay twice.
  public mutating func prepareWarmURLs(_ rawURLs: [String]) -> [String] {
    var toDeliver: [String] = []
    for raw in rawURLs {
      guard let normalized = Self.normalizeURL(raw) else { continue }
      if toDeliver.contains(normalized) {
        continue
      }
      toDeliver.append(normalized)
      if pendingColdLaunchURLs.contains(normalized) {
        pendingColdLaunchURLs.removeAll { $0 == normalized }
        deliveredColdLaunchURLs.insert(normalized)
      }
    }
    return toDeliver
  }

  /// Whether any cold-launch URLs are currently waiting to be replayed.
  public var hasPendingColdLaunchURLs: Bool {
    !pendingColdLaunchURLs.isEmpty
  }

  private mutating func drainPendingColdLaunchURLs() -> [String] {
    guard !pendingColdLaunchURLs.isEmpty else { return [] }
    let drained = pendingColdLaunchURLs
    pendingColdLaunchURLs.removeAll()
    for url in drained {
      deliveredColdLaunchURLs.insert(url)
    }
    return drained
  }

  private static func normalizeURL(_ raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

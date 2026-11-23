import Foundation

/// Supported Apple tvOS `UIPress.PressType` remote button kinds (`#414`).
public enum ApplePressKind: String, CaseIterable, Equatable, Hashable, Sendable {
  case upArrow
  case downArrow
  case leftArrow
  case rightArrow
  case select
  case menu
  case playPause
  case pageUp
  case pageDown
}

/// Maps an `ApplePressKind` to the canonical key code shared with `@elv/ui-kit`'s key adapter (`#414`).
public func canonicalKeyCode(for kind: ApplePressKind) -> Int {
  switch kind {
  case .upArrow:
    return 19
  case .downArrow:
    return 20
  case .leftArrow:
    return 21
  case .rightArrow:
    return 22
  case .select:
    return 23
  case .menu:
    return 4
  case .playPause:
    return 85
  case .pageUp:
    return 92
  case .pageDown:
    return 93
  }
}

/// Phase emitted on the native `onKey` event stream.
public enum AppleRemoteKeyAction: String, Equatable, Sendable {
  case down
  case up
  case blur
}

/// Normalized key event emitted by `ElvRemoteKeysModule` on tvOS.
public struct AppleRemoteKeyEvent: Equatable, Sendable {
  public let action: AppleRemoteKeyAction
  public let keyCode: Int?
  public let canceled: Bool
  public let eventTimeMs: Double?

  public init(
    action: AppleRemoteKeyAction,
    keyCode: Int? = nil,
    canceled: Bool = false,
    eventTimeMs: Double? = nil
  ) {
    self.action = action
    self.keyCode = keyCode
    self.canceled = canceled
    self.eventTimeMs = eventTimeMs
  }

  /// Dictionary payload delivered through Expo Modules `emit(event: "onKey", payload: ...)`.
  public func toPayload() -> [String: Any] {
    if action == .blur {
      return ["action": action.rawValue]
    }
    return [
      "action": action.rawValue,
      "keyCode": keyCode ?? 0,
      "canceled": canceled,
      "eventTime": eventTimeMs ?? 0.0,
    ]
  }
}

/// Tracks active pressed tvOS remote buttons to deduplicate downs, ignore orphan ups, and flush held keys on blur (`#414`).
public struct ApplePressTracker: Sendable {
  private var heldKeyCodes: Set<Int> = []

  public init() {}

  /// Number of currently held remote keys.
  public var heldCount: Int {
    heldKeyCodes.count
  }

  /// Records a press-began transition; returns `nil` when the key is already held.
  public mutating func pressBegan(_ kind: ApplePressKind, eventTimeMs: Double) -> AppleRemoteKeyEvent? {
    let keyCode = canonicalKeyCode(for: kind)
    guard heldKeyCodes.insert(keyCode).inserted else {
      return nil
    }
    let cleanTime = eventTimeMs.isFinite ? max(0.0, eventTimeMs) : 0.0
    return AppleRemoteKeyEvent(action: .down, keyCode: keyCode, canceled: false, eventTimeMs: cleanTime)
  }

  /// Records a press-ended or press-cancelled transition; returns `nil` for orphan releases of unheld keys.
  public mutating func pressEnded(
    _ kind: ApplePressKind,
    canceled: Bool,
    eventTimeMs: Double
  ) -> AppleRemoteKeyEvent? {
    let keyCode = canonicalKeyCode(for: kind)
    guard heldKeyCodes.remove(keyCode) != nil else {
      return nil
    }
    let cleanTime = eventTimeMs.isFinite ? max(0.0, eventTimeMs) : 0.0
    return AppleRemoteKeyEvent(action: .up, keyCode: keyCode, canceled: canceled, eventTimeMs: cleanTime)
  }

  /// Flushes every held key and returns the `blur` event emitted on window/application resignation.
  public mutating func handleBlur() -> AppleRemoteKeyEvent {
    heldKeyCodes.removeAll()
    return AppleRemoteKeyEvent(action: .blur)
  }

  /// Clears all held-key bookkeeping without emitting an event.
  public mutating func reset() {
    heldKeyCodes.removeAll()
  }
}

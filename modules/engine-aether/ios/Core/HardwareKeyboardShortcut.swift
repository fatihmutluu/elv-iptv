import Foundation

/// Normalized hardware keyboard input key received from iOS/iPadOS `UIKeyCommand` (`#415`).
public enum HardwareKeyInput: Equatable, Hashable, Sendable {
  case space
  case leftArrow
  case rightArrow
  case upArrow
  case downArrow
  case character(String)
  case escape
}

/// Playback action identifier emitted over `onHardwareKey` to JavaScript (`#415`).
public enum HardwareKeyCommandAction: String, Equatable, Hashable, Sendable {
  case playPause = "play-pause"
  case seekBack = "seek-back"
  case seekForward = "seek-forward"
  case channelUp = "channel-up"
  case channelDown = "channel-down"
  case volumeUp = "volume-up"
  case volumeDown = "volume-down"
  case mute = "mute"
  case aspect = "aspect"
  case back = "back"
}

/// Pure stateful mapper translating iPadOS/iOS hardware keys into playback actions while yielding to text inputs,
/// ignoring Command/Control shortcuts, suppressing toggle auto-repeat, and throttling held arrow keys (`#415`).
public struct HardwareKeyboardMapper: Equatable, Sendable {
  public let repeatThrottleMs: Double
  public let toggleCooldownMs: Double
  private var lastActionMs: [HardwareKeyCommandAction: Double] = [:]

  public init(repeatThrottleMs: Double = 200.0, toggleCooldownMs: Double = 550.0) {
    self.repeatThrottleMs = (repeatThrottleMs.isFinite && repeatThrottleMs >= 0) ? repeatThrottleMs : 200.0
    self.toggleCooldownMs = (toggleCooldownMs.isFinite && toggleCooldownMs >= 0) ? toggleCooldownMs : 550.0
  }

  /// Resolves a hardware key event into a `HardwareKeyCommandAction`, or `nil` when ignored or throttled.
  public mutating func map(
    input: HardwareKeyInput,
    modifiersHaveCommandOrControl: Bool,
    isLive: Bool,
    isTextInputFocused: Bool,
    isRepeat: Bool = false,
    nowMs: Double
  ) -> HardwareKeyCommandAction? {
    guard !isTextInputFocused, !modifiersHaveCommandOrControl, nowMs.isFinite else {
      return nil
    }

    let resolved: (action: HardwareKeyCommandAction, isToggle: Bool)?
    switch input {
    case .space:
      resolved = (.playPause, true)
    case .leftArrow:
      resolved = (.seekBack, false)
    case .rightArrow:
      resolved = (.seekForward, false)
    case .upArrow:
      resolved = (isLive ? .channelUp : .volumeUp, false)
    case .downArrow:
      resolved = (isLive ? .channelDown : .volumeDown, false)
    case .escape:
      resolved = (.back, true)
    case let .character(raw):
      switch raw.lowercased() {
      case " ":
        resolved = (.playPause, true)
      case "m":
        resolved = (.mute, true)
      case "f":
        resolved = (.aspect, true)
      default:
        resolved = nil
      }
    }

    guard let (action, isToggle) = resolved else {
      return nil
    }

    if isToggle {
      if isRepeat {
        lastActionMs[action] = nowMs
        return nil
      }
      if let previous = lastActionMs[action], nowMs >= previous, (nowMs - previous) < toggleCooldownMs {
        lastActionMs[action] = nowMs
        return nil
      }
      lastActionMs[action] = nowMs
      return action
    }

    if let previous = lastActionMs[action], nowMs >= previous, (nowMs - previous) < repeatThrottleMs {
      return nil
    }
    lastActionMs[action] = nowMs
    return action
  }

  /// Clears repeat-throttle timestamps across focus/lifecycle transitions.
  public mutating func reset() {
    lastActionMs.removeAll()
  }
}

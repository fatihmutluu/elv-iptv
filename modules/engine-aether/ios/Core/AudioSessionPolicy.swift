import Foundation

/// Action returned by `AudioSessionPolicy` for an audio session interruption or route-change event.
public enum AudioSessionAction: Equatable, Sendable {
  case none
  case systemPause
  case pauseAndSystemPause
  case resume
}

/// Pure state machine tracking audio interruptions and headphone/Bluetooth route removals without time-window races.
public struct AudioSessionPolicy: Equatable, Sendable {
  public private(set) var isInterrupted: Bool = false
  public private(set) var wasPlayingBeforeInterruption: Bool = false
  public private(set) var latchedRoutePause: Bool = false

  public init() {}

  /// Records an audio session interruption start and requests a system-initiated pause.
  public mutating func handleInterruptionBegan(currentlyPlaying: Bool) -> AudioSessionAction {
    if isInterrupted {
      wasPlayingBeforeInterruption = wasPlayingBeforeInterruption || currentlyPlaying
    } else {
      isInterrupted = true
      wasPlayingBeforeInterruption = currentlyPlaying
    }
    return .systemPause
  }

  /// Resolves an audio session interruption end, resuming only when playback was active, `.shouldResume` is set, and no route pause is latched.
  public mutating func handleInterruptionEnded(shouldResume: Bool) -> AudioSessionAction {
    isInterrupted = false
    let resume = wasPlayingBeforeInterruption && shouldResume && !latchedRoutePause
    wasPlayingBeforeInterruption = false
    return resume ? .resume : .none
  }

  /// Handles `.oldDeviceUnavailable` route changes by latching a system pause so delayed `.paused` callbacks never auto-resume over speakers.
  public mutating func handleOldDeviceUnavailable(isRemovedAudioRoute: Bool) -> AudioSessionAction {
    guard isRemovedAudioRoute else { return .none }
    latchedRoutePause = true
    return .pauseAndSystemPause
  }

  /// Whether subsequent backend pause observations should be treated as system-initiated rather than unrequested live drops.
  public var shouldTreatPauseAsSystem: Bool {
    isInterrupted || latchedRoutePause
  }

  /// Clears route-removal and interruption-resume latches when the user explicitly requests playback.
  public mutating func clearLatchesOnUserPlay() {
    latchedRoutePause = false
    wasPlayingBeforeInterruption = false
  }

  /// Clears all interruption and route-pause state across stop or rebuild boundaries.
  public mutating func reset() {
    isInterrupted = false
    wasPlayingBeforeInterruption = false
    latchedRoutePause = false
  }
}

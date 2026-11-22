import AVFoundation
import Foundation

private let routeRemovalPortTypes: Set<String> = [
  "Headphones",
  "BluetoothA2DPOutput",
  "BluetoothLE",
  "BluetoothHFP",
  "AirPlay",
  "USBAudio",
]

/// `Sendable` representation of `AVAudioSession` interruption and route-change notifications.
enum AudioSessionEvent: Equatable, Sendable {
  case interruptionBegan
  case interruptionEnded(shouldResume: Bool)
  case oldDeviceUnavailable(isRemovedAudioRoute: Bool)
}

/// Passive `AVAudioSession` observer distinguishing call/headphone pauses (`#256`, `#427`) from unrequested live stalls (`#227`).
final class AetherAudioSessionObserver: @unchecked Sendable {
  private let lock = NSLock()
  private var tokens: [NSObjectProtocol] = []

  init(onEvent: @escaping @MainActor @Sendable (AudioSessionEvent) -> Void) {
    let center = NotificationCenter.default
    let interruptionToken = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: .main
    ) { note in
      guard let rawType = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt else { return }
      if rawType == AVAudioSession.InterruptionType.began.rawValue {
        AetherBackend.onMainActor { onEvent(.interruptionBegan) }
      } else if rawType == AVAudioSession.InterruptionType.ended.rawValue {
        let optionsRaw = (note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt) ?? 0
        let shouldResume = AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume)
        AetherBackend.onMainActor { onEvent(.interruptionEnded(shouldResume: shouldResume)) }
      }
    }

    let routeToken = center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: .main
    ) { note in
      guard let reasonRaw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
            reasonRaw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
      else { return }
      let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
      let portTypes = previous?.outputs.map(\.portType.rawValue) ?? []
      let isRemovedAudioRoute = portTypes.contains(where: routeRemovalPortTypes.contains)
      AetherBackend.onMainActor { onEvent(.oldDeviceUnavailable(isRemovedAudioRoute: isRemovedAudioRoute)) }
    }

    lock.withLock {
      tokens = [interruptionToken, routeToken]
    }
  }

  deinit {
    dispose()
  }

  func dispose() {
    let drained: [NSObjectProtocol] = lock.withLock {
      let out = tokens
      tokens.removeAll()
      return out
    }
    for token in drained {
      NotificationCenter.default.removeObserver(token)
    }
  }
}

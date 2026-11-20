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

/// Passive `AVAudioSession` observer distinguishing genuine call/headphone pauses (`#256`) from unrequested live stalls (`#227`).
final class AetherAudioSessionObserver: @unchecked Sendable {
  private let lock = NSLock()
  private var tokens: [NSObjectProtocol] = []

  init(onEvent: @escaping @MainActor @Sendable (_ interrupted: Bool?, _ holdWindowMs: Double) -> Void) {
    let center = NotificationCenter.default
    let interruptionToken = center.addObserver(
      forName: AVAudioSession.interruptionNotification,
      object: nil,
      queue: .main
    ) { note in
      let rawType = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
      guard let rawType else { return }
      if rawType == AVAudioSession.InterruptionType.began.rawValue {
        AetherBackend.onMainActor { onEvent(true, 2_000.0) }
      } else if rawType == AVAudioSession.InterruptionType.ended.rawValue {
        AetherBackend.onMainActor { onEvent(false, 500.0) }
      }
    }

    let routeToken = center.addObserver(
      forName: AVAudioSession.routeChangeNotification,
      object: nil,
      queue: .main
    ) { note in
      let reasonRaw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt
      let previous = note.userInfo?[AVAudioSessionRouteChangePreviousRouteKey] as? AVAudioSessionRouteDescription
      let portTypes = previous?.outputs.map(\.portType.rawValue) ?? []
      let removedAutoPausePort = reasonRaw == AVAudioSession.RouteChangeReason.oldDeviceUnavailable.rawValue
        && portTypes.contains(where: routeRemovalPortTypes.contains)
      guard removedAutoPausePort else { return }
      AetherBackend.onMainActor { onEvent(nil, 1_500.0) }
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

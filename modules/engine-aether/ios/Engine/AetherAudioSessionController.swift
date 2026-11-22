import AVFoundation
import Foundation

/// Owns `AVAudioSession` playback category configuration and balanced activation/deactivation on iOS, iPadOS, and tvOS.
@MainActor
final class AetherAudioSessionController {
  private var ownsActiveSession = false

  /// Configures `.playback` / `.moviePlayback` with multichannel support and activates the shared audio session.
  func activateForPlayback() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .moviePlayback, options: [])
    } catch {
      NSLog("ELV_AETHER audioSession setCategory failed: %@", error.localizedDescription)
    }

    if #available(iOS 15.0, tvOS 15.0, *) {
      do {
        try session.setSupportsMultichannelContent(true)
      } catch {
        NSLog("ELV_AETHER audioSession setSupportsMultichannelContent failed: %@", error.localizedDescription)
      }
    }

    do {
      try session.setActive(true)
      ownsActiveSession = true
    } catch {
      NSLog("ELV_AETHER audioSession setActive(true) failed: %@", error.localizedDescription)
    }
  }

  /// Deactivates the shared audio session with `.notifyOthersOnDeactivation` if this controller currently owns it.
  func deactivateIfOwned() {
    guard ownsActiveSession else { return }
    ownsActiveSession = false
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      NSLog("ELV_AETHER audioSession setActive(false) failed: %@", error.localizedDescription)
    }
  }
}

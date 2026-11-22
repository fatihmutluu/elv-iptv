import AVFoundation
import Foundation

/// Owns `AVAudioSession` playback category configuration and balanced activation/deactivation on iOS, iPadOS, and tvOS.
@MainActor
final class AetherAudioSessionController {
  private var ownsActiveSession = false
  private var multichannelEnabled = true

  /// Updates whether multichannel surround content is enabled (`true` locally / Apple AirPlay, `false` for third-party AirPlay stereo fallback, `#234`).
  func setMultichannelEnabled(_ enabled: Bool) {
    guard enabled != multichannelEnabled else { return }
    multichannelEnabled = enabled
    guard ownsActiveSession else { return }
    applyMultichannelPreference(to: AVAudioSession.sharedInstance())
  }

  /// Configures `.playback` / `.moviePlayback` with the current multichannel preference and activates the shared audio session.
  func activateForPlayback() {
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .moviePlayback, options: [])
    } catch {
      NSLog("ELV_AETHER audioSession setCategory failed: %@", error.localizedDescription)
    }

    applyMultichannelPreference(to: session)

    do {
      try session.setActive(true)
      ownsActiveSession = true
    } catch {
      NSLog("ELV_AETHER audioSession setActive(true) failed: %@", error.localizedDescription)
    }
  }

  private func applyMultichannelPreference(to session: AVAudioSession) {
    if #available(iOS 15.0, tvOS 15.0, *) {
      do {
        try session.setSupportsMultichannelContent(multichannelEnabled)
      } catch {
        NSLog("ELV_AETHER audioSession setSupportsMultichannelContent failed: %@", error.localizedDescription)
      }
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

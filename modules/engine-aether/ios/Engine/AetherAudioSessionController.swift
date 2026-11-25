import AVFoundation
import Foundation

/// Owns `AVAudioSession` playback category configuration and ref-counted balanced activation/deactivation
/// across live engines on iOS, iPadOS, and tvOS (`#34`).
@MainActor
final class AetherAudioSessionController {
  private static var sharedRefCounter = AetherAudioSessionRefCounter()
  private static var nextOwnerId: UInt64 = 0

  private let ownerId: UInt64
  private var multichannelEnabled = true

  init() {
    Self.nextOwnerId &+= 1
    self.ownerId = Self.nextOwnerId
  }

  private var ownsActiveSession: Bool {
    Self.sharedRefCounter.isOwned(by: ownerId)
  }

  /// Updates whether multichannel surround content is enabled (`true` locally / Apple AirPlay, `false` for third-party AirPlay stereo fallback, `#234`).
  func setMultichannelEnabled(_ enabled: Bool, handleAudioFocus: Bool = true) {
    guard enabled != multichannelEnabled else { return }
    multichannelEnabled = enabled
    guard handleAudioFocus, ownsActiveSession else { return }
    applyMultichannelPreference(to: AVAudioSession.sharedInstance())
  }

  /// Configures `.playback` / `.moviePlayback` with the current multichannel preference and activates the shared audio session.
  /// Secondary muted Multi-View tiles join the ref-count without mutating an already-active session's category or multichannel mode.
  func activateForPlayback(handleAudioFocus: Bool = true) {
    if !handleAudioFocus && Self.sharedRefCounter.activeCount > 0 {
      _ = Self.sharedRefCounter.acquire(ownerId: ownerId)
      return
    }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .moviePlayback, options: [])
    } catch {
      NSLog("ELV_AETHER audioSession setCategory failed: %@", error.localizedDescription)
    }

    if handleAudioFocus || Self.sharedRefCounter.activeCount == 0 {
      applyMultichannelPreference(to: session)
    }

    do {
      try session.setActive(true)
      _ = Self.sharedRefCounter.acquire(ownerId: ownerId)
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

  /// Releases this controller's ref-counted lease and deactivates the shared audio session strictly when active owners drop to `0`.
  func deactivateIfOwned() {
    guard Self.sharedRefCounter.release(ownerId: ownerId) else { return }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setActive(false, options: .notifyOthersOnDeactivation)
    } catch {
      NSLog("ELV_AETHER audioSession setActive(false) failed: %@", error.localizedDescription)
    }
  }
}

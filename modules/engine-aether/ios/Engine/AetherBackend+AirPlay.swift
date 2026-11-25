import AetherEngine
import AVFoundation
import Foundation

extension AetherBackend {
  func setMuted(_ muted: Bool) {
    desiredMuted = muted
    engine?.currentAVPlayer?.isMuted = muted
  }

  func setVolume(_ percent: Double) {
    guard percent.isFinite else { return }
    let clamped = Float(min(100.0, max(0.0, percent)) / 100.0)
    desiredVolume = clamped
    engine?.currentAVPlayer?.volume = clamped
  }

  func applyOutputAudioPreferences(to player: AVPlayer?) {
    guard let player else { return }
    player.isMuted = desiredMuted
    player.volume = desiredVolume
  }

  func syncAirPlayState() {
    let mode = airPlayTracker.recommendedAudioMode
    audioSessionController.setMultichannelEnabled(
      mode == .surroundPassthrough,
      handleAudioFocus: handleAudioFocus
    )
    if activeLoadSerial > 0 && airPlayTracker.shouldBrowseBonjour {
      airPlayMonitor?.start()
    } else {
      airPlayMonitor?.stop()
    }
  }

  func resetAirPlayState() {
    airPlayMonitor?.stop()
    airPlayTracker.reset()
    audioSessionController.setMultichannelEnabled(true, handleAudioFocus: handleAudioFocus)
  }

  func handleAirPlayRouteChanged(_ airPlayPortName: String?) {
    airPlayTracker.updateRoute(airPlayPortName: airPlayPortName)
    if airPlayPortName == nil && !airPlayTracker.isExternalPlaybackActive {
      airPlayTracker.clearDiscoveredServices()
    }
    syncAirPlayState()
  }

  func handleAirPlayServicesUpdated(_ services: [AirPlayDiscoveredService]) {
    airPlayTracker.replaceDiscoveredServices(services.map { ($0.name, $0.model) })
    syncAirPlayState()
  }

  /// True whenever playback is outputting to either AirPlay (`AVPlayer.isExternalPlaybackActive`) or a dedicated external `UIWindowScene` (`#258`).
  var effectiveExternalPlaybackActive: Bool {
    airPlayTracker.isExternalPlaybackActive || isExternalDisplaySceneActive
  }

  /// Updates dedicated iOS/iPadOS external `UIWindowScene` output status without disturbing AirPlay state (`#258`).
  func setExternalDisplaySceneActive(_ active: Bool) {
    guard isExternalDisplaySceneActive != active else { return }
    isExternalDisplaySceneActive = active
    let serial = engineLoadSerial > 0 ? engineLoadSerial : activeLoadSerial
    if serial > 0 {
      onObservation?(.externalPlayback(effectiveExternalPlaybackActive), serial)
    }
  }

  func handleExternalPlaybackChange(_ active: Bool) {
    airPlayTracker.updateExternalPlayback(active: active)
    if active {
      airPlayTracker.updateRoute(airPlayPortName: AetherAudioSessionObserver.currentAirPlayPortName())
      lastAVBufferReportedBuffering = false
    } else if airPlayTracker.activeAirPlayPortName == nil {
      airPlayTracker.clearDiscoveredServices()
    }
    syncAirPlayState()
    let serial = engineLoadSerial > 0 ? engineLoadSerial : activeLoadSerial
    if serial > 0 {
      onObservation?(.externalPlayback(effectiveExternalPlaybackActive), serial)
    }
  }
}

import Foundation
#if canImport(AVKit) && canImport(UIKit)
import AVFoundation
import AVKit
import QuartzCore
import UIKit

/// Wraps Apple's `AVPictureInPictureController` over an active `AVPlayerLayer` hosted inside
/// `AetherSurfaceView.playerView`, arming detached-surface tolerance during PiP (`#34`, `#117`)
/// and degrading cleanly to `false` on raw MPEG-TS non-`AVPlayer` routes.
@MainActor
final class AetherPipController: NSObject {
  static let maxLayerSearchDepth = 6

  /// Whether automatic inline-to-PiP entry is supported on the current Apple platform (iOS/iPadOS only).
  static var isAutoEnterSupported: Bool {
    #if os(iOS)
    return AVPictureInPictureController.isPictureInPictureSupported()
    #else
    return false
    #endif
  }

  /// Recursively locates an active `AVPlayerLayer` (`player != nil`) in `rootLayer` up to bounded `maxDepth`.
  static func findActivePlayerLayer(
    in rootLayer: CALayer,
    maxDepth: Int = maxLayerSearchDepth
  ) -> AVPlayerLayer? {
    guard maxDepth >= 0 else { return nil }
    if let playerLayer = rootLayer as? AVPlayerLayer, playerLayer.player != nil {
      return playerLayer
    }
    guard maxDepth > 0, let sublayers = rootLayer.sublayers, !sublayers.isEmpty else {
      return nil
    }
    for sublayer in sublayers {
      if let found = findActivePlayerLayer(in: sublayer, maxDepth: maxDepth - 1) {
        return found
      }
    }
    return nil
  }

  private let onDetachedSurfaceChanged: @MainActor (Bool) -> Void
  private let onPipStateChanged: @MainActor (Bool) -> Void

  private var pipController: AVPictureInPictureController?
  private weak var boundPlayerLayer: AVPlayerLayer?
  private var autoEnterEnabled = false
  private var isPipActive = false
  private var lastEmittedInPip: Bool?
  private var isDisposed = false

  init(
    onDetachedSurfaceChanged: @escaping @MainActor (Bool) -> Void,
    onPipStateChanged: @escaping @MainActor (Bool) -> Void
  ) {
    self.onDetachedSurfaceChanged = onDetachedSurfaceChanged
    self.onPipStateChanged = onPipStateChanged
    super.init()
  }

  /// Synchronizes `AVPictureInPictureController` with the active `AVPlayerLayer` when on an `AVPlayer` route.
  func sync(playerView: UIView?, isAvPlayerRoute: Bool) {
    guard !isDisposed else { return }
    guard AVPictureInPictureController.isPictureInPictureSupported(),
          isAvPlayerRoute,
          let playerView,
          let layer = Self.findActivePlayerLayer(in: playerView.layer)
    else {
      if !isPipActive {
        detachController()
      }
      return
    }

    if boundPlayerLayer === layer, let existing = pipController {
      applyAutoEnterPreference(to: existing)
      return
    }

    if isPipActive {
      return
    }

    detachController()
    guard let created = AVPictureInPictureController(playerLayer: layer) else {
      return
    }
    created.delegate = self
    applyAutoEnterPreference(to: created)
    pipController = created
    boundPlayerLayer = layer
  }

  /// Returns `true` when system PiP can be started for the currently bound `AVPlayerLayer`.
  func canStartPictureInPicture(playerView: UIView?, isAvPlayerRoute: Bool) -> Bool {
    guard !isDisposed, AVPictureInPictureController.isPictureInPictureSupported() else {
      return false
    }
    sync(playerView: playerView, isAvPlayerRoute: isAvPlayerRoute)
    guard let controller = pipController else {
      return false
    }
    return controller.isPictureInPicturePossible
  }

  /// Starts system PiP when possible; returns `false` on unsupported/raw-TS routes for in-app mini-player fallback.
  func enterPictureInPicture(playerView: UIView?, isAvPlayerRoute: Bool) -> Bool {
    guard !isDisposed, AVPictureInPictureController.isPictureInPictureSupported() else {
      return false
    }
    sync(playerView: playerView, isAvPlayerRoute: isAvPlayerRoute)
    guard let controller = pipController else {
      return false
    }
    if controller.isPictureInPictureActive {
      return true
    }
    guard controller.isPictureInPicturePossible else {
      return false
    }
    controller.startPictureInPicture()
    return true
  }

  /// Configures iOS/iPadOS automatic PiP entry when backgrounding from inline playback (no-op returning `false` on tvOS).
  func setAutoEnterPictureInPicture(
    _ enabled: Bool,
    playerView: UIView?,
    isAvPlayerRoute: Bool
  ) -> Bool {
    guard !isDisposed else { return false }
    autoEnterEnabled = enabled
    sync(playerView: playerView, isAvPlayerRoute: isAvPlayerRoute)
    if let controller = pipController {
      applyAutoEnterPreference(to: controller)
    }
    return Self.isAutoEnterSupported
  }

  /// Releases the cached controller when the view unbinds unless system PiP is actively running.
  func handleSurfaceUnbound() {
    guard !isPipActive else { return }
    detachController()
  }

  /// Stops active PiP (if any), disarms detached-surface override, and detaches the controller.
  func reset() {
    if let controller = pipController, controller.isPictureInPictureActive {
      controller.stopPictureInPicture()
    }
    detachController()
    if isPipActive || lastEmittedInPip == true {
      isPipActive = false
      onDetachedSurfaceChanged(false)
      emitPipState(false)
    }
  }

  /// Permanently tears down the PiP controller on engine disposal.
  func dispose() {
    guard !isDisposed else { return }
    isDisposed = true
    reset()
  }

  private func detachController() {
    pipController?.delegate = nil
    pipController = nil
    boundPlayerLayer = nil
  }

  private func applyAutoEnterPreference(to controller: AVPictureInPictureController) {
    #if os(iOS)
    controller.canStartPictureInPictureAutomaticallyFromInline = autoEnterEnabled
    #else
    _ = controller
    #endif
  }

  private func handleWillStart() {
    guard !isDisposed else { return }
    isPipActive = true
    onDetachedSurfaceChanged(true)
    emitPipState(true)
  }

  private func handleDidStart() {
    guard !isDisposed else { return }
    isPipActive = true
    onDetachedSurfaceChanged(true)
    emitPipState(true)
  }

  private func handleFailedToStart(isStillActive: Bool) {
    guard !isDisposed else { return }
    if !isStillActive {
      isPipActive = false
      onDetachedSurfaceChanged(false)
    }
    emitPipState(false)
  }

  private func handleWillStop() {
    guard !isDisposed else { return }
    emitPipState(false)
  }

  private func handleDidStop() {
    guard !isDisposed else { return }
    isPipActive = false
    onDetachedSurfaceChanged(false)
    emitPipState(false)
  }

  private func emitPipState(_ inPip: Bool) {
    guard lastEmittedInPip != inPip else { return }
    lastEmittedInPip = inPip
    onPipStateChanged(inPip)
  }
}

extension AetherPipController: AVPictureInPictureControllerDelegate {
  nonisolated func pictureInPictureControllerWillStartPictureInPicture(
    _ pictureInPictureController: AVPictureInPictureController
  ) {
    AetherBackend.onMainActor { [weak self] in
      self?.handleWillStart()
    }
  }

  nonisolated func pictureInPictureControllerDidStartPictureInPicture(
    _ pictureInPictureController: AVPictureInPictureController
  ) {
    AetherBackend.onMainActor { [weak self] in
      self?.handleDidStart()
    }
  }

  nonisolated func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    failedToStartPictureInPictureWithError error: Error
  ) {
    AetherBackend.onMainActor { [weak self] in
      guard let self else { return }
      let stillActive = self.pipController?.isPictureInPictureActive ?? false
      self.handleFailedToStart(isStillActive: stillActive)
    }
  }

  nonisolated func pictureInPictureControllerWillStopPictureInPicture(
    _ pictureInPictureController: AVPictureInPictureController
  ) {
    AetherBackend.onMainActor { [weak self] in
      self?.handleWillStop()
    }
  }

  nonisolated func pictureInPictureControllerDidStopPictureInPicture(
    _ pictureInPictureController: AVPictureInPictureController
  ) {
    AetherBackend.onMainActor { [weak self] in
      self?.handleDidStop()
    }
  }

  nonisolated func pictureInPictureController(
    _ pictureInPictureController: AVPictureInPictureController,
    restoreUserInterfaceForPictureInPictureStopWithCompletionHandler completionHandler: @escaping (Bool) -> Void
  ) {
    if Thread.isMainThread {
      completionHandler(true)
    } else {
      DispatchQueue.main.async {
        completionHandler(true)
      }
    }
  }
}
#else
@MainActor
final class AetherPipController {
  static var isAutoEnterSupported: Bool { false }

  init(
    onDetachedSurfaceChanged: @escaping @MainActor (Bool) -> Void,
    onPipStateChanged: @escaping @MainActor (Bool) -> Void
  ) {}

  func sync(playerView: AnyObject?, isAvPlayerRoute: Bool) {}

  func canStartPictureInPicture(playerView: AnyObject?, isAvPlayerRoute: Bool) -> Bool {
    false
  }

  func enterPictureInPicture(playerView: AnyObject?, isAvPlayerRoute: Bool) -> Bool {
    false
  }

  func setAutoEnterPictureInPicture(
    _ enabled: Bool,
    playerView: AnyObject?,
    isAvPlayerRoute: Bool
  ) -> Bool {
    false
  }

  func handleSurfaceUnbound() {}

  func reset() {}

  func dispose() {}
}
#endif

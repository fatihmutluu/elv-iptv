import Foundation
import MediaPlayer
import UIKit

/// Callbacks routing `MPRemoteCommandCenter` actions back into `EngineMainDriver` on `@MainActor`.
struct NowPlayingRemoteActions {
  let onPlay: @MainActor () -> Void
  let onPause: @MainActor () -> Void
  let onTogglePlayPause: @MainActor () -> Void
  let onStop: @MainActor () -> Void
  let onSkipBy: @MainActor (Double) -> Void
  let onSeekTo: @MainActor (Double) -> Void
  let onChangeRate: @MainActor (Double) -> Void
  let onNextTrack: @MainActor () -> Void
  let onPreviousTrack: @MainActor () -> Void
}

private final class BoundedArtworkDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private struct ActiveFetch {
    var data = Data()
    var overflow = false
    let completion: @Sendable (UIImage?) -> Void
  }

  private let maxBytes: Int
  private let lock = NSLock()
  private var fetches: [Int: ActiveFetch] = [:]

  init(maxBytes: Int) {
    self.maxBytes = maxBytes
  }

  func register(taskId: Int, completion: @escaping @Sendable (UIImage?) -> Void) {
    lock.withLock {
      fetches[taskId] = ActiveFetch(completion: completion)
    }
  }

  func cancel(taskId: Int) {
    _ = lock.withLock {
      fetches.removeValue(forKey: taskId)
    }
  }

  func cancelAll() {
    lock.withLock {
      fetches.removeAll()
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    guard let rawUrl = request.url?.absoluteString,
          let safeUrl = sanitizeNowPlayingArtworkUrl(rawUrl)
    else {
      completionHandler(nil)
      return
    }
    var sanitizedRequest = request
    sanitizedRequest.url = safeUrl
    completionHandler(sanitizedRequest)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    if let http = response as? HTTPURLResponse, !(200...299).contains(http.statusCode) {
      completionHandler(.cancel)
      return
    }
    if response.expectedContentLength > Int64(maxBytes) {
      completionHandler(.cancel)
      return
    }
    if response.expectedContentLength > 0 {
      let expected = Int(response.expectedContentLength)
      lock.withLock {
        fetches[dataTask.taskIdentifier]?.data.reserveCapacity(expected)
      }
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    let shouldCancel: Bool = lock.withLock {
      guard var entry = fetches[dataTask.taskIdentifier] else { return true }
      if entry.data.count + data.count > maxBytes {
        entry.overflow = true
        entry.data.removeAll(keepingCapacity: false)
        fetches[dataTask.taskIdentifier] = entry
        return true
      }
      entry.data.append(data)
      fetches[dataTask.taskIdentifier] = entry
      return false
    }
    if shouldCancel {
      dataTask.cancel()
    }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    let finished = lock.withLock {
      fetches.removeValue(forKey: task.taskIdentifier)
    }
    guard let finished else { return }
    if error != nil || finished.overflow || finished.data.isEmpty {
      finished.completion(nil)
      return
    }
    // Decode off the main actor on URLSession's background delegate queue.
    let image = UIImage(data: finished.data)
    finished.completion(image)
  }
}

/// `@MainActor` bridge owning `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter` for one `EngineMainDriver` (`#413`).
@MainActor
final class AetherNowPlayingBridge {
  private static let defaultSkipIntervalSeconds: Double = 10.0
  private static let supportedPlaybackRates: [NSNumber] = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]
  private static let maxArtworkBytes = 4 * 1024 * 1024

  private let infoCenter: MPNowPlayingInfoCenter
  private let commandCenter: MPRemoteCommandCenter
  private let actions: NowPlayingRemoteActions
  private let artworkDelegate: BoundedArtworkDelegate
  private let artworkSession: URLSession

  private var policy = NowPlayingPolicy()
  private var commandTokens: [(command: MPRemoteCommand, token: Any)] = []
  private var lastSnapshot: NowPlayingSnapshot?
  private var artworkGeneration = 0
  private var activeArtworkTask: URLSessionDataTask?
  private var attemptedArtworkUrl: URL?
  private var cachedArtworkUrl: URL?
  private var cachedArtwork: MPMediaItemArtwork?
  private var isDisposed = false

  init(
    actions: NowPlayingRemoteActions,
    infoCenter: MPNowPlayingInfoCenter = .default(),
    commandCenter: MPRemoteCommandCenter = .shared()
  ) {
    self.actions = actions
    self.infoCenter = infoCenter
    self.commandCenter = commandCenter

    let delegate = BoundedArtworkDelegate(maxBytes: Self.maxArtworkBytes)
    let config = URLSessionConfiguration.ephemeral
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    config.timeoutIntervalForRequest = 10
    config.timeoutIntervalForResource = 15
    config.httpMaximumConnectionsPerHost = 2
    self.artworkDelegate = delegate
    self.artworkSession = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)

    registerRemoteCommands()
    applyCapabilities(.disabled)
  }

  /// Stores or clears Now Playing metadata; re-evaluates immediately if playback is active.
  func setMetadata(_ metadata: NowPlayingMetadata?, playbackState: NowPlayingPlaybackState) {
    guard !isDisposed else { return }
    policy.setMetadata(metadata)
    if metadata == nil {
      cancelArtworkFetch(clearCache: true)
    }
    if playbackState.isActive {
      update(state: playbackState, force: true)
    }
  }

  /// Evaluates a playback state update against `NowPlayingPolicy` and publishes or clears system state.
  func update(state: NowPlayingPlaybackState, force: Bool = false) {
    guard !isDisposed else { return }
    let nowSeconds = ProcessInfo.processInfo.systemUptime
    switch policy.evaluate(state: state, nowSeconds: nowSeconds, force: force) {
    case .unchanged:
      break
    case .clear:
      clearPlaybackState()
    case let .publish(snapshot):
      applySnapshot(snapshot)
    }
  }

  /// Clears active Now Playing info and disables all remote commands while preserving configured metadata.
  func clear() {
    guard !isDisposed else { return }
    policy.resetPlayback()
    clearPlaybackState()
  }

  /// Permanently tears down Now Playing info, removes every `MPRemoteCommandCenter` target, and cancels artwork fetches.
  func dispose() {
    guard !isDisposed else { return }
    isDisposed = true
    policy.setMetadata(nil)
    policy.resetPlayback()
    clearPlaybackState()
    cancelArtworkFetch(clearCache: true)
    artworkDelegate.cancelAll()
    artworkSession.invalidateAndCancel()
    for entry in commandTokens {
      entry.command.removeTarget(entry.token)
      entry.command.isEnabled = false
    }
    commandTokens.removeAll()
  }

  private func clearPlaybackState() {
    cancelArtworkFetch(clearCache: false)
    lastSnapshot = nil
    applyCapabilities(.disabled)
    infoCenter.nowPlayingInfo = nil
  }

  private func applySnapshot(_ snapshot: NowPlayingSnapshot) {
    lastSnapshot = snapshot
    applyCapabilities(snapshot.capabilities)
    syncArtwork(for: snapshot.artworkUrl)
    publishNowPlayingInfo(for: snapshot)
  }

  private func publishNowPlayingInfo(for snapshot: NowPlayingSnapshot) {
    var info: [String: Any] = [
      MPMediaItemPropertyTitle: snapshot.title,
      MPNowPlayingInfoPropertyIsLiveStream: snapshot.isLive,
      MPNowPlayingInfoPropertyPlaybackRate: snapshot.playbackRate,
      MPNowPlayingInfoPropertyDefaultPlaybackRate: snapshot.defaultPlaybackRate,
    ]
    if let subtitle = snapshot.subtitle {
      info[MPMediaItemPropertyArtist] = subtitle
    }
    if let elapsed = snapshot.elapsedPlaybackTime {
      info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
    }
    if let duration = snapshot.duration {
      info[MPMediaItemPropertyPlaybackDuration] = duration
    }
    if let artwork = cachedArtwork, cachedArtworkUrl == snapshot.artworkUrl {
      info[MPMediaItemPropertyArtwork] = artwork
    }
    infoCenter.nowPlayingInfo = info
  }

  private func syncArtwork(for url: URL?) {
    guard let url else {
      cancelArtworkFetch(clearCache: true)
      return
    }
    if attemptedArtworkUrl == url {
      return
    }
    if cachedArtworkUrl == url, cachedArtwork != nil || activeArtworkTask != nil {
      return
    }
    cancelArtworkFetch(clearCache: true)
    attemptedArtworkUrl = url
    cachedArtworkUrl = url
    artworkGeneration &+= 1
    let generation = artworkGeneration

    var request = URLRequest(url: url)
    request.cachePolicy = .reloadIgnoringLocalCacheData
    request.timeoutInterval = 10

    let task = artworkSession.dataTask(with: request)
    activeArtworkTask = task
    artworkDelegate.register(taskId: task.taskIdentifier) { [weak self] image in
      AetherBackend.onMainActor { [weak self] in
        guard let self,
              !self.isDisposed,
              self.artworkGeneration == generation,
              self.cachedArtworkUrl == url
        else { return }
        self.activeArtworkTask = nil
        guard let image else { return }
        self.cachedArtwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
        if let activeSnapshot = self.lastSnapshot, activeSnapshot.artworkUrl == url {
          self.publishNowPlayingInfo(for: activeSnapshot)
        }
      }
    }
    task.resume()
  }

  private func cancelArtworkFetch(clearCache: Bool) {
    artworkGeneration &+= 1
    if let task = activeArtworkTask {
      artworkDelegate.cancel(taskId: task.taskIdentifier)
      task.cancel()
      activeArtworkTask = nil
      attemptedArtworkUrl = nil
    }
    if clearCache {
      attemptedArtworkUrl = nil
      cachedArtworkUrl = nil
      cachedArtwork = nil
    }
  }

  private func registerRemoteCommands() {
    commandCenter.skipForwardCommand.preferredIntervals = [NSNumber(value: Self.defaultSkipIntervalSeconds)]
    commandCenter.skipBackwardCommand.preferredIntervals = [NSNumber(value: Self.defaultSkipIntervalSeconds)]
    commandCenter.changePlaybackRateCommand.supportedPlaybackRates = Self.supportedPlaybackRates

    register(commandCenter.playCommand) { [weak self] _ in
      guard let self else { return .commandFailed }
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onPlay()
      }
      return .success
    }

    register(commandCenter.pauseCommand) { [weak self] _ in
      guard let self else { return .commandFailed }
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onPause()
      }
      return .success
    }

    register(commandCenter.togglePlayPauseCommand) { [weak self] _ in
      guard let self else { return .commandFailed }
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onTogglePlayPause()
      }
      return .success
    }

    register(commandCenter.stopCommand) { [weak self] _ in
      guard let self else { return .commandFailed }
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onStop()
      }
      return .success
    }

    register(commandCenter.skipForwardCommand) { [weak self] event in
      guard let self else { return .commandFailed }
      let raw = (event as? MPSkipIntervalCommandEvent)?.interval ?? Self.defaultSkipIntervalSeconds
      let delta = (raw.isFinite && raw > 0) ? raw : Self.defaultSkipIntervalSeconds
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onSkipBy(delta)
      }
      return .success
    }

    register(commandCenter.skipBackwardCommand) { [weak self] event in
      guard let self else { return .commandFailed }
      let raw = (event as? MPSkipIntervalCommandEvent)?.interval ?? Self.defaultSkipIntervalSeconds
      let delta = (raw.isFinite && raw > 0) ? raw : Self.defaultSkipIntervalSeconds
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onSkipBy(-delta)
      }
      return .success
    }

    register(commandCenter.changePlaybackPositionCommand) { [weak self] event in
      guard let self, let positionEvent = event as? MPChangePlaybackPositionCommandEvent else {
        return .commandFailed
      }
      let target = positionEvent.positionTime
      guard target.isFinite else { return .commandFailed }
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onSeekTo(max(0, target))
      }
      return .success
    }

    register(commandCenter.changePlaybackRateCommand) { [weak self] event in
      guard let self, let rateEvent = event as? MPChangePlaybackRateCommandEvent else {
        return .commandFailed
      }
      let rate = Double(rateEvent.playbackRate)
      guard rate.isFinite, rate > 0 else { return .commandFailed }
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onChangeRate(rate)
      }
      return .success
    }

    register(commandCenter.nextTrackCommand) { [weak self] _ in
      guard let self else { return .commandFailed }
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onNextTrack()
      }
      return .success
    }

    register(commandCenter.previousTrackCommand) { [weak self] _ in
      guard let self else { return .commandFailed }
      AetherBackend.onMainActor { [weak self] in
        guard let self, !self.isDisposed else { return }
        self.actions.onPreviousTrack()
      }
      return .success
    }
  }

  private func register(
    _ command: MPRemoteCommand,
    handler: @escaping (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus
  ) {
    let token = command.addTarget(handler: handler)
    commandTokens.append((command: command, token: token))
  }

  private func applyCapabilities(_ capabilities: NowPlayingCommandCapabilities) {
    commandCenter.playCommand.isEnabled = capabilities.play
    commandCenter.pauseCommand.isEnabled = capabilities.pause
    commandCenter.togglePlayPauseCommand.isEnabled = capabilities.togglePlayPause
    commandCenter.stopCommand.isEnabled = capabilities.stop
    commandCenter.skipForwardCommand.isEnabled = capabilities.skipForward
    commandCenter.skipBackwardCommand.isEnabled = capabilities.skipBackward
    commandCenter.changePlaybackPositionCommand.isEnabled = capabilities.changePlaybackPosition
    commandCenter.changePlaybackRateCommand.isEnabled = capabilities.changePlaybackRate
    commandCenter.nextTrackCommand.isEnabled = capabilities.nextTrack
    commandCenter.previousTrackCommand.isEnabled = capabilities.previousTrack
  }
}

import Foundation

/// Thread-safe FIFO command-epoch, attempt-token, and rebuild state machine bridging JS calls to `@MainActor`.
public final class CommandFence: @unchecked Sendable {
  public enum MediaAction: Equatable, Sendable {
    case superseded
    case run(epoch: Int, rebuildFirst: Bool)
  }

  public enum RecreateAction: Equatable, Sendable {
    case superseded
    case run(epoch: Int)
  }

  private let lock = NSLock()
  private var isDisposed = false
  private var mediaEpoch = 0
  private var token = 0
  private var pendingRebuild = false

  public init() {}

  public var isDisposedNow: Bool {
    lock.withLock { isDisposed }
  }

  /// Records a JS `load` command, advancing `mediaEpoch` while preserving any unconsumed `recreate` request.
  public func recordLoad(attempt: Int) -> Int? {
    lock.withLock {
      guard !isDisposed else { return nil }
      mediaEpoch += 1
      token = attempt
      return mediaEpoch
    }
  }

  /// Records a JS `retry` command, advancing `mediaEpoch` while adopting a newer `attempt` token.
  public func recordRetry(attempt: Int) -> Int? {
    lock.withLock {
      guard !isDisposed else { return nil }
      mediaEpoch += 1
      if attempt > token { token = attempt }
      return mediaEpoch
    }
  }

  /// Records an in-epoch command (`play`, `pause`, `seek`, `selectAudioTrack`, `selectSubtitleTrack`).
  public func recordInEpochCommand(attempt: Int) -> Int? {
    lock.withLock {
      guard !isDisposed else { return nil }
      if attempt > token { token = attempt }
      return mediaEpoch
    }
  }

  /// Records a JS `stop` command, advancing `mediaEpoch` to cancel superseded loads.
  public func recordStop(attempt: Int) -> Int? {
    lock.withLock {
      guard !isDisposed else { return nil }
      mediaEpoch += 1
      if attempt > token { token = attempt }
      return mediaEpoch
    }
  }

  /// Records a JS `recreate` command, arming `pendingRebuild` until executed by `recreate` or the next active `load`/`retry`.
  public func recordRecreate(attempt: Int) -> Int? {
    lock.withLock {
      guard !isDisposed else { return nil }
      mediaEpoch += 1
      if attempt > token { token = attempt }
      pendingRebuild = true
      return mediaEpoch
    }
  }

  /// Marks the engine permanently disposed; returns `true` only on the first call.
  public func markDisposed() -> Bool {
    lock.withLock {
      if isDisposed { return false }
      isDisposed = true
      mediaEpoch += 1
      pendingRebuild = false
      return true
    }
  }

  /// Evaluates whether a queued `load` or `retry` for `epoch` should run on `@MainActor`, consuming `pendingRebuild`.
  public func beginMedia(epoch: Int) -> MediaAction {
    lock.withLock {
      guard !isDisposed, mediaEpoch == epoch else { return .superseded }
      let rebuildFirst = pendingRebuild
      pendingRebuild = false
      return .run(epoch: epoch, rebuildFirst: rebuildFirst)
    }
  }

  /// Returns `true` when an in-epoch command queued for `epoch` still belongs to the active `mediaEpoch`.
  public func beginInEpoch(epoch: Int) -> Bool {
    lock.withLock {
      !isDisposed && mediaEpoch == epoch
    }
  }

  /// Returns `true` when a queued `stop` may execute (not yet disposed).
  public func canRunStop() -> Bool {
    lock.withLock { !isDisposed }
  }

  /// Evaluates a standalone `recreate` block on `@MainActor`; defers to a newer queued `load`/`retry` when superseded.
  public func beginRecreate(epoch: Int) -> RecreateAction {
    lock.withLock {
      guard !isDisposed, mediaEpoch == epoch, pendingRebuild else { return .superseded }
      pendingRebuild = false
      return .run(epoch: epoch)
    }
  }

  /// Filters and stamps outbound `EngineEventOut` events before `SharedObject.emit`.
  /// `.surface` always adopts the latest token; `.tracks` fences on `mediaEpoch` and adopts the latest
  /// in-epoch token so `pause`/`play`/`seek` never drop deduplicated track snapshots.
  public func filterOutbound(_ event: EngineEventOut, driverEpoch: Int) -> EngineEventOut? {
    let snapshot: (disposed: Bool, epoch: Int, token: Int) = lock.withLock {
      (isDisposed, mediaEpoch, token)
    }
    guard !snapshot.disposed else { return nil }

    switch event {
    case let .surface(_, change):
      return .surface(attempt: snapshot.token, change: change)
    case let .tracks(_, tracks):
      guard driverEpoch == snapshot.epoch else { return nil }
      return .tracks(attempt: snapshot.token, tracks: tracks)
    case let .mediaInfo(_, info):
      guard driverEpoch == snapshot.epoch else { return nil }
      return .mediaInfo(attempt: snapshot.token, info: info)
    case let .state(attempt, _),
      let .firstFrame(attempt, _),
      let .clock(attempt, _),
      let .stall(attempt, _, _),
      let .progress(attempt, _, _),
      let .error(attempt, _):
      guard driverEpoch == snapshot.epoch, attempt == snapshot.token else { return nil }
      return event
    }
  }
}

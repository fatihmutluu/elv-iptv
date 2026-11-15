import ElvAetherCore
import Foundation

struct RebuildFailureError: Error {}

@MainActor
final class FakeBackend: PlayerBackend {
  enum Call: Equatable {
    case start(MediaPlan, EngineLoadOptions, Int)
    case stopMedia
    case play
    case pause
    case seek(Double)
    case rebuild
    case dispose
  }

  var calls: [Call] = []
  var shouldFailRebuild = false

  func start(_ plan: MediaPlan, options: EngineLoadOptions, serial: Int) {
    calls.append(.start(plan, options, serial))
  }

  func stopMedia() {
    calls.append(.stopMedia)
  }

  func play() {
    calls.append(.play)
  }

  func pause() {
    calls.append(.pause)
  }

  func seek(toSeconds: Double) {
    calls.append(.seek(toSeconds))
  }

  func rebuild() throws {
    calls.append(.rebuild)
    if shouldFailRebuild {
      throw RebuildFailureError()
    }
  }

  func dispose() {
    calls.append(.dispose)
  }
}

@MainActor
final class RecordingSink: EngineSink {
  var events: [EngineEventOut] = []
  var shutterHistory: [Bool] = []
  var screenOnHistory: [Bool] = []
  var shutterCovered = true
  var screenOn = false

  func send(_ event: EngineEventOut) {
    events.append(event)
  }

  func setShutter(covered: Bool) {
    shutterCovered = covered
    shutterHistory.append(covered)
  }

  func setKeepScreenOn(_ on: Bool) {
    screenOn = on
    screenOnHistory.append(on)
  }
}

@MainActor
final class FakeClock {
  var nowMs: Double = 1_000

  func uptimeMs() -> Double {
    nowMs
  }
}

/// Runs synchronous blocking test work (`NSCondition.wait()`, `DispatchSemaphore.wait()`, `Thread.sleep`)
/// on a dedicated GCD thread outside Swift Concurrency's cooperative pool so narrow-vCPU CI runners
/// (`macos-26`, 3 vCPUs) never starve cooperative continuations.
final class BlockingCall<T: Sendable>: @unchecked Sendable {
  private let lock = NSLock()
  private var result: T?
  private var waiter: CheckedContinuation<T, Never>?

  private init() {}

  static func start(
    label: String = "elv.test.blocking",
    _ work: @escaping @Sendable () -> T
  ) async -> BlockingCall<T> {
    let call = BlockingCall<T>()
    await withCheckedContinuation { (entered: CheckedContinuation<Void, Never>) in
      DispatchQueue(label: label).async {
        entered.resume()
        let value = work()
        let cont: CheckedContinuation<T, Never>? = call.lock.withLock {
          if let w = call.waiter {
            call.waiter = nil
            return w
          }
          call.result = value
          return nil
        }
        cont?.resume(returning: value)
      }
    }
    return call
  }

  func value() async -> T {
    await withCheckedContinuation { cont in
      let ready: T? = lock.withLock {
        if let r = result {
          return r
        }
        waiter = cont
        return nil
      }
      if let ready {
        cont.resume(returning: ready)
      }
    }
  }
}

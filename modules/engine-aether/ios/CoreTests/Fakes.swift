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

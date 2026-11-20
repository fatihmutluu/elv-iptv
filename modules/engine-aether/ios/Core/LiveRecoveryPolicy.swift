import Foundation

/// Bounded in-place live replay recovery policy (`1s / 2s / 4s`, max 3 attempts per 60s window, reset on clock progress).
public struct LiveRecoveryPolicy: Equatable, Sendable {
  public enum Decision: Equatable, Sendable {
    case retryAfter(delayMs: Double)
    case coalesceInFlight
    case escalate
  }

  private let backoffDelaysMs: [Double]
  private let windowMs: Double
  private var attemptTimestampsMs: [Double] = []
  private var recoveryInFlight = false
  private var lastProgressPositionSeconds: Double?

  public init(
    backoffDelaysMs: [Double] = [1_000, 2_000, 4_000],
    windowMs: Double = 60_000
  ) {
    self.backoffDelaysMs = backoffDelaysMs
    self.windowMs = max(1, windowMs)
  }

  public mutating func reset() {
    attemptTimestampsMs.removeAll()
    recoveryInFlight = false
    lastProgressPositionSeconds = nil
  }

  /// Resets the retry budget once playing media genuinely advances its presentation clock.
  public mutating func noteClockProgress(positionSeconds: Double, isPlaying: Bool) {
    guard isPlaying, positionSeconds.isFinite else { return }
    if let previous = lastProgressPositionSeconds {
      if positionSeconds > previous + 0.25 {
        attemptTimestampsMs.removeAll()
        recoveryInFlight = false
        lastProgressPositionSeconds = positionSeconds
      }
    } else {
      lastProgressPositionSeconds = positionSeconds
    }
  }

  /// Decides whether to schedule an in-place `retryLiveSourceRecovery()`, coalesce, or escalate immediately (`0 ms`).
  public mutating func nextAction(atMs nowMs: Double) -> Decision {
    attemptTimestampsMs.removeAll { nowMs - $0 > windowMs }
    if recoveryInFlight {
      return .coalesceInFlight
    }
    guard attemptTimestampsMs.count < backoffDelaysMs.count else {
      return .escalate
    }
    let delayMs = backoffDelaysMs[attemptTimestampsMs.count]
    attemptTimestampsMs.append(nowMs)
    recoveryInFlight = true
    lastProgressPositionSeconds = nil
    return .retryAfter(delayMs: delayMs)
  }

  /// Marks the scheduled retry dispatched so subsequent exhaustion signals can advance to the next rung.
  public mutating func noteRetryDispatched(accepted: Bool) {
    recoveryInFlight = false
    if !accepted {
      lastProgressPositionSeconds = nil
    }
  }
}

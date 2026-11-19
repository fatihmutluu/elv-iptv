import ElvAetherCore
import Testing

@Suite("LiveRecoveryPolicy")
struct LiveRecoveryPolicyTests {
  @Test("steps through 1s, 2s, 4s backoff and escalates on the 4th attempt within 60s")
  func backoffLadderAndCap() {
    var policy = LiveRecoveryPolicy()

    #expect(policy.nextAction(atMs: 1_000) == .retryAfter(delayMs: 1_000))
    // Duplicate exhaustion while sleep is in flight coalesces without burning a rung.
    #expect(policy.nextAction(atMs: 1_200) == .coalesceInFlight)
    policy.noteRetryDispatched(accepted: true)

    #expect(policy.nextAction(atMs: 5_000) == .retryAfter(delayMs: 2_000))
    policy.noteRetryDispatched(accepted: true)

    #expect(policy.nextAction(atMs: 12_000) == .retryAfter(delayMs: 4_000))
    policy.noteRetryDispatched(accepted: true)

    // 4th attempt inside the 60s rolling window escalates immediately.
    #expect(policy.nextAction(atMs: 25_000) == .escalate)
  }

  @Test("attempts older than 60s age out of the rolling window")
  func rollingWindowExpiresOldAttempts() {
    var policy = LiveRecoveryPolicy()
    for t in [1_000.0, 4_000.0, 10_000.0] {
      _ = policy.nextAction(atMs: t)
      policy.noteRetryDispatched(accepted: true)
    }

    // At 62s, the 1_000 ms attempt (> 60s ago) aged out, leaving 2 attempts in window -> 4_000 ms rung.
    #expect(policy.nextAction(atMs: 62_000) == .retryAfter(delayMs: 4_000))
    policy.noteRetryDispatched(accepted: true)

    // At 130s, all earlier attempts aged out -> starts fresh at 1_000 ms.
    #expect(policy.nextAction(atMs: 130_000) == .retryAfter(delayMs: 1_000))
  }

  @Test("clock progress while playing resets the recovery budget")
  func clockProgressResetsBudget() {
    var policy = LiveRecoveryPolicy()
    _ = policy.nextAction(atMs: 1_000)
    policy.noteRetryDispatched(accepted: true)
    _ = policy.nextAction(atMs: 4_000)
    policy.noteRetryDispatched(accepted: true)

    policy.noteClockProgress(positionSeconds: 10.0, isPlaying: true)
    policy.noteClockProgress(positionSeconds: 10.5, isPlaying: true)

    #expect(policy.nextAction(atMs: 8_000) == .retryAfter(delayMs: 1_000))
  }
}

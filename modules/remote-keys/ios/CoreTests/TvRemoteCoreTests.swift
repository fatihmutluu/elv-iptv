import ElvRemoteKeysCore
import Foundation
import Testing

@Suite("TvPressKeyMap & DirectionalPanPolicy (#414, #225)")
struct TvRemoteCoreTests {
  @Test("maps all supported ApplePressKind values to canonical key codes matching ui-kit")
  func mapsCanonicalKeyCodes() {
    #expect(canonicalKeyCode(for: .upArrow) == 19)
    #expect(canonicalKeyCode(for: .downArrow) == 20)
    #expect(canonicalKeyCode(for: .leftArrow) == 21)
    #expect(canonicalKeyCode(for: .rightArrow) == 22)
    #expect(canonicalKeyCode(for: .select) == 23)
    #expect(canonicalKeyCode(for: .menu) == 4)
    #expect(canonicalKeyCode(for: .playPause) == 85)
    #expect(canonicalKeyCode(for: .pageUp) == 92)
    #expect(canonicalKeyCode(for: .pageDown) == 93)
  }

  @Test("ApplePressTracker deduplicates downs, ignores orphan ups, and flushes held keys on blur")
  func tracksPressesAndBlursCleanly() {
    var tracker = ApplePressTracker()
    #expect(tracker.heldCount == 0)

    // Orphan up is ignored.
    #expect(tracker.pressEnded(.select, canceled: false, eventTimeMs: 100) == nil)

    // First down emits; duplicate down is ignored.
    let down = tracker.pressBegan(.downArrow, eventTimeMs: 1_000)
    #expect(down == AppleRemoteKeyEvent(action: .down, keyCode: 20, canceled: false, eventTimeMs: 1_000))
    #expect(tracker.heldCount == 1)
    #expect(tracker.pressBegan(.downArrow, eventTimeMs: 1_050) == nil)
    #expect(tracker.heldCount == 1)

    // Independent simultaneous key tracks separately.
    let menuDown = tracker.pressBegan(.menu, eventTimeMs: 1_100)
    #expect(menuDown == AppleRemoteKeyEvent(action: .down, keyCode: 4, canceled: false, eventTimeMs: 1_100))
    #expect(tracker.heldCount == 2)

    // Release emits up with canceled flag; second release is ignored.
    let up = tracker.pressEnded(.downArrow, canceled: true, eventTimeMs: 1_200)
    #expect(up == AppleRemoteKeyEvent(action: .up, keyCode: 20, canceled: true, eventTimeMs: 1_200))
    #expect(tracker.heldCount == 1)
    #expect(tracker.pressEnded(.downArrow, canceled: false, eventTimeMs: 1_210) == nil)

    // Blur flushes remaining held keys so subsequent orphan ups are ignored.
    let blur = tracker.handleBlur()
    #expect(blur == AppleRemoteKeyEvent(action: .blur))
    #expect(tracker.heldCount == 0)
    #expect(tracker.pressEnded(.menu, canceled: false, eventTimeMs: 1_300) == nil)

    // After blur, a fresh press succeeds immediately.
    let playDown = tracker.pressBegan(.playPause, eventTimeMs: 1_400)
    #expect(playDown == AppleRemoteKeyEvent(action: .down, keyCode: 85, canceled: false, eventTimeMs: 1_400))
  }

  @Test("DirectionalPanPolicy suppresses all gestures while disabled and cancels active pan on disable")
  func suppressesWhenDisabled() {
    var policy = DirectionalPanPolicy(deadzonePoints: 18.0, dominanceRatio: 1.35, isEnabled: false)
    #expect(policy.update(state: .began, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0) == nil)
    #expect(policy.update(state: .changed, translationX: 60, translationY: 0, velocityX: 120, velocityY: 0) == nil)
    #expect(policy.lockedAxis == nil)

    #expect(policy.setEnabled(true) == nil)
    let began = policy.update(state: .changed, translationX: 30, translationY: 5, velocityX: 200, velocityY: 10)
    #expect(began == DirectionalPanEvent(axis: .horizontal, phase: .began, translation: 30, velocity: 200))

    // Disabling mid-pan emits a clean cancellation and resets lock.
    let cancelled = policy.setEnabled(false)
    #expect(cancelled == DirectionalPanEvent(axis: .horizontal, phase: .cancelled, translation: 30, velocity: 0))
    #expect(policy.lockedAxis == nil)
    #expect(policy.update(state: .ended, translationX: 40, translationY: 5, velocityX: 10, velocityY: 0) == nil)
  }

  @Test("DirectionalPanPolicy enforces deadzone + 1.35x dominance ratio and ignores orthogonal drift once locked")
  func locksAxisAndIgnoresOrthogonalDrift() {
    var policy = DirectionalPanPolicy(deadzonePoints: 18.0, dominanceRatio: 1.35, isEnabled: true)

    // Inside deadzone -> suppressed.
    #expect(policy.update(state: .began, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0) == nil)
    #expect(policy.update(state: .changed, translationX: 17.5, translationY: 2.0, velocityX: 50, velocityY: 5) == nil)

    // Ambiguous diagonal beyond deadzone (20 / 16 = 1.25 < 1.35) -> still unlocked.
    #expect(policy.update(state: .changed, translationX: 20.0, translationY: 16.0, velocityX: 60, velocityY: 50) == nil)
    #expect(policy.lockedAxis == nil)

    // Horizontal dominance achieved (25 >= 16 * 1.35 = 21.6) -> locks horizontal and emits began.
    let began = policy.update(state: .changed, translationX: 25.0, translationY: 16.0, velocityX: 140, velocityY: 20)
    #expect(began == DirectionalPanEvent(axis: .horizontal, phase: .began, translation: 25.0, velocity: 140))
    #expect(policy.lockedAxis == .horizontal)

    // Large vertical drift after horizontal lock never switches axis or emits vertical events.
    let changed = policy.update(state: .changed, translationX: 70.0, translationY: 180.0, velocityX: 300, velocityY: 600)
    #expect(changed == DirectionalPanEvent(axis: .horizontal, phase: .changed, translation: 70.0, velocity: 300))
    #expect(policy.lockedAxis == .horizontal)

    let ended = policy.update(state: .ended, translationX: 92.0, translationY: 210.0, velocityX: 80, velocityY: 400)
    #expect(ended == DirectionalPanEvent(axis: .horizontal, phase: .ended, translation: 92.0, velocity: 80))
    #expect(policy.lockedAxis == nil)
  }

  @Test("DirectionalPanPolicy locks vertical axis cleanly and drops unlocked ended/cancelled gestures")
  func locksVerticalAndDropsUnlockedEnd() {
    var policy = DirectionalPanPolicy(deadzonePoints: 18.0, dominanceRatio: 1.35, isEnabled: true)

    // End before crossing deadzone emits nothing.
    #expect(policy.update(state: .began, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0) == nil)
    #expect(policy.update(state: .changed, translationX: 4, translationY: 10, velocityX: 0, velocityY: 10) == nil)
    #expect(policy.update(state: .ended, translationX: 4, translationY: 10, velocityX: 0, velocityY: 0) == nil)

    // Vertical upward swipe locks .vertical and ignores horizontal drift.
    #expect(policy.update(state: .began, translationX: 0, translationY: 0, velocityX: 0, velocityY: 0) == nil)
    let began = policy.update(state: .changed, translationX: 10.0, translationY: -24.0, velocityX: 15, velocityY: -220)
    #expect(began == DirectionalPanEvent(axis: .vertical, phase: .began, translation: -24.0, velocity: -220))

    let cancelled = policy.update(state: .cancelled, translationX: 90.0, translationY: -50.0, velocityX: 400, velocityY: -100)
    #expect(cancelled == DirectionalPanEvent(axis: .vertical, phase: .cancelled, translation: -50.0, velocity: -100))
    #expect(policy.lockedAxis == nil)
  }
}

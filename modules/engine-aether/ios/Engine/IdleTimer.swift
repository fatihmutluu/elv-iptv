import UIKit

/// Process-wide reference set driving `UIApplication.shared.isIdleTimerDisabled` and re-asserting it on foreground return.
@MainActor
enum IdleTimer {
  private static var activeOwners = Set<ObjectIdentifier>()
  private static var observersInstalled = false
  private static var observerTokens: [NSObjectProtocol] = []

  static func setHeld(_ held: Bool, ownerId: ObjectIdentifier) {
    ensureObserversInstalled()
    if held {
      activeOwners.insert(ownerId)
    } else {
      activeOwners.remove(ownerId)
    }
    UIApplication.shared.isIdleTimerDisabled = !activeOwners.isEmpty
  }

  static func setHeld(_ held: Bool, owner: AnyObject) {
    setHeld(held, ownerId: ObjectIdentifier(owner))
  }

  private static func ensureObserversInstalled() {
    guard !observersInstalled else { return }
    observersInstalled = true
    let center = NotificationCenter.default
    let reassert: @Sendable (Notification) -> Void = { _ in
      AetherBackend.onMainActor {
        if !IdleTimer.activeOwners.isEmpty {
          UIApplication.shared.isIdleTimerDisabled = true
        }
      }
    }
    observerTokens = [
      center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main, using: reassert),
      center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main, using: reassert),
    ]
  }
}

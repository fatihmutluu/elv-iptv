import UIKit

/// Process-wide reference set driving `UIApplication.shared.isIdleTimerDisabled`.
@MainActor
enum IdleTimer {
  private static var activeOwners = Set<ObjectIdentifier>()

  static func setHeld(_ held: Bool, ownerId: ObjectIdentifier) {
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
}

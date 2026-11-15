import UIKit

/// Process-wide reference set driving `UIApplication.shared.isIdleTimerDisabled`.
@MainActor
enum IdleTimer {
  private static var activeOwners = Set<ObjectIdentifier>()

  static func setHeld(_ held: Bool, owner: AnyObject) {
    let id = ObjectIdentifier(owner)
    if held {
      activeOwners.insert(id)
    } else {
      activeOwners.remove(id)
    }
    UIApplication.shared.isIdleTimerDisabled = !activeOwners.isEmpty
  }
}

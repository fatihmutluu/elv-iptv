import Foundation

/// Purge-safe Apple key-value bridge (`#79`, ADR 0014): prefers iCloud `NSUbiquitousKeyValueStore` (`<= 900 KB`)
/// when entitled and signed in, while always mirroring a byte-safe copy (`<= 384 KB`) to `NSUserDefaults.standard`.
enum ApplePersistentKVStore {
  /// Cached provisioning-profile check so development builds without the iCloud KVS entitlement never touch `NSUbiquitousKeyValueStore`.
  /// App Store, TestFlight, and Simulator builds omit `embedded.mobileprovision` and rely on `ubiquityIdentityToken`.
  private static let provisionedAllowsKvs: Bool = {
    guard let profileUrl = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
          let data = try? Data(contentsOf: profileUrl)
    else {
      return true
    }
    let needle = Data("com.apple.developer.ubiquity-kvstore-identifier".utf8)
    return data.range(of: needle) != nil
  }()

  /// Returns `true` when iCloud KVS is safely usable (entitled provisioning profile when present AND signed-in `ubiquityIdentityToken`).
  static func isCloudKvsAvailable() -> Bool {
    provisionedAllowsKvs && FileManager.default.ubiquityIdentityToken != nil
  }

  /// Reads the non-empty string value for `key` from iCloud KVS when available, falling back to `UserDefaults.standard`.
  static func read(key: String) -> String? {
    guard !key.isEmpty else { return nil }
    let cloudValue: String?
    if isCloudKvsAvailable() {
      cloudValue = NSUbiquitousKeyValueStore.default.string(forKey: key)
    } else {
      cloudValue = nil
    }
    let localValue = UserDefaults.standard.string(forKey: key)
    return selectPersistentReadValue(cloudValue: cloudValue, localValue: localValue)
  }

  /// Writes `value` under `key` to iCloud KVS (when available and `<= 900 KB`) and mirrors to `UserDefaults.standard`
  /// strictly when `<= 384 KB` so tvOS never hits `NSUserDefaultsSizeLimitExceededNotification` (`500 KB`).
  static func write(key: String, value: String) -> Bool {
    guard !key.isEmpty else { return false }
    var wrote = false

    if isCloudKvsAvailable() && validatePersistentWrite(value: value, maxBytes: appleCloudKvsMaxBytes) {
      let cloud = NSUbiquitousKeyValueStore.default
      cloud.set(value, forKey: key)
      if cloud.synchronize() {
        wrote = true
      }
    }

    if validatePersistentWrite(value: value, maxBytes: appleLocalUserDefaultsMaxBytes) {
      UserDefaults.standard.set(value, forKey: key)
      wrote = true
    }

    return wrote
  }

  /// Writes a strictly byte-clamped (`<= 384 KB`) snapshot exclusively to `UserDefaults.standard`
  /// so local purge-recovery mirrors stay fresh even when an iCloud snapshot exceeds `384 KB` (`#79`).
  static func writeLocal(key: String, value: String) -> Bool {
    guard !key.isEmpty, validatePersistentWrite(value: value, maxBytes: appleLocalUserDefaultsMaxBytes) else {
      return false
    }
    UserDefaults.standard.set(value, forKey: key)
    return true
  }

  /// Active UTF-8 byte ceiling (`900 KB` with iCloud KVS, `384 KB` local-only).
  static func budgetBytes() -> Int {
    effectivePersistentBudgetBytes(cloudAvailable: isCloudKvsAvailable())
  }
}

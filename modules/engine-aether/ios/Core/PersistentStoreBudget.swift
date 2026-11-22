import Foundation

/// Allocated `NSUserDefaults` byte ceiling for local purge-safe user state (`384 KB`, leaving >100 KB headroom under tvOS's 500 KB cap, `#79`).
public let appleLocalUserDefaultsMaxBytes: Int = 393_216

/// Allocated `NSUbiquitousKeyValueStore` byte ceiling when iCloud KVS is entitled and available (`900 KB`, `#79`).
public let appleCloudKvsMaxBytes: Int = 921_600

/// Returns `true` when `value`'s UTF-8 byte length fits strictly within a positive `maxBytes` budget.
public func validatePersistentWrite(value: String, maxBytes: Int) -> Bool {
  guard maxBytes > 0 else { return false }
  return value.utf8.count <= maxBytes
}

/// Selects the non-empty iCloud KVS snapshot when present, falling back to the local `NSUserDefaults` snapshot.
public func selectPersistentReadValue(cloudValue: String?, localValue: String?) -> String? {
  if let cloudValue, !cloudValue.isEmpty {
    return cloudValue
  }
  if let localValue, !localValue.isEmpty {
    return localValue
  }
  return nil
}

/// Returns the active UTF-8 payload byte budget for the current iCloud KVS availability state.
public func effectivePersistentBudgetBytes(cloudAvailable: Bool) -> Int {
  cloudAvailable ? appleCloudKvsMaxBytes : appleLocalUserDefaultsMaxBytes
}

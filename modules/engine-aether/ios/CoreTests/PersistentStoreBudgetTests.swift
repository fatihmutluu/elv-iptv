import ElvAetherCore
import Foundation
import Testing

@Suite("PersistentStoreBudget (#79)")
struct PersistentStoreBudgetTests {
  @Test("storage ceilings match ADR 0014 local (384 KB) and iCloud KVS (900 KB) limits")
  func budgetConstantsMatchAdr0014() {
    #expect(appleLocalUserDefaultsMaxBytes == 393_216)
    #expect(appleCloudKvsMaxBytes == 921_600)
    #expect(effectivePersistentBudgetBytes(cloudAvailable: false) == 393_216)
    #expect(effectivePersistentBudgetBytes(cloudAvailable: true) == 921_600)
  }

  @Test("validatePersistentWrite enforces exact UTF-8 byte length including multi-byte characters")
  func validatePersistentWriteUsesUtf8ByteCount() {
    let exactAscii = String(repeating: "a", count: 16)
    #expect(validatePersistentWrite(value: exactAscii, maxBytes: 16))
    #expect(!validatePersistentWrite(value: exactAscii + "b", maxBytes: 16))

    // Each Turkish 'ğ' is 2 bytes in UTF-8; 5 chars = 10 bytes.
    let multiByte = "ğğğğğ"
    #expect(multiByte.count == 5)
    #expect(multiByte.utf8.count == 10)
    #expect(validatePersistentWrite(value: multiByte, maxBytes: 10))
    #expect(!validatePersistentWrite(value: multiByte, maxBytes: 9))

    #expect(validatePersistentWrite(value: "", maxBytes: 1))
    #expect(!validatePersistentWrite(value: "", maxBytes: 0))
    #expect(!validatePersistentWrite(value: "ok", maxBytes: -1))
  }

  @Test("selectPersistentReadValue prefers non-empty cloud snapshot and falls back to local")
  func selectPersistentReadValuePrefersCloudWithLocalFallback() {
    #expect(selectPersistentReadValue(cloudValue: "{\"v\":1}", localValue: "{\"v\":0}") == "{\"v\":1}")
    #expect(selectPersistentReadValue(cloudValue: nil, localValue: "{\"v\":1}") == "{\"v\":1}")
    #expect(selectPersistentReadValue(cloudValue: "", localValue: "{\"v\":1}") == "{\"v\":1}")
    #expect(selectPersistentReadValue(cloudValue: nil, localValue: "") == nil)
    #expect(selectPersistentReadValue(cloudValue: "", localValue: nil) == nil)
    #expect(selectPersistentReadValue(cloudValue: nil, localValue: nil) == nil)
  }
}

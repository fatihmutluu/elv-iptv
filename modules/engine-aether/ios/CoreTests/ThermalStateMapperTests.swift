import ElvAetherCore
import Foundation
import Testing

@Suite("ThermalStateMapper (#232)")
struct ThermalStateMapperTests {
  @Test("maps ProcessInfo.ThermalState raw values and enum cases to normalized levels")
  func mapsThermalStateRawValues() {
    #expect(mapProcessInfoThermalState(rawValue: -1) == .nominal)
    #expect(mapProcessInfoThermalState(rawValue: 0) == .nominal)
    #expect(mapProcessInfoThermalState(rawValue: 1) == .fair)
    #expect(mapProcessInfoThermalState(rawValue: 2) == .serious)
    #expect(mapProcessInfoThermalState(rawValue: 3) == .critical)
    #expect(mapProcessInfoThermalState(rawValue: 4) == .critical)
    #expect(mapProcessInfoThermalState(rawValue: 99) == .critical)

    #expect(mapProcessInfoThermalState(.nominal).rawValue == "nominal")
    #expect(mapProcessInfoThermalState(.fair).rawValue == "fair")
    #expect(mapProcessInfoThermalState(.serious).rawValue == "serious")
    #expect(mapProcessInfoThermalState(.critical).rawValue == "critical")
  }

  @Test("resolves Apple Multi-View tile caps from physical RAM, constrained AppleTV models, and thermal state")
  func resolvesMultiViewTileCaps() {
    let oneGiB: UInt64 = 1_073_741_824
    let twoGiB: UInt64 = 2_147_483_648
    let threeGiB: UInt64 = 3_221_225_472
    let fourGiB: UInt64 = 4_294_967_296
    let eightGiB: UInt64 = 8_589_934_592

    // Low-RAM (< 1.5 GiB) disables Multi-View regardless of model or thermal level.
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "iPhone14,2", physicalMemoryBytes: 0, thermalLevel: .nominal) == 1)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "iPhone14,2", physicalMemoryBytes: oneGiB, thermalLevel: .nominal) == 1)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "iPhone14,2", physicalMemoryBytes: oneGiB, thermalLevel: .serious) == 1)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "iPhone14,2", physicalMemoryBytes: oneGiB, thermalLevel: .critical) == 1)

    // 2–3 GB devices (< 3.5 GiB) and constrained Apple TV models cap at 2 under nominal/fair/serious, 1 under critical.
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "AppleTV5,3", physicalMemoryBytes: twoGiB, thermalLevel: .nominal) == 2)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "AppleTV6,2", physicalMemoryBytes: threeGiB, thermalLevel: .fair) == 2)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "  AppleTV6,2  ", physicalMemoryBytes: fourGiB, thermalLevel: .nominal) == 2)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "AppleTV5,3", physicalMemoryBytes: fourGiB, thermalLevel: .nominal) == 2)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "AppleTV6,2", physicalMemoryBytes: threeGiB, thermalLevel: .serious) == 2)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "AppleTV6,2", physicalMemoryBytes: threeGiB, thermalLevel: .critical) == 1)

    // Higher-RAM devices (>= 3.5 GiB) allow 4 under nominal/fair, clamp to 2 under serious, shed to 1 under critical.
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "AppleTV14,1", physicalMemoryBytes: fourGiB, thermalLevel: .nominal) == 4)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "iPhone16,1", physicalMemoryBytes: eightGiB, thermalLevel: .fair) == 4)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "iPad14,1", physicalMemoryBytes: eightGiB, thermalLevel: .serious) == 2)
    #expect(resolveAppleMultiViewMaxTiles(deviceModel: "iPad14,1", physicalMemoryBytes: eightGiB, thermalLevel: .critical) == 1)
  }
}

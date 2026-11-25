import Foundation

/// Normalized Apple `ProcessInfo.ThermalState` levels shared across native observers and Multi-View clamps (`#232`).
public enum AppleThermalLevel: String, Equatable, CaseIterable, Sendable {
  case nominal
  case fair
  case serious
  case critical
}

private let appleLowRamThresholdBytes: UInt64 = 1_610_612_736 // 1.5 GiB
private let appleMidRamThresholdBytes: UInt64 = 3_758_096_384 // 3.5 GiB

private func isConstrainedAppleTvModel(_ deviceModel: String) -> Bool {
  let trimmed = deviceModel.trimmingCharacters(in: .whitespacesAndNewlines)
  return trimmed.hasPrefix("AppleTV5,") || trimmed.hasPrefix("AppleTV6,")
}

/// Maps a raw `ProcessInfo.ThermalState` integer (`0` nominal, `1` fair, `2` serious, `>= 3` critical)
/// into `AppleThermalLevel` (`#232`).
public func mapProcessInfoThermalState(rawValue: Int) -> AppleThermalLevel {
  switch rawValue {
  case ...0:
    return .nominal
  case 1:
    return .fair
  case 2:
    return .serious
  default:
    return .critical
  }
}

/// Maps `ProcessInfo.ThermalState` into `AppleThermalLevel` (`#232`).
public func mapProcessInfoThermalState(_ state: ProcessInfo.ThermalState) -> AppleThermalLevel {
  mapProcessInfoThermalState(rawValue: state.rawValue)
}

/// Resolves the maximum safe concurrent Multi-View tile count for an Apple device from its hardware
/// machine identifier, physical RAM size, and live thermal state (`#232`).
public func resolveAppleMultiViewMaxTiles(
  deviceModel: String,
  physicalMemoryBytes: UInt64,
  thermalLevel: AppleThermalLevel
) -> Int {
  let baseCap: Int
  if physicalMemoryBytes < appleLowRamThresholdBytes {
    baseCap = 1
  } else if physicalMemoryBytes < appleMidRamThresholdBytes || isConstrainedAppleTvModel(deviceModel) {
    baseCap = 2
  } else {
    baseCap = 4
  }

  switch thermalLevel {
  case .nominal, .fair:
    return baseCap
  case .serious:
    return min(baseCap, 2)
  case .critical:
    return 1
  }
}

import Foundation

/// Per-source IP address family preference forwarded from transport settings (`#172`).
public enum DnsFamilyPreference: String, Equatable, Sendable {
  case system
  case ipv4
  case ipv6

  /// Parses a raw JavaScript or configuration string (`"system"`, `"ipv4"`, `"ipv6"`),
  /// defaulting to `.system` when absent or unrecognized.
  public static func parse(_ raw: String?) -> DnsFamilyPreference {
    guard let raw else { return .system }
    let normalized = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return DnsFamilyPreference(rawValue: normalized) ?? .system
  }
}

/// Strict syntactic validator for dotted-quad IPv4 literals (rejects leading zeros, ports, whitespace, and non-ASCII).
public func isValidIpv4Literal(_ ip: String) -> Bool {
  guard !ip.isEmpty, ip.count <= 15 else { return false }
  let octets = ip.split(separator: ".", omittingEmptySubsequences: false)
  guard octets.count == 4 else { return false }

  for octet in octets {
    guard !octet.isEmpty, octet.count <= 3 else { return false }
    if octet.count > 1, octet.first == "0" {
      return false
    }
    var value = 0
    for byte in octet.utf8 {
      guard byte >= 0x30 && byte <= 0x39 else { return false }
      value = value * 10 + Int(byte - 0x30)
    }
    guard value <= 255 else { return false }
  }
  return true
}

/// Strict syntactic validator for unbracketed IPv6 literals (supports `::` compression and embedded IPv4 tails;
/// rejects zone IDs, ports, brackets, whitespace, and malformed colons).
public func isValidIpv6Literal(_ ip: String) -> Bool {
  guard !ip.isEmpty, ip.count <= 45 else { return false }
  for byte in ip.utf8 {
    let isHex =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x46) ||
      (byte >= 0x61 && byte <= 0x66)
    let isSeparator = byte == 0x3A || byte == 0x2E
    guard isHex || isSeparator else { return false }
  }
  if ip == "::" { return true }

  let leftGroups: [Substring]
  let rightGroups: [Substring]
  let hasCompression: Bool

  if let doubleColon = ip.range(of: "::") {
    let leftPart = ip[..<doubleColon.lowerBound]
    let rightPart = ip[doubleColon.upperBound...]
    if rightPart.range(of: "::") != nil {
      return false
    }
    hasCompression = true
    leftGroups = leftPart.isEmpty ? [] : leftPart.split(separator: ":", omittingEmptySubsequences: false)
    rightGroups = rightPart.isEmpty ? [] : rightPart.split(separator: ":", omittingEmptySubsequences: false)
  } else {
    hasCompression = false
    leftGroups = ip.split(separator: ":", omittingEmptySubsequences: false)
    rightGroups = []
  }

  for group in leftGroups where group.isEmpty { return false }
  for group in rightGroups where group.isEmpty { return false }

  let allGroups = leftGroups + rightGroups
  guard !allGroups.isEmpty else { return false }

  var hextetCount = 0
  for (index, group) in allGroups.enumerated() {
    let isLast = index == allGroups.count - 1
    if group.contains(".") {
      guard isLast, !hasCompression || !rightGroups.isEmpty else { return false }
      guard isValidIpv4Literal(String(group)) else { return false }
      hextetCount += 2
    } else {
      guard group.count >= 1, group.count <= 4 else { return false }
      for byte in group.utf8 {
        let isHex =
          (byte >= 0x30 && byte <= 0x39) ||
          (byte >= 0x41 && byte <= 0x46) ||
          (byte >= 0x61 && byte <= 0x66)
        guard isHex else { return false }
      }
      hextetCount += 1
    }
  }

  return hasCompression ? hextetCount < 8 : hextetCount == 8
}

/// Validates and normalizes an optional literal IPv4 or IPv6 `hostOverride` (`#172`).
/// Accepts strict IPv4 or IPv6 literals (stripping optional `[...]` around IPv6 and lowercasing hex digits),
/// and returns `nil` for empty strings, ports, schemes, hostnames, zone IDs, or control characters.
public func validateHostOverride(_ raw: String?) -> String? {
  guard let raw else { return nil }
  for scalar in raw.unicodeScalars {
    let v = scalar.value
    if v <= 0x1F || v >= 0x7F {
      return nil
    }
  }

  let trimmed = raw.trimmingCharacters(in: CharacterSet(charactersIn: " "))
  guard !trimmed.isEmpty, !trimmed.contains(" ") else { return nil }

  if trimmed.hasPrefix("[") || trimmed.hasSuffix("]") {
    guard trimmed.hasPrefix("["), trimmed.hasSuffix("]"), trimmed.count >= 4 else {
      return nil
    }
    let inner = String(trimmed.dropFirst().dropLast())
    guard isValidIpv6Literal(inner) else { return nil }
    return inner.lowercased()
  }

  if isValidIpv4Literal(trimmed) {
    return trimmed
  }
  if isValidIpv6Literal(trimmed) {
    return trimmed.lowercased()
  }
  return nil
}

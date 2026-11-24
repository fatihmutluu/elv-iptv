import Darwin
import Foundation
import Network

/// Pure protocol and network validation helpers shared by `LanPairingServer` (`#50`).
public enum LanPairingValidation {
  public static func isValidToken(_ token: String) -> Bool {
    guard token.count >= 32 && token.count <= 128 else { return false }
    for scalar in token.unicodeScalars {
      let v = scalar.value
      let isDigit = v >= 0x30 && v <= 0x39
      let isUpperHex = v >= 0x41 && v <= 0x46
      let isLowerHex = v >= 0x61 && v <= 0x66
      if !isDigit && !isUpperHex && !isLowerHex {
        return false
      }
    }
    return true
  }

  public static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
    let aBytes = Array(a.utf8)
    let bBytes = Array(b.utf8)
    var diff: UInt8 = aBytes.count == bBytes.count ? 0 : 1
    let maxLen = max(aBytes.count, bBytes.count)
    for i in 0..<maxLen {
      let ca: UInt8 = i < aBytes.count ? aBytes[i] : 0
      let cb: UInt8 = i < bBytes.count ? bBytes[i] : 0
      diff |= ca ^ cb
    }
    return diff == 0
  }

  public static func formatHostForAuthority(_ host: String) -> String {
    let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.contains(":") && !trimmed.hasPrefix("[") {
      return "[\(trimmed.lowercased())]"
    }
    return trimmed.lowercased()
  }

  public static func isValidPairingPath(_ path: String, expectedToken: String) -> Bool {
    let cleanPath: String
    if let qIndex = path.firstIndex(of: "?") {
      cleanPath = String(path[..<qIndex])
    } else {
      cleanPath = path
    }
    let prefix = "/pair/"
    guard cleanPath.hasPrefix(prefix) else { return false }
    let candidate = String(cleanPath.dropFirst(prefix.count))
    return constantTimeEquals(candidate, expectedToken)
  }

  public static func isValidHostHeader(_ hostHeader: String?, expectedHost: String, expectedPort: Int) -> Bool {
    guard let hostHeader else { return false }
    let candidate = hostHeader.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !candidate.isEmpty else { return false }
    let formatted = formatHostForAuthority(expectedHost)
    if candidate == "\(formatted):\(expectedPort)" { return true }
    return expectedPort == 80 && candidate == formatted
  }

  public static func isValidOriginHeader(_ originHeader: String?, expectedHost: String, expectedPort: Int) -> Bool {
    guard let originHeader else { return true }
    let candidate = originHeader.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !candidate.isEmpty else { return false }
    let formatted = formatHostForAuthority(expectedHost)
    if candidate == "http://\(formatted):\(expectedPort)" { return true }
    return expectedPort == 80 && candidate == "http://\(formatted)"
  }

  public static func isPrivateOrLoopbackIpv4Bytes(_ b0: UInt8, _ b1: UInt8) -> Bool {
    if b0 == 10 { return true }
    if b0 == 172 && b1 >= 16 && b1 <= 31 { return true }
    if b0 == 192 && b1 == 168 { return true }
    if b0 == 127 { return true }
    return false
  }

  public static func isRfc1918Ipv4Bytes(_ b0: UInt8, _ b1: UInt8) -> Bool {
    b0 == 10 || (b0 == 172 && b1 >= 16 && b1 <= 31) || (b0 == 192 && b1 == 168)
  }

  public static func isPrivateOrLoopbackIpv6Bytes(_ bytes: [UInt8]) -> Bool {
    guard bytes.count == 16 else { return false }
    // Loopback ::1
    var prefixZero = true
    for i in 0..<15 where bytes[i] != 0 {
      prefixZero = false
      break
    }
    if prefixZero && bytes[15] == 1 { return true }

    // IPv4-mapped ::ffff:0:0/96
    var mappedPrefix = true
    for i in 0..<10 where bytes[i] != 0 {
      mappedPrefix = false
      break
    }
    if mappedPrefix && bytes[10] == 0xff && bytes[11] == 0xff {
      return isPrivateOrLoopbackIpv4Bytes(bytes[12], bytes[13])
    }

    // IPv6 ULA fc00::/7
    if (bytes[0] & 0xfe) == 0xfc { return true }
    // IPv6 link-local fe80::/10
    if bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80 { return true }
    return false
  }

  public static func isPrivateLanEndpoint(_ endpoint: NWEndpoint) -> Bool {
    guard case let .hostPort(host: nwHost, port: _) = endpoint else { return false }
    switch nwHost {
    case let .ipv4(addr):
      let bytes = Array(addr.rawValue)
      return bytes.count == 4 && isPrivateOrLoopbackIpv4Bytes(bytes[0], bytes[1])
    case let .ipv6(addr):
      return isPrivateOrLoopbackIpv6Bytes(Array(addr.rawValue))
    case let .name(hostString, _):
      return isPrivateLanAddress(hostString)
    @unknown default:
      return false
    }
  }

  /// Validates an IPv4 or IPv6 literal string against private LAN and loopback ranges.
  public static func isPrivateLanAddress(_ rawIp: String) -> Bool {
    var addr = rawIp.trimmingCharacters(in: .whitespacesAndNewlines)
    if addr.isEmpty { return false }
    if let zoneIdx = addr.firstIndex(of: "%") {
      addr = String(addr[..<zoneIdx])
    }
    var ipv4 = in_addr()
    if inet_pton(AF_INET, addr, &ipv4) == 1 {
      let bytes = withUnsafeBytes(of: &ipv4) { Array($0) }
      return bytes.count == 4 && isPrivateOrLoopbackIpv4Bytes(bytes[0], bytes[1])
    }
    var ipv6 = in6_addr()
    if inet_pton(AF_INET6, addr, &ipv6) == 1 {
      let bytes = withUnsafeBytes(of: &ipv6) { Array($0) }
      return isPrivateOrLoopbackIpv6Bytes(bytes)
    }
    return false
  }

  /// Discovers the preferred non-loopback RFC1918 IPv4 address via `getifaddrs` (`en0` > `en1` > `en*` > other).
  public static func discoverPreferredLanIpv4() -> String? {
    var ifaddrPointer: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&ifaddrPointer) == 0, let firstAddr = ifaddrPointer else {
      return nil
    }
    defer { freeifaddrs(firstAddr) }

    var bestPriority = Int.max
    var bestIp: String?
    var cursor: UnsafeMutablePointer<ifaddrs>? = firstAddr

    while let current = cursor {
      defer { cursor = current.pointee.ifa_next }
      let flags = Int32(current.pointee.ifa_flags)
      let isUp = (flags & IFF_UP) != 0
      let isRunning = (flags & IFF_RUNNING) != 0
      let isLoopback = (flags & IFF_LOOPBACK) != 0
      guard isUp && isRunning && !isLoopback else { continue }

      guard let sa = current.pointee.ifa_addr, sa.pointee.sa_family == UInt8(AF_INET) else {
        continue
      }

      var hostBuffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
      let res = getnameinfo(
        sa,
        socklen_t(sa.pointee.sa_len),
        &hostBuffer,
        socklen_t(hostBuffer.count),
        nil,
        0,
        NI_NUMERICHOST
      )
      guard res == 0 else { continue }

      let ip = String(cString: hostBuffer)
      var parsed = in_addr()
      guard inet_pton(AF_INET, ip, &parsed) == 1 else { continue }
      let bytes = withUnsafeBytes(of: &parsed) { Array($0) }
      guard bytes.count == 4 && isRfc1918Ipv4Bytes(bytes[0], bytes[1]) else { continue }

      let ifaceName = String(cString: current.pointee.ifa_name).lowercased()
      let priority: Int
      if ifaceName == "en0" {
        priority = 0
      } else if ifaceName == "en1" {
        priority = 1
      } else if ifaceName.hasPrefix("en") {
        priority = 2
      } else {
        priority = 3
      }

      if priority < bestPriority {
        bestPriority = priority
        bestIp = ip
      }
    }

    return bestIp
  }
}

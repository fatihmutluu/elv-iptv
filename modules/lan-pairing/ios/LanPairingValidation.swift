import Darwin
import Foundation
import Network
import Security

/// Pure protocol and network validation helpers shared by `LanPairingServer` (`#50`).
public enum LanPairingValidation {
  private static let tokenByteLength = 24
  private static let maxNameLength = 120
  private static let maxUrlLength = 2_048
  private static let maxCredentialLength = 256

  /// Generates a 192-bit (24-byte) CSPRNG pairing token as 48 lowercase hex characters via `SecRandomCopyBytes`.
  public static func generateToken() -> String? {
    var bytes = [UInt8](repeating: 0, count: tokenByteLength)
    let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard status == errSecSuccess else { return nil }
    let hexTable: [UInt8] = Array("0123456789abcdef".utf8)
    var out = [UInt8]()
    out.reserveCapacity(bytes.count * 2)
    for byte in bytes {
      out.append(hexTable[Int(byte >> 4)])
      out.append(hexTable[Int(byte & 0x0f)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// Validates POST `Content-Type` (`application/json` or `application/x-www-form-urlencoded`)
  /// and required M3U/Xtream fields before consuming the one-shot pairing session.
  public static func isValidSubmissionPayload(_ bodyData: Data, contentType: String?) -> Bool {
    guard !bodyData.isEmpty, let contentType else { return false }
    let mime = contentType
      .split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
      .first?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() ?? ""

    let fields: [String: Any]
    switch mime {
    case "application/json":
      guard let parsed = try? JSONSerialization.jsonObject(with: bodyData, options: []),
            let dict = parsed as? [String: Any]
      else {
        return false
      }
      fields = dict
    case "application/x-www-form-urlencoded":
      guard let bodyText = String(data: bodyData, encoding: .utf8),
            let parsed = parseFormEncoded(bodyText)
      else {
        return false
      }
      fields = parsed
    default:
      return false
    }

    guard let rawKind = readStringField(fields, key: "kind", required: true) else {
      return false
    }
    let kind = rawKind.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard kind == "m3u" || kind == "xtream" else { return false }

    if let nameCheck = readOptionalStringField(fields, key: "name") {
      guard nameCheck.valid else { return false }
      if let name = nameCheck.value {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.count > maxNameLength { return false }
      }
    }

    if let guideCheck = readOptionalStringField(fields, key: "guideUrl") {
      guard guideCheck.valid else { return false }
      if let guide = guideCheck.value {
        let trimmed = guide.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty && !isValidHttpUrl(trimmed) { return false }
      }
    }

    if kind == "m3u" {
      guard let rawUrl = readStringField(fields, key: "url", required: true) else {
        return false
      }
      let url = rawUrl.trimmingCharacters(in: .whitespacesAndNewlines)
      return isValidHttpUrl(url)
    }

    guard let rawServer = readStringField(fields, key: "server", required: true) else {
      return false
    }
    let server = rawServer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard isValidHttpUrl(server) else { return false }

    guard let rawUser = readStringField(fields, key: "username", required: true) else {
      return false
    }
    let username = rawUser.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !username.isEmpty && username.count <= maxCredentialLength else { return false }

    guard let rawPass = readStringField(fields, key: "password", required: true) else {
      return false
    }
    let password = rawPass.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !password.isEmpty && password.count <= maxCredentialLength else { return false }

    return true
  }

  private static func containsControlChars(_ value: String) -> Bool {
    for scalar in value.unicodeScalars {
      let v = scalar.value
      if v <= 0x1f || v == 0x7f { return true }
    }
    return false
  }

  private static func readStringField(_ fields: [String: Any], key: String, required: Bool) -> String? {
    guard let raw = fields[key] else { return nil }
    guard let str = raw as? String else { return nil }
    if containsControlChars(str) { return nil }
    if required && str.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
    return str
  }

  private static func readOptionalStringField(
    _ fields: [String: Any],
    key: String
  ) -> (valid: Bool, value: String?)? {
    guard let raw = fields[key] else { return nil }
    if raw is NSNull { return (true, nil) }
    guard let str = raw as? String else { return (false, nil) }
    if containsControlChars(str) { return (false, nil) }
    return (true, str)
  }

  private static func isValidHttpUrl(_ raw: String) -> Bool {
    guard !raw.isEmpty && raw.count <= maxUrlLength else { return false }
    for scalar in raw.unicodeScalars {
      let v = scalar.value
      if v <= 0x20 || v == 0x7f || CharacterSet.whitespacesAndNewlines.contains(scalar) {
        return false
      }
    }
    guard let components = URLComponents(string: raw),
          let scheme = components.scheme?.lowercased(),
          scheme == "http" || scheme == "https",
          let host = components.host,
          !host.isEmpty
    else {
      return false
    }
    return true
  }

  private static func parseFormEncoded(_ body: String) -> [String: String]? {
    var result: [String: String] = [:]
    for pair in body.split(separator: "&", omittingEmptySubsequences: true) {
      let rawKey: Substring
      let rawVal: Substring
      if let eq = pair.firstIndex(of: "=") {
        rawKey = pair[..<eq]
        rawVal = pair[pair.index(after: eq)...]
      } else {
        rawKey = pair
        rawVal = ""
      }
      guard let key = decodeFormComponent(rawKey),
            let value = decodeFormComponent(rawVal)
      else {
        return nil
      }
      result[key] = value
    }
    return result
  }

  private static func decodeFormComponent(_ input: Substring) -> String? {
    let utf8Bytes = Array(input.utf8)
    var out = [UInt8]()
    out.reserveCapacity(utf8Bytes.count)
    var i = 0
    while i < utf8Bytes.count {
      let byte = utf8Bytes[i]
      if byte == 0x2b { // '+'
        out.append(0x20)
        i += 1
      } else if byte == 0x25 { // '%'
        guard i + 2 < utf8Bytes.count,
              let hi = hexNibble(utf8Bytes[i + 1]),
              let lo = hexNibble(utf8Bytes[i + 2])
        else {
          return nil
        }
        out.append((hi << 4) | lo)
        i += 3
      } else {
        out.append(byte)
        i += 1
      }
    }
    return String(bytes: out, encoding: .utf8)
  }

  private static func hexNibble(_ ascii: UInt8) -> UInt8? {
    switch ascii {
    case 0x30...0x39: return ascii - 0x30
    case 0x61...0x66: return ascii - 0x61 + 10
    case 0x41...0x46: return ascii - 0x41 + 10
    default: return nil
    }
  }
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

      let ip = String(decoding: hostBuffer.prefix { $0 != 0 }.map(UInt8.init(bitPattern:)), as: UTF8.self)
      var parsed = in_addr()
      guard inet_pton(AF_INET, ip, &parsed) == 1 else { continue }
      let bytes = withUnsafeBytes(of: &parsed) { Array($0) }
      guard bytes.count == 4 && isRfc1918Ipv4Bytes(bytes[0], bytes[1]) else { continue }

      guard let ifaNamePtr = current.pointee.ifa_name else { continue }
      let ifaceName = String(cString: ifaNamePtr).lowercased()
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

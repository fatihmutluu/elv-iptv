import ElvAetherCore
import Foundation
import Testing

@Suite("NetworkTransportOptions")
struct NetworkTransportOptionsTests {
  @Test("DnsFamilyPreference.parse accepts system/ipv4/ipv6 case-insensitively and defaults unknown values to system")
  func dnsFamilyParsing() {
    #expect(DnsFamilyPreference.parse("system") == .system)
    #expect(DnsFamilyPreference.parse("ipv4") == .ipv4)
    #expect(DnsFamilyPreference.parse("ipv6") == .ipv6)
    #expect(DnsFamilyPreference.parse("  IPv4 \n") == .ipv4)
    #expect(DnsFamilyPreference.parse("IPV6") == .ipv6)
    #expect(DnsFamilyPreference.parse(nil) == .system)
    #expect(DnsFamilyPreference.parse("") == .system)
    #expect(DnsFamilyPreference.parse("   ") == .system)
    #expect(DnsFamilyPreference.parse("ipv5") == .system)
    #expect(DnsFamilyPreference.parse("dual-stack") == .system)
  }

  @Test("validateHostOverride accepts strict RFC 5737 IPv4 and RFC 3849 IPv6 literals")
  func validHostOverrides() {
    // RFC 5737 TEST-NET IPv4 addresses + boundary values
    #expect(validateHostOverride("192.0.2.1") == "192.0.2.1")
    #expect(validateHostOverride("  198.51.100.42  ") == "198.51.100.42")
    #expect(validateHostOverride("203.0.113.255") == "203.0.113.255")
    #expect(validateHostOverride("0.0.0.0") == "0.0.0.0")
    #expect(validateHostOverride("255.255.255.255") == "255.255.255.255")

    // RFC 3849 documentation IPv6 addresses, compressed, bracketed, and IPv4-embedded
    #expect(validateHostOverride("2001:db8::1") == "2001:db8::1")
    #expect(validateHostOverride("2001:DB8::A1B2") == "2001:db8::a1b2")
    #expect(validateHostOverride("[2001:DB8::1]") == "2001:db8::1")
    #expect(validateHostOverride("  [2001:db8:0:0:0:0:0:1]  ") == "2001:db8:0:0:0:0:0:1")
    #expect(validateHostOverride("::") == "::")
    #expect(validateHostOverride("[::]") == "::")
    #expect(validateHostOverride("::1") == "::1")
    #expect(validateHostOverride("2001:db8::") == "2001:db8::")
    #expect(validateHostOverride("::ffff:192.0.2.128") == "::ffff:192.0.2.128")
    #expect(validateHostOverride("2001:db8:0:0:0:0:192.0.2.1") == "2001:db8:0:0:0:0:192.0.2.1")
  }

  @Test("validateHostOverride rejects empty strings, ports, schemes, hostnames, zone IDs, and control chars")
  func invalidHostOverrides() {
    let rejected: [String?] = [
      nil,
      "",
      "   ",
      // Hostnames, schemes, paths, userinfo
      "edge.example",
      "localhost",
      "http://192.0.2.1",
      "https://2001:db8::1",
      "192.0.2.1/live/1.ts",
      "user@192.0.2.1",
      // Ports
      "192.0.2.1:8080",
      "[2001:db8::1]:443",
      "2001:db8::1:8080:1:2:3:4:5",
      // Malformed IPv4
      "192.0.02.1",
      "00.0.0.0",
      "256.0.2.1",
      "192.0.2",
      "192.0.2.1.5",
      "[192.0.2.1]",
      // Zone IDs & malformed IPv6
      "fe80::1%en0",
      "[fe80::1%25en0]",
      "2001::db8::1",
      ":::1",
      "1:::",
      ":1",
      "1:",
      "192.0.2.1::",
      "2001:db8::12345",
      "2001:db8::1:2:3:4:5:6",
      "[2001:db8::1",
      "2001:db8::1]",
      // Control characters & internal whitespace
      "192.0.2.1\r\n",
      "192.0.2.1\nX-Injected: 1",
      "192.0.2.1\0",
      "\t192.0.2.1",
      "192.0.2.1 192.0.2.2",
    ]
    for input in rejected {
      #expect(validateHostOverride(input) == nil, "Expected nil for \(String(describing: input))")
    }
  }
}

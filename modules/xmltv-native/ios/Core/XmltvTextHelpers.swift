import Foundation

public struct CleanedXmltvTitle: Sendable, Equatable {
  public let title: String
  public let isLive: Bool
  public let isNew: Bool

  public init(title: String, isLive: Bool, isNew: Bool) {
    self.title = title
    self.isLive = isLive
    self.isNew = isNew
  }
}

/// Pure Swift XMLTV timestamp, entity, HTML/badge cleaning, Turkish-aware text folding,
/// genre classification, flag bitmask, and artwork URL helpers matching `@elv/sources` and `@elv/data`.
public enum XmltvTextHelpers {
  /// Minimum valid XMLTV programme timestamp (`1990-01-01T00:00:00Z`).
  public static let minValidXmltvEpochMs: Int64 = 631_152_000_000
  public static let maxInlineLogoBytes: Int = 4096

  public static let epgFlagLive: Int32 = 1
  public static let epgFlagNew: Int32 = 2
  public static let epgFlagPremiere: Int32 = 4
  public static let epgFlagRepeat: Int32 = 8

  private static let daysInMonth: [Int] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

  private static let sportsTokens: Set<String> = [
    "sports", "sport", "spor", "futbol", "football", "soccer", "basketball", "basketbol",
    "tennis", "tenis", "motorsport", "f1", "racing", "golf", "boxing", "boks", "hockey",
    "rugby", "athletics", "volleyball", "voleybol", "baseball", "cricket", "olympics",
    "deportes", "deporte",
  ]
  private static let movieTokens: Set<String> = [
    "movie", "movies", "film", "films", "sinema", "cinema", "kino", "pelicula", "peliculas",
    "cine", "feature", "thriller", "horror", "action", "aksiyon", "adventure",
  ]
  private static let newsTokens: Set<String> = [
    "news", "haber", "haberler", "nachrichten", "actualites", "actualite", "noticias",
    "noticia", "journal", "bulletin", "politics", "ekonomi", "economy", "weather", "gundem",
  ]
  private static let newsPhrases: [String] = ["current affairs", "hava durumu"]
  private static let kidsTokens: Set<String> = [
    "kids", "kid", "children", "child", "cocuk", "animation", "animasyon", "cartoon",
    "kinder", "jeunesse", "enfants", "enfant", "infantil", "ninos", "nino", "family", "aile",
  ]
  private static let kidsPhrases: [String] = ["cizgi film"]
  private static let seriesTokens: Set<String> = [
    "series", "serie", "drama", "dizi", "diziler", "comedy", "komedi", "comedie", "comedia",
    "documentary", "belgesel", "dokumentation", "documentaire", "documental", "sitcom",
    "soap", "reality", "entertainment", "eglence", "magazine", "lifestyle",
  ]
  private static let seriesPhrases: [String] = ["talk show"]

  private static let superscriptToAscii: [UInt32: Character] = [
    0x1D38: "L", 0x02E1: "L",
    0x1D35: "I", 0x2071: "I",
    0x2C7D: "V", 0x1D5B: "V",
    0x1D31: "E", 0x1D49: "E",
    0x1D3A: "N", 0x207F: "N",
    0x1D42: "W", 0x02B7: "W",
  ]

  private static let inlineHtmlTags: Set<String> = [
    "b", "i", "u", "em", "strong", "br", "p", "span", "font", "small", "sub", "sup", "mark", "del", "ins",
  ]

  private static func parseDigits(_ bytes: [UInt8], at start: Int, count: Int) -> Int {
    var value = 0
    for i in start..<(start + count) {
      let d = Int(bytes[i]) - 48
      if d < 0 || d > 9 { return -1 }
      value = value * 10 + d
    }
    return value
  }

  private static func isLeapYear(_ year: Int) -> Bool {
    (year % 4 == 0) && (year % 100 != 0 || year % 400 == 0)
  }

  private static func daysCount(year: Int, month: Int) -> Int {
    month == 2 && isLeapYear(year) ? 29 : daysInMonth[month - 1]
  }

  private static func utcMillis(year: Int, month: Int, day: Int, hour: Int, minute: Int, second: Int) -> Int64 {
    let y = month <= 2 ? year - 1 : year
    let era = y >= 0 ? y / 400 : (y - 399) / 400
    let yoe = y - era * 400
    let m = month > 2 ? month - 3 : month + 9
    let doy = (153 * m + 2) / 5 + day - 1
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
    let daysSinceEpoch = Int64(era) * 146_097 + Int64(doe) - 719_468
    let secondsOfDay = Int64(hour) * 3600 + Int64(minute) * 60 + Int64(second)
    return (daysSinceEpoch * 86_400 + secondsOfDay) * 1000
  }

  private static func resolveWallClock(wallUtcMs: Int64, timeZone: TimeZone) -> Int64 {
    let off1 = Int64(timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(wallUtcMs) / 1000.0))) * 1000
    let guess1 = wallUtcMs - off1
    let off2 = Int64(timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(guess1) / 1000.0))) * 1000
    if off2 == off1 { return guess1 }
    let guess2 = wallUtcMs - off2
    let off3 = Int64(timeZone.secondsFromGMT(for: Date(timeIntervalSince1970: Double(guess2) / 1000.0))) * 1000
    if off3 == off2 { return guess2 }
    return wallUtcMs - min(off1, off2)
  }

  private static func parseOffsetMinutes(_ suffix: String) -> Int? {
    if suffix.isEmpty { return 0 }
    let upper = suffix.uppercased()
    if upper == "Z" || upper == "UTC" || upper == "GMT" { return 0 }
    var rest = upper
    if rest.hasPrefix("UTC") || rest.hasPrefix("GMT") {
      rest = String(rest.dropFirst(3)).trimmingCharacters(in: .whitespaces)
    }
    let bytes = Array(rest.utf8)
    guard !bytes.isEmpty else { return nil }
    let sign: Int
    if bytes[0] == 43 { sign = 1 } // '+'
    else if bytes[0] == 45 { sign = -1 } // '-'
    else { return nil }

    let body: [UInt8]
    if bytes.count == 6 && bytes[3] == 58 { // ':'
      body = [bytes[1], bytes[2], bytes[4], bytes[5]]
    } else {
      body = Array(bytes.dropFirst())
    }
    guard body.count == 2 || body.count == 4 else { return nil }
    let hours = parseDigits(body, at: 0, count: 2)
    let minutes = body.count == 4 ? parseDigits(body, at: 2, count: 2) : 0
    if hours < 0 || minutes < 0 || hours > 23 || minutes > 59 { return nil }
    return sign * (hours * 60 + minutes)
  }

  public static func parseXmltvTime(_ raw: String, defaultTimeZone: String? = nil) -> Int64? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    let bytes = Array(trimmed.utf8)
    var n = 0
    while n < bytes.count && n < 14 {
      if bytes[n] < 48 || bytes[n] > 57 { break }
      n += 1
    }
    guard n >= 4 && n % 2 == 0 else { return nil }
    let year = parseDigits(bytes, at: 0, count: 4)
    let month = n >= 6 ? parseDigits(bytes, at: 4, count: 2) : 1
    let day = n >= 8 ? parseDigits(bytes, at: 6, count: 2) : 1
    let hour = n >= 10 ? parseDigits(bytes, at: 8, count: 2) : 0
    let minute = n >= 12 ? parseDigits(bytes, at: 10, count: 2) : 0
    let second = n >= 14 ? parseDigits(bytes, at: 12, count: 2) : 0
    if year < 1000 || month < 1 || month > 12 { return nil }
    if day < 1 || day > daysCount(year: year, month: month) || hour > 23 || minute > 59 || second > 59 {
      return nil
    }
    let wallUtcMs = utcMillis(year: year, month: month, day: day, hour: hour, minute: minute, second: second)
    let suffix = String(decoding: bytes[n...], as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    if suffix.isEmpty {
      if let tzName = defaultTimeZone?.trimmingCharacters(in: .whitespacesAndNewlines),
         !tzName.isEmpty,
         let tz = TimeZone(identifier: tzName) {
        return resolveWallClock(wallUtcMs: wallUtcMs, timeZone: tz)
      }
      return wallUtcMs
    }
    guard let offsetMinutes = parseOffsetMinutes(suffix) else { return nil }
    return wallUtcMs - Int64(offsetMinutes) * 60_000
  }

  public static func decodeXmlEntities(_ text: String) -> String {
    guard text.utf8.contains(38) else { return text } // '&'
    let bytes = Array(text.utf8)
    var out: [UInt8] = []
    out.reserveCapacity(bytes.count)
    var i = 0
    let count = bytes.count
    while i < count {
      if bytes[i] != 38 {
        out.append(bytes[i])
        i += 1
        continue
      }
      var semi = i + 1
      let maxSemi = min(count, i + 11)
      var found = -1
      while semi < maxSemi {
        if bytes[semi] == 59 { // ';'
          found = semi
          break
        }
        semi += 1
      }
      if found > i + 1 {
        let entity = String(decoding: bytes[(i + 1)..<found], as: UTF8.self)
        var replacement: String?
        switch entity {
        case "amp": replacement = "&"
        case "lt": replacement = "<"
        case "gt": replacement = ">"
        case "quot": replacement = "\""
        case "apos": replacement = "'"
        default:
          if entity.hasPrefix("#x") || entity.hasPrefix("#X") {
            let hex = String(entity.dropFirst(2))
            if !hex.isEmpty && hex.count <= 6, let cp = UInt32(hex, radix: 16),
               cp > 0, cp <= 0x10FFFF, !(cp >= 0xD800 && cp <= 0xDFFF),
               let scalar = UnicodeScalar(cp) {
              replacement = String(scalar)
            }
          } else if entity.hasPrefix("#") {
            let dec = String(entity.dropFirst())
            if !dec.isEmpty && dec.count <= 7, let cp = UInt32(dec, radix: 10),
               cp > 0, cp <= 0x10FFFF, !(cp >= 0xD800 && cp <= 0xDFFF),
               let scalar = UnicodeScalar(cp) {
              replacement = String(scalar)
            }
          }
        }
        if let replacement {
          out.append(contentsOf: replacement.utf8)
          i = found + 1
          continue
        }
      }
      out.append(38)
      i += 1
    }
    return String(decoding: out, as: UTF8.self)
  }

  public static func stripInlineHtml(_ text: String) -> String {
    guard text.utf8.contains(60) else { return text } // '<'
    let bytes = Array(text.utf8)
    var out: [UInt8] = []
    out.reserveCapacity(bytes.count)
    var stripped = false
    var i = 0
    let count = bytes.count
    while i < count {
      if bytes[i] == 60 {
        var j = i + 1
        let isClosing = j < count && bytes[j] == 47 // '/'
        if isClosing { j += 1 }
        let nameStart = j
        while j < count && ((bytes[j] >= 65 && bytes[j] <= 90) || (bytes[j] >= 97 && bytes[j] <= 122)) {
          j += 1
        }
        if j > nameStart {
          let tag = String(decoding: bytes[nameStart..<j], as: UTF8.self).lowercased()
          if inlineHtmlTags.contains(tag) {
            var k = j
            var validEnd = -1
            if k < count && (bytes[k] == 62 || bytes[k] == 47 || bytes[k] == 32 || bytes[k] == 9 || bytes[k] == 10 || bytes[k] == 13) {
              while k < count {
                if bytes[k] == 62 {
                  validEnd = k + 1
                  break
                }
                if bytes[k] == 60 { break }
                k += 1
              }
            }
            if validEnd > 0 {
              stripped = true
              if tag == "br" || (tag == "p" && isClosing) {
                out.append(32)
              }
              i = validEnd
              continue
            }
          }
        }
      }
      out.append(bytes[i])
      i += 1
    }
    guard stripped else { return text }
    return collapseAsciiWhitespace(String(decoding: out, as: UTF8.self))
  }

  private static func collapseAsciiWhitespace(_ text: String) -> String {
    var result = ""
    result.reserveCapacity(text.count)
    var pendingSpace = false
    for ch in text {
      if ch == " " || ch == "\t" || ch == "\r" || ch == "\n" {
        pendingSpace = true
      } else {
        if pendingSpace && !result.isEmpty { result.append(" ") }
        result.append(ch)
        pendingSpace = false
      }
    }
    return result
  }

  private static func isSuperscriptScalar(_ v: UInt32) -> Bool {
    (v >= 0x02B0 && v <= 0x02B8) ||
    (v >= 0x02E0 && v <= 0x02E4) ||
    (v >= 0x1D2C && v <= 0x1D61) ||
    (v >= 0x1D9B && v <= 0x1DBF) ||
    (v >= 0x2070 && v <= 0x207F) ||
    v == 0x2C7C || v == 0x2C7D ||
    v == 0x00B2 || v == 0x00B3 || v == 0x00B9
  }

  private static func isBadgeBoundary(_ scalar: UnicodeScalar?) -> Bool {
    guard let s = scalar else { return true }
    switch s.value {
    case 0x20, 0x09, 0x0A, 0x0D, 0x28, 0x29, 0x5B, 0x5D, 0x7B, 0x7D,
         0x2C, 0x3B, 0x3A, 0x2F, 0x7C, 0x00B7, 0x2022, 0x2013, 0x2014, 0x2D:
      return true
    default:
      return false
    }
  }

  public static func cleanTitleAndFlags(_ raw: String) -> CleanedXmltvTitle {
    let withoutHtml = stripInlineHtml(raw)
    if withoutHtml.utf8.allSatisfy({ $0 <= 0x7F }) {
      return CleanedXmltvTitle(title: withoutHtml, isLive: false, isNew: false)
    }
    let scalars = Array(withoutHtml.unicodeScalars)
    var outScalars: [UnicodeScalar] = []
    outScalars.reserveCapacity(scalars.count)
    var isLive = false
    var isNew = false
    var strippedSuper = false
    var i = 0
    while i < scalars.count {
      if isSuperscriptScalar(scalars[i].value) {
        let start = i
        while i < scalars.count && isSuperscriptScalar(scalars[i].value) { i += 1 }
        let prev = start > 0 ? scalars[start - 1] : nil
        let next = i < scalars.count ? scalars[i] : nil
        var folded = ""
        var allMapped = true
        for j in start..<i {
          if let mapped = superscriptToAscii[scalars[j].value] {
            folded.append(mapped)
          } else {
            allMapped = false
            break
          }
        }
        let recognized = allMapped && (folded == "LIVE" || folded == "NEW")
        let standalone = isBadgeBoundary(prev) && isBadgeBoundary(next)
        if standalone || (recognized && isBadgeBoundary(next)) {
          strippedSuper = true
          if recognized && folded == "LIVE" { isLive = true }
          else if recognized && folded == "NEW" { isNew = true }
        } else {
          outScalars.append(contentsOf: scalars[start..<i])
        }
      } else {
        outScalars.append(scalars[i])
        i += 1
      }
    }
    guard strippedSuper else {
      return CleanedXmltvTitle(title: withoutHtml, isLive: false, isNew: false)
    }
    var view = String.UnicodeScalarView()
    view.append(contentsOf: outScalars)
    return CleanedXmltvTitle(title: collapseAsciiWhitespace(String(view)), isLive: isLive, isNew: isNew)
  }

  public static func episodeNumRank(_ system: String?) -> Int {
    guard let sys = system?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() else { return 0 }
    switch sys {
    case "xmltv_ns": return 3
    case "onscreen": return 2
    case "dd_progid": return 1
    default: return 0
    }
  }

  public static func isValidXmltvNs(_ value: String) -> Bool {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    let parts = trimmed.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 2 || parts.count == 3 else { return false }
    var hasDigit = false
    for part in parts {
      let piece = part.trimmingCharacters(in: .whitespaces)
      if piece.isEmpty { continue }
      let sub = piece.split(separator: "/", omittingEmptySubsequences: false)
      guard sub.count == 1 || sub.count == 2 else { return false }
      for idx in 0..<sub.count {
        let token = sub[idx]
        if idx == 1 && token.isEmpty { return false }
        for b in token.utf8 {
          guard b >= 48 && b <= 57 else { return false }
          hasDigit = true
        }
      }
    }
    return hasDigit
  }

  public static func extractDescEpisodeNum(_ desc: String) -> String? {
    let trimmed = desc.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let first = trimmed.utf8.first else { return nil }
    guard first == 83 || first == 115 || (first >= 48 && first <= 57) else { return nil }
    if let range = trimmed.range(of: #"^(S\d{1,3}E\d{1,4})\b"#, options: [.regularExpression, .caseInsensitive]) {
      return String(trimmed[range]).uppercased()
    }
    if let range = trimmed.range(of: #"^Season\s+\d{1,3}\s*(?:[,:-]\s*|\s+)Episode\s+\d{1,4}\b"#, options: [.regularExpression, .caseInsensitive]) {
      let matched = String(trimmed[range])
      let nums = matched.split { !$0.isNumber }.map(String.init)
      if nums.count >= 2 {
        return formatSeasonEpisode(nums[0], nums[1])
      }
    }
    if let range = trimmed.range(of: #"^\d{1,3}x\d{2,4}\b"#, options: [.regularExpression, .caseInsensitive]) {
      let matched = String(trimmed[range])
      let nums = matched.split { !$0.isNumber }.map(String.init)
      if nums.count >= 2 {
        return formatSeasonEpisode(nums[0], nums[1])
      }
    }
    return nil
  }

  private static func formatSeasonEpisode(_ season: String, _ episode: String) -> String {
    let s = season.count < 2 ? String(repeating: "0", count: 2 - season.count) + season : season
    let e = episode.count < 2 ? String(repeating: "0", count: 2 - episode.count) + episode : episode
    return "S\(s)E\(e)"
  }

  public static func sanitizeArtworkUrl(_ raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    for b in trimmed.utf8 {
      if b <= 0x1F || b == 0x7F { return nil }
    }
    let lower = trimmed.lowercased()
    if lower.hasPrefix("http://") || lower.hasPrefix("https://") {
      let prefixLen = lower.hasPrefix("https://") ? 8 : 7
      let afterScheme = String(trimmed.dropFirst(prefixLen))
      let authEnd = afterScheme.firstIndex(where: { $0 == "/" || $0 == "?" || $0 == "#" }) ?? afterScheme.endIndex
      let authority = String(afterScheme[..<authEnd])
      let hostPort: String
      if let atIdx = authority.lastIndex(of: "@") {
        hostPort = String(authority[authority.index(after: atIdx)...])
      } else {
        hostPort = authority
      }
      guard !hostPort.isEmpty else { return nil }
      if hostPort.hasPrefix("[") {
        guard let close = hostPort.firstIndex(of: "]") else { return nil }
        let host = hostPort[hostPort.index(after: hostPort.startIndex)..<close]
        return !host.isEmpty && !host.contains(where: { $0.isWhitespace }) ? trimmed : nil
      }
      let host = hostPort.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
      return !host.isEmpty && !host.contains(where: { $0.isWhitespace }) ? trimmed : nil
    }
    if lower.hasPrefix("data:") {
      guard trimmed.count <= maxInlineLogoBytes else { return nil }
      guard let comma = lower.firstIndex(of: ",") else { return nil }
      let header = String(lower[lower.index(lower.startIndex, offsetBy: 5)..<comma])
      guard header.hasPrefix("image/") else { return nil }
      let rest = String(header.dropFirst(6))
      let subtype = rest.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? ""
      guard !subtype.isEmpty, !subtype.contains("svg") else { return nil }
      return trimmed
    }
    return nil
  }

  /// Matches `packages/data/src/fold.ts#foldText` (ASCII fast path + Turkish-aware NFD folding).
  public static func foldText(_ text: String) -> String {
    guard !text.isEmpty else { return "" }
    let utf8 = text.utf8
    if utf8.allSatisfy({ $0 <= 0x7F }) {
      var out: [UInt8] = []
      out.reserveCapacity(utf8.count)
      var pendingSpace = false
      for raw in utf8 {
        let ch = (raw >= 65 && raw <= 90) ? (raw + 32) : raw
        let isAlnum = (ch >= 97 && ch <= 122) || (ch >= 48 && ch <= 57)
        if isAlnum {
          if pendingSpace && !out.isEmpty { out.append(32) }
          out.append(ch)
          pendingSpace = false
        } else {
          pendingSpace = true
        }
      }
      return String(decoding: out, as: UTF8.self)
    }
    var pre = ""
    pre.reserveCapacity(text.count)
    for scalar in text.unicodeScalars {
      if scalar.value == 0x0130 { pre.append("i") } // İ
      else if scalar.value == 0x0049 { pre.append("\u{0131}") } // I -> ı
      else { pre.unicodeScalars.append(scalar) }
    }
    let lowered = pre.lowercased()
    let nfd = lowered.decomposedStringWithCanonicalMapping
    var out = String.UnicodeScalarView()
    var pendingSpace = false
    for scalar in nfd.unicodeScalars {
      let cat = scalar.properties.generalCategory
      if cat == .nonspacingMark || cat == .spacingMark || cat == .enclosingMark {
        continue
      }
      if scalar.value == 0x00DF { // ß
        if pendingSpace && !out.isEmpty { out.append(" ") }
        out.append("s")
        out.append("s")
        pendingSpace = false
      } else if scalar.value == 0x0131 { // ı
        if pendingSpace && !out.isEmpty { out.append(" ") }
        out.append("i")
        pendingSpace = false
      } else if scalar.properties.isAlphabetic || cat == .decimalNumber || cat == .letterNumber || cat == .otherNumber ||
                cat == .uppercaseLetter || cat == .lowercaseLetter || cat == .titlecaseLetter || cat == .modifierLetter || cat == .otherLetter {
        if pendingSpace && !out.isEmpty { out.append(" ") }
        out.append(scalar)
        pendingSpace = false
      } else {
        pendingSpace = true
      }
    }
    return String(out)
  }

  private static func foldCategoryText(_ raw: String) -> String {
    var pre = ""
    pre.reserveCapacity(raw.count)
    for scalar in raw.unicodeScalars {
      if scalar.value == 0x0130 || scalar.value == 0x0131 { pre.append("i") }
      else { pre.unicodeScalars.append(scalar) }
    }
    let nfkd = pre.lowercased().decomposedStringWithCompatibilityMapping
    var out: [UInt8] = []
    out.reserveCapacity(nfkd.utf8.count)
    var pendingSpace = false
    for scalar in nfkd.unicodeScalars {
      if scalar.value >= 0x0300 && scalar.value <= 0x036F { continue }
      let v = scalar.value
      if (v >= 97 && v <= 122) || (v >= 48 && v <= 57) {
        if pendingSpace && !out.isEmpty { out.append(32) }
        out.append(UInt8(v))
        pendingSpace = false
      } else {
        pendingSpace = true
      }
    }
    return String(decoding: out, as: UTF8.self)
  }

  public static func normalizeEpgGenre(_ categories: [String]) -> String? {
    var hasNonEmpty = false
    for raw in categories {
      let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmed.isEmpty { continue }
      hasNonEmpty = true
      let folded = foldCategoryText(trimmed)
      if folded.isEmpty { continue }
      let tokens = folded.split(separator: " ").map(String.init)
      for tok in tokens where sportsTokens.contains(tok) { return "sports" }
      for phrase in kidsPhrases where folded.contains(phrase) { return "kids" }
      for tok in tokens where kidsTokens.contains(tok) { return "kids" }
      for phrase in newsPhrases where folded.contains(phrase) { return "news" }
      for tok in tokens where newsTokens.contains(tok) { return "news" }
      for tok in tokens where movieTokens.contains(tok) { return "movie" }
      for phrase in seriesPhrases where folded.contains(phrase) { return "series" }
      for tok in tokens where seriesTokens.contains(tok) { return "series" }
    }
    return hasNonEmpty ? "other" : nil
  }

  public static func encodeProgrammeFlags(
    isLive: Bool,
    isNew: Bool,
    isPremiere: Bool,
    previouslyShown: Bool
  ) -> Int32 {
    var mask: Int32 = 0
    if isLive { mask |= epgFlagLive }
    if isNew { mask |= epgFlagNew }
    if isPremiere { mask |= epgFlagPremiere }
    if previouslyShown { mask |= epgFlagRepeat }
    return mask
  }

  public static func encodeJsonStringArray(_ items: [String]) -> String {
    var out = "["
    for (idx, item) in items.enumerated() {
      if idx > 0 { out.append(",") }
      out.append("\"")
      for scalar in item.unicodeScalars {
        switch scalar.value {
        case 0x22: out.append("\\\"")
        case 0x5C: out.append("\\\\")
        case 0x08: out.append("\\b")
        case 0x0C: out.append("\\f")
        case 0x0A: out.append("\\n")
        case 0x0D: out.append("\\r")
        case 0x09: out.append("\\t")
        default:
          if scalar.value < 0x20 {
            let hex = String(scalar.value, radix: 16)
            out.append("\\u" + String(repeating: "0", count: max(0, 4 - hex.count)) + hex)
          } else {
            out.unicodeScalars.append(scalar)
          }
        }
      }
      out.append("\"")
    }
    out.append("]")
    return out
  }
}

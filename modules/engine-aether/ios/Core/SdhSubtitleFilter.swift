import Foundation

/// Pure SDH / Hearing-Impaired subtitle cue content abstraction for unit-tested filtering (`#310`).
public enum SdhCueBody: Equatable, Sendable {
  case text(String)
  case richText([String])
  case image
}

/// Pure SDH / Hearing-Impaired annotation stripper shared across Apple core tests and `SubtitlePresentation` (`#310`).
public enum SdhSubtitleFilter {
  /// Strips balanced `[...]` / `(...)` cues, Unicode uppercase speaker labels, and lone dashes / music lines (`♪`/`♫`)
  /// while preserving numeric/year parentheticals like `(2024)` / `(1-2)`, Turkish uppercase, RTL uncased text,
  /// timestamps, prose colons, and `- ` dialogue dashes. Returns `""` when the entire cue becomes empty.
  public static func stripSdhAnnotations(_ text: String) -> String {
    guard !text.isEmpty else { return "" }
    let normalized = text
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
    let withoutBrackets = stripBalancedBrackets(normalized)
    var surviving: [String] = []
    for rawSub in withoutBrackets.split(separator: "\n", omittingEmptySubsequences: false) {
      let trimmed = trimHorizontalWhitespace(String(rawSub))
      if trimmed.isEmpty { continue }
      let withoutSpeaker = stripSpeakerLabel(from: trimmed)
      let collapsed = trimHorizontalWhitespace(collapseHorizontalSpaces(withoutSpeaker))
      if collapsed.isEmpty || isBlankDashOrMusicOnly(collapsed) { continue }
      surviving.append(collapsed)
    }
    return surviving.joined(separator: "\n")
  }

  /// Applies SDH filtering to `.text` and `.richText` cues while leaving `.image` cues untouched.
  /// Returns `nil` when a filtered text/richText cue becomes empty so callers suppress blank cue boxes.
  public static func filterCueBody(_ body: SdhCueBody, enabled: Bool) -> SdhCueBody? {
    guard enabled else { return body }
    switch body {
    case .image:
      return .image
    case let .text(raw):
      let cleaned = stripSdhAnnotations(raw)
      return cleaned.isEmpty ? nil : .text(cleaned)
    case let .richText(runs):
      let joined = runs.joined()
      let cleaned = stripSdhAnnotations(joined)
      guard !cleaned.isEmpty else { return nil }
      if cleaned == trimHorizontalWhitespace(joined) {
        return .richText(runs)
      }
      return .text(cleaned)
    }
  }

  private static func isBidiControl(_ scalar: Unicode.Scalar) -> Bool {
    let v = scalar.value
    return v == 0x200E
      || v == 0x200F
      || v == 0x061C
      || (v >= 0x202A && v <= 0x202E)
      || (v >= 0x2066 && v <= 0x2069)
  }

  private static func isDialogueDash(_ scalar: Unicode.Scalar) -> Bool {
    scalar == "-" || scalar == "\u{2013}" || scalar == "\u{2014}"
  }

  private static func isMusicSymbol(_ scalar: Unicode.Scalar) -> Bool {
    let v = scalar.value
    return v == 0x2669 || v == 0x266A || v == 0x266B || v == 0x266C || v == 0x1F3B5 || v == 0x1F3B6
  }

  private static func isPunctuationAfterBracket(_ scalar: Unicode.Scalar) -> Bool {
    scalar == "." || scalar == "," || scalar == "!" || scalar == "?" || scalar == ";" || scalar == ":"
  }

  private static func isNumericParenContent(_ inner: String) -> Bool {
    let scalars = Array(inner.unicodeScalars)
    var i = 0
    let n = scalars.count
    while i < n && scalars[i].properties.isWhitespace { i += 1 }
    guard i < n, isAsciiDigit(scalars[i]) else { return false }
    while i < n && isAsciiDigit(scalars[i]) { i += 1 }
    while i < n {
      let start = i
      while i < n && scalars[i].properties.isWhitespace { i += 1 }
      guard i < n else { break }
      let s = scalars[i]
      if s == "-" || s == "\u{2013}" || s == "\u{2014}" || s == "." || s == "," || s == ":" || s == "/" {
        i += 1
        while i < n && scalars[i].properties.isWhitespace { i += 1 }
        guard i < n, isAsciiDigit(scalars[i]) else { return false }
        while i < n && isAsciiDigit(scalars[i]) { i += 1 }
      } else if s == "%" {
        i += 1
        while i < n && scalars[i].properties.isWhitespace { i += 1 }
        return i == n
      } else {
        return start == n
      }
    }
    return true
  }

  private static func isAsciiDigit(_ scalar: Unicode.Scalar) -> Bool {
    scalar.value >= 0x30 && scalar.value <= 0x39
  }

  private static func stripBalancedBrackets(_ input: String) -> String {
    let scalars = Array(input.unicodeScalars)
    var matchingClose = Array(repeating: -1, count: scalars.count)
    var squareStack: [Int] = []
    var parenStack: [Int] = []
    for idx in 0..<scalars.count {
      switch scalars[idx] {
      case "[":
        squareStack.append(idx)
      case "]":
        if let open = squareStack.popLast() { matchingClose[open] = idx }
      case "(":
        parenStack.append(idx)
      case ")":
        if let open = parenStack.popLast() { matchingClose[open] = idx }
      default:
        break
      }
    }

    var out: [Unicode.Scalar] = []
    out.reserveCapacity(scalars.count)
    var i = 0
    while i < scalars.count {
      let s = scalars[i]
      if s == "[" || s == "(" {
        let closeIdx = matchingClose[i]
        if closeIdx > i {
          let inner = String(String.UnicodeScalarView(scalars[(i + 1)..<closeIdx]))
          if s == "(" && isNumericParenContent(inner) {
            out.append(contentsOf: scalars[i...closeIdx])
          } else {
            let prev = out.last
            let next = (closeIdx + 1 < scalars.count) ? scalars[closeIdx + 1] : nil
            if let prev, let next,
               !prev.properties.isWhitespace,
               !next.properties.isWhitespace,
               !isPunctuationAfterBracket(next)
            {
              out.append(" ")
            }
          }
          i = closeIdx + 1
          continue
        }
      }
      out.append(s)
      i += 1
    }
    return String(String.UnicodeScalarView(out))
  }

  private static func isAllowedSpeakerLabel(_ label: String) -> Bool {
    let trimmed = trimHorizontalWhitespace(label)
    guard !trimmed.isEmpty, trimmed.count <= 40 else { return false }
    var hasUpper = false
    for scalar in trimmed.unicodeScalars {
      switch scalar.properties.generalCategory {
      case .uppercaseLetter:
        hasUpper = true
      case .lowercaseLetter, .titlecaseLetter, .otherLetter:
        return false
      case .nonspacingMark, .spacingMark, .decimalNumber:
        break
      default:
        if scalar == " "
          || scalar == "."
          || scalar == "'"
          || scalar == "\u{2019}"
          || scalar == "-"
          || scalar == "/"
          || scalar == "&"
          || scalar == ","
          || isBidiControl(scalar)
        {
          break
        }
        return false
      }
    }
    return hasUpper
  }

  private static func stripSpeakerLabel(from line: String) -> String {
    let scalars = Array(line.unicodeScalars)
    var idx = 0
    while idx < scalars.count && (scalars[idx] == " " || scalars[idx] == "\t" || isBidiControl(scalars[idx])) {
      idx += 1
    }
    var dashIdx: Int?
    if idx < scalars.count && isDialogueDash(scalars[idx]) {
      dashIdx = idx
      idx += 1
      while idx < scalars.count && (scalars[idx] == " " || scalars[idx] == "\t" || isBidiControl(scalars[idx])) {
        idx += 1
      }
    }
    let prefixEnd = idx
    var colonIdx: Int?
    var scan = prefixEnd
    while scan < scalars.count {
      if scalars[scan] == ":" {
        colonIdx = scan
        break
      }
      scan += 1
    }
    guard let colon = colonIdx, colon > prefixEnd else { return line }
    let afterColon = colon + 1
    if afterColon < scalars.count {
      let next = scalars[afterColon]
      if next != " " && next != "\t" && !isBidiControl(next) {
        return line
      }
    }
    let candidate = String(String.UnicodeScalarView(scalars[prefixEnd..<colon]))
    guard isAllowedSpeakerLabel(candidate) else { return line }
    var restStart = afterColon
    while restStart < scalars.count && (scalars[restStart] == " " || scalars[restStart] == "\t") {
      restStart += 1
    }
    let rest = String(String.UnicodeScalarView(scalars[restStart...]))
    guard let dIdx = dashIdx else { return rest }
    if rest.isEmpty { return "" }
    let leadingBidi = String(String.UnicodeScalarView(scalars[0..<dIdx]))
    let dashStr = String(scalars[dIdx])
    return "\(leadingBidi)\(dashStr) \(rest)"
  }

  private static func isBlankDashOrMusicOnly(_ line: String) -> Bool {
    for scalar in line.unicodeScalars {
      let ignorable = scalar.properties.isWhitespace
        || isMusicSymbol(scalar)
        || isBidiControl(scalar)
        || isDialogueDash(scalar)
      if !ignorable { return false }
    }
    return true
  }

  private static func trimHorizontalWhitespace(_ text: String) -> String {
    let scalars = Array(text.unicodeScalars)
    var start = 0
    var end = scalars.count
    while start < end && (scalars[start] == " " || scalars[start] == "\t") { start += 1 }
    while end > start && (scalars[end - 1] == " " || scalars[end - 1] == "\t") { end -= 1 }
    return String(String.UnicodeScalarView(scalars[start..<end]))
  }

  private static func collapseHorizontalSpaces(_ text: String) -> String {
    var out: [Unicode.Scalar] = []
    out.reserveCapacity(text.unicodeScalars.count)
    var lastWasSpace = false
    for scalar in text.unicodeScalars {
      if scalar == " " || scalar == "\t" {
        if !lastWasSpace {
          out.append(" ")
          lastWasSpace = true
        }
      } else {
        out.append(scalar)
        lastWasSpace = false
      }
    }
    return String(String.UnicodeScalarView(out))
  }
}

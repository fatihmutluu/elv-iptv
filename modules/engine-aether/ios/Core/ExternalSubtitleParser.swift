import Foundation

/// Supported external text subtitle formats parsed natively on Apple (`#308`, `#32`).
public enum ExternalSubtitleFormat: String, Equatable, Sendable {
  case srt
  case vtt
  case ass
  case ttml
}

/// One normalized, sanitized external subtitle cue with millisecond timing and RTL flag (`#308`, `#32`).
public struct ExternalSubtitleCue: Equatable, Sendable {
  public let startMs: Int
  public let endMs: Int
  public let text: String
  public let isRtl: Bool

  public init(startMs: Int, endMs: Int, text: String, isRtl: Bool = false) {
    self.startMs = startMs
    self.endMs = endMs
    self.text = text
    self.isRtl = isRtl
  }
}

/// Parsed external subtitle track with deterministically sorted cues and binary-search lookup (`#308`, `#32`).
public struct ExternalSubtitleTrackData: Equatable, Sendable {
  public let format: ExternalSubtitleFormat
  public let cues: [ExternalSubtitleCue]
  public let warnings: [String]

  public init(format: ExternalSubtitleFormat, cues: [ExternalSubtitleCue], warnings: [String] = []) {
    self.format = format
    self.cues = cues
    self.warnings = warnings
  }

  /// Returns all cues overlapping `positionMs` (`startMs <= positionMs && positionMs < endMs`).
  public func activeCues(atMs positionMs: Int) -> [ExternalSubtitleCue] {
    ExternalSubtitleParser.activeCues(in: cues, atMs: positionMs)
  }
}

/// Pure Swift 6 tolerant external sidecar subtitle parser supporting SRT, WebVTT, ASS/SSA, and TTML (`<= 4 MiB`).
public enum ExternalSubtitleParser {
  /// Hard byte cap (4 MiB) enforced on external sidecar subtitle payloads (`#308`).
  public static let maxBytes = 4 * 1024 * 1024

  /// Upper bound for parsed subtitle cue timestamps (1,000 days in ms) preventing integer/float overflow traps (`#285`).
  public static let maxSubtitleTimeMs = 86_400_000_000

  /// Allowlisted local subtitle file extensions accepted for `file://` external sidecar URIs (`#308`).
  public static let allowedLocalSubtitleExtensions: Set<String> = [
    "srt", "vtt", "webvtt", "ass", "ssa", "ttml", "dfxp", "sub", "xml",
  ]

  /// Validates a local `file://` subtitle URI (rejecting `..` traversal, non-allowlisted extensions,
  /// symlink extension bypasses, non-regular files, and payloads exceeding `maxBytes`) and reads its bytes (`#308`).
  public static func readValidatedLocalSubtitle(
    url: URL,
    maxBytes: Int = ExternalSubtitleParser.maxBytes
  ) -> Data? {
    let cap = max(0, maxBytes)
    guard cap > 0, url.isFileURL else { return nil }
    if let host = url.host, !host.isEmpty, host.lowercased() != "localhost" {
      return nil
    }
    let rawPath = url.path
    guard !rawPath.isEmpty, !rawPath.contains("\0") else { return nil }
    let rawSegments = rawPath.split(separator: "/", omittingEmptySubsequences: false)
    if rawSegments.contains("..") || url.pathComponents.contains("..") {
      return nil
    }
    let rawExt = url.pathExtension.lowercased()
    guard allowedLocalSubtitleExtensions.contains(rawExt) else { return nil }

    let resolved = url.resolvingSymlinksInPath().standardizedFileURL
    guard resolved.isFileURL else { return nil }
    let resolvedExt = resolved.pathExtension.lowercased()
    guard allowedLocalSubtitleExtensions.contains(resolvedExt) else { return nil }

    do {
      let values = try resolved.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
      guard values.isRegularFile == true else { return nil }
      if let size = values.fileSize, size <= 0 || size > cap {
        return nil
      }
      let handle = try FileHandle(forReadingFrom: resolved)
      defer { try? handle.close() }
      let data = try handle.read(upToCount: cap + 1) ?? Data()
      guard !data.isEmpty, data.count <= cap else { return nil }
      return data
    } catch {
      return nil
    }
  }

  /// Detects a subtitle format from content headers/markers with optional filename or MIME hint.
  public static func detectFormat(_ content: String, hint: String? = nil) -> ExternalSubtitleFormat? {
    let cleaned = stripLeadingBom(content)
      .prefix(4096)
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
      .trimmingCharacters(in: .whitespacesAndNewlines)

    if isWebVttHeader(cleaned) { return .vtt }
    if looksLikeAss(cleaned) { return .ass }
    if looksLikeTtml(cleaned) { return .ttml }

    let hintFormat = formatFromHint(hint)
    if containsTimecodeArrow(cleaned) {
      return hintFormat == .vtt ? .vtt : .srt
    }
    return hintFormat
  }

  /// Decodes raw bytes (UTF-8 with UTF-16 BOM fallback), enforcing `maxBytes`, and parses cues.
  public static func parse(
    data: Data,
    format: ExternalSubtitleFormat? = nil,
    hint: String? = nil,
    maxBytes: Int = ExternalSubtitleParser.maxBytes
  ) -> ExternalSubtitleTrackData {
    let cap = max(0, maxBytes)
    let truncated = data.count > cap
    let slice = truncated ? data.prefix(cap) : data[...]
    let text = decodeText(Data(slice))
    var result = parse(text, format: format, hint: hint, maxBytes: cap)
    if truncated && !result.warnings.contains("input-truncated") {
      result = ExternalSubtitleTrackData(
        format: result.format,
        cues: result.cues,
        warnings: ["input-truncated"] + result.warnings
      )
    }
    return result
  }

  /// Parses SRT, WebVTT, ASS/SSA, or TTML subtitles tolerantly, sorting cues by `(startMs, endMs)`.
  public static func parse(
    _ content: String,
    format: ExternalSubtitleFormat? = nil,
    hint: String? = nil,
    maxBytes: Int = ExternalSubtitleParser.maxBytes
  ) -> ExternalSubtitleTrackData {
    var warnings: [String] = []
    let (bounded, truncated) = truncateUtf8(content, maxBytes: maxBytes)
    if truncated { warnings.append("input-truncated") }

    let normalized = stripLeadingBom(bounded)
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
    let detected = format ?? detectFormat(normalized, hint: hint)

    guard let resolvedFormat = detected else {
      if !normalized.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        warnings.append("unknown-format")
      }
      return ExternalSubtitleTrackData(format: .srt, cues: [], warnings: warnings)
    }

    let rawCues: [(startMs: Int, endMs: Int, text: String)]
    switch resolvedFormat {
    case .srt, .vtt:
      rawCues = parseSrtOrVtt(normalized, format: resolvedFormat, warnings: &warnings)
    case .ass:
      rawCues = parseAss(normalized, warnings: &warnings)
    case .ttml:
      rawCues = parseTtml(normalized, warnings: &warnings)
    }

    var cues: [ExternalSubtitleCue] = []
    cues.reserveCapacity(rawCues.count)
    for raw in rawCues {
      let cleaned = normalizeCueText(raw.text)
      guard !cleaned.isEmpty else { continue }
      cues.append(
        ExternalSubtitleCue(
          startMs: raw.startMs,
          endMs: raw.endMs,
          text: cleaned,
          isRtl: SubtitleBidi.containsStrongRtl(cleaned)
        )
      )
    }

    cues.sort { a, b in
      a.startMs != b.startMs ? a.startMs < b.startMs : a.endMs < b.endMs
    }
    return ExternalSubtitleTrackData(format: resolvedFormat, cues: cues, warnings: warnings)
  }

  /// Binary-search lookup returning all cues active at `positionMs` (`startMs <= positionMs && positionMs < endMs`).
  /// Expects `cues` sorted by `startMs` (as produced by `parse`); handles overlapping cues accurately.
  public static func activeCues(in cues: [ExternalSubtitleCue], atMs positionMs: Int) -> [ExternalSubtitleCue] {
    guard !cues.isEmpty, positionMs >= 0 else { return [] }
    var lo = 0
    var hi = cues.count
    while lo < hi {
      let mid = lo + (hi - lo) / 2
      if cues[mid].startMs <= positionMs {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    guard lo > 0 else { return [] }
    var active: [ExternalSubtitleCue] = []
    for idx in 0..<lo where positionMs < cues[idx].endMs {
      active.append(cues[idx])
    }
    return active
  }

  // MARK: - Encoding & Detection

  private static func decodeText(_ data: Data) -> String {
    if data.count >= 2 {
      if data[0] == 0xFF && data[1] == 0xFE, let s = String(data: data, encoding: .utf16LittleEndian) {
        return s
      }
      if data[0] == 0xFE && data[1] == 0xFF, let s = String(data: data, encoding: .utf16BigEndian) {
        return s
      }
    }
    if let utf8 = String(data: data, encoding: .utf8) {
      return utf8
    }
    return String(decoding: data, as: UTF8.self)
  }

  private static func stripLeadingBom(_ s: String) -> String {
    guard s.unicodeScalars.first == "\u{FEFF}" else { return s }
    return String(s.unicodeScalars.dropFirst())
  }

  private static func truncateUtf8(_ content: String, maxBytes: Int) -> (String, Bool) {
    guard maxBytes > 0 else { return ("", !content.isEmpty) }
    if content.utf8.count <= maxBytes { return (content, false) }
    var bytes = 0
    var kept = String.UnicodeScalarView()
    for scalar in content.unicodeScalars {
      let size = scalar.utf8.count
      if bytes + size > maxBytes {
        return (String(kept), true)
      }
      kept.append(scalar)
      bytes += size
    }
    return (content, false)
  }

  private static func formatFromHint(_ hint: String?) -> ExternalSubtitleFormat? {
    guard let hint else { return nil }
    let base = hint.split(whereSeparator: { $0 == ";" || $0 == "?" || $0 == "#" }).first
      .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines).lowercased() } ?? ""
    guard !base.isEmpty else { return nil }
    if base == "text/vtt" || base == "text/webvtt" || base.hasSuffix(".vtt") || base.hasSuffix(".webvtt") {
      return .vtt
    }
    if base == "application/x-subrip" || base == "text/srt" || base == "application/srt" || base.hasSuffix(".srt") {
      return .srt
    }
    if base == "text/x-ssa" || base == "text/x-ass" || base == "application/x-ssa"
      || base.hasSuffix(".ass") || base.hasSuffix(".ssa")
    {
      return .ass
    }
    if base == "application/ttml+xml" || base == "text/ttml" || base == "application/ttaf+xml"
      || base.hasSuffix(".ttml") || base.hasSuffix(".dfxp") || base.hasSuffix(".xml")
    {
      return .ttml
    }
    return nil
  }

  private static func isWebVttHeader(_ line: String) -> Bool {
    guard line.hasPrefix("WEBVTT") else { return false }
    if line.count == 6 { return true }
    let next = line[line.index(line.startIndex, offsetBy: 6)]
    return next == " " || next == "\t" || next == "\n" || next == "-"
  }

  private static func looksLikeAss(_ sample: String) -> Bool {
    for line in sample.lowercased().split(separator: "\n") {
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed == "[script info]" || trimmed == "[v4+ styles]" || trimmed == "[v4 styles]"
        || trimmed == "[events]" || trimmed.hasPrefix("dialogue:") || trimmed.hasPrefix("dialogue :")
      {
        return true
      }
    }
    return false
  }

  private static func looksLikeTtml(_ sample: String) -> Bool {
    let lower = sample.lowercased()
    if lower.contains("http://www.w3.org/ns/ttml") { return true }
    if let range = lower.range(of: "<tt") {
      let after = range.upperBound
      if after == lower.endIndex { return true }
      let ch = lower[after]
      if ch == " " || ch == "\t" || ch == "\n" || ch == ">" || ch == "/" { return true }
    }
    return lower.contains(":tt ") || lower.contains(":tt>")
  }

  private static func containsTimecodeArrow(_ sample: String) -> Bool {
    for line in sample.split(separator: "\n") {
      if parseTimecodeLine(String(line)) != nil { return true }
    }
    return false
  }

  // MARK: - SRT & WebVTT

  private static func parseSrtOrVtt(
    _ content: String,
    format: ExternalSubtitleFormat,
    warnings: inout [String]
  ) -> [(startMs: Int, endMs: Int, text: String)] {
    let lines = content.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    var cues: [(Int, Int, String)] = []
    var i = 0

    if !lines.isEmpty && (format == .vtt || isWebVttHeader(lines[0])) && isWebVttHeader(lines[0]) {
      i = 1
      while i < lines.count {
        let line = lines[i]
        if line.trimmingCharacters(in: .whitespaces).isEmpty { i += 1; break }
        if parseTimecodeLine(line) != nil || looksLikeMalformedTimecode(line) { break }
        i += 1
      }
    }

    var activeStart: Int?
    var activeEnd: Int?
    var cueLines: [String] = []
    var sawBlank = false
    var pendingAfterBlank: [String] = []

    func flush(followedByTimecode: Bool) {
      guard let startMs = activeStart, let endMs = activeEnd else { return }
      if cueLines.isEmpty && !followedByTimecode && !pendingAfterBlank.isEmpty {
        cueLines = pendingAfterBlank
      } else if followedByTimecode && !sawBlank && cueLines.count > 1,
                isPureDigits(cueLines[cueLines.count - 1].trimmingCharacters(in: .whitespaces))
      {
        cueLines.removeLast()
      }
      if endMs <= startMs {
        warnings.append("non-positive-duration")
      } else {
        let rawText = cueLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        if !rawText.isEmpty {
          cues.append((startMs, endMs, stripSrtVttMarkup(rawText)))
        }
      }
      activeStart = nil
      activeEnd = nil
      cueLines = []
      sawBlank = false
      pendingAfterBlank = []
    }

    while i < lines.count {
      let line = lines[i]
      let trimmed = line.trimmingCharacters(in: .whitespaces)
      if trimmed.isEmpty {
        if activeStart != nil { sawBlank = true; pendingAfterBlank = [] }
        i += 1
        continue
      }
      if (activeStart == nil || sawBlank) && isVttSkipHeader(trimmed) {
        if activeStart != nil { flush(followedByTimecode: true) }
        i += 1
        while i < lines.count {
          let next = lines[i]
          if next.trimmingCharacters(in: .whitespaces).isEmpty { i += 1; break }
          if parseTimecodeLine(next) != nil || looksLikeMalformedTimecode(next) { break }
          i += 1
        }
        continue
      }
      if let (startMs, endMs) = parseTimecodeLine(line) {
        flush(followedByTimecode: true)
        activeStart = startMs
        activeEnd = endMs
        i += 1
        continue
      }
      if looksLikeMalformedTimecode(line) {
        flush(followedByTimecode: true)
        warnings.append("malformed-timecode")
        i += 1
        continue
      }
      if activeStart != nil {
        if sawBlank { pendingAfterBlank.append(line) } else { cueLines.append(line) }
      }
      i += 1
    }

    flush(followedByTimecode: false)
    return cues
  }

  private static func isVttSkipHeader(_ trimmed: String) -> Bool {
    for prefix in ["NOTE", "STYLE", "REGION"] {
      if trimmed == prefix || trimmed.hasPrefix("\(prefix) ") || trimmed.hasPrefix("\(prefix)\t") {
        return true
      }
    }
    return false
  }

  private static func findArrowRange(in line: String) -> Range<String.Index>? {
    for arrow in ["-->", "->", "—>", "–>"] {
      if let range = line.range(of: arrow) { return range }
    }
    return nil
  }

  private static func looksLikeMalformedTimecode(_ line: String) -> Bool {
    guard let arrow = findArrowRange(in: line) else { return false }
    let left = line[..<arrow.lowerBound].trimmingCharacters(in: .whitespaces)
    return left.contains(":") && left.first?.isNumber == true
  }

  private static func parseTimecodeLine(_ line: String) -> (Int, Int)? {
    guard let arrow = findArrowRange(in: line) else { return nil }
    let leftToken = line[..<arrow.lowerBound].trimmingCharacters(in: .whitespaces)
    let rightRemainder = line[arrow.upperBound...].trimmingCharacters(in: .whitespaces)
    let rightToken = rightRemainder.split(whereSeparator: { $0 == " " || $0 == "\t" }).first.map(String.init) ?? ""
    guard let startMs = parseClockTimeMs(leftToken), let endMs = parseClockTimeMs(rightToken) else {
      return nil
    }
    return (startMs, endMs)
  }

  // MARK: - Shared Helpers

  static func boundedClockTimeMs(hours: Int, minutes: Int, seconds: Int, ms: Int) -> Int? {
    let maxHours = maxSubtitleTimeMs / 3_600_000
    guard hours >= 0, hours <= maxHours,
          minutes >= 0, minutes < 60,
          seconds >= 0, seconds < 60,
          ms >= 0, ms <= maxSubtitleTimeMs
    else {
      return nil
    }
    let baseMs = ((hours * 60 + minutes) * 60 + seconds) * 1_000
    guard baseMs <= maxSubtitleTimeMs, ms <= maxSubtitleTimeMs - baseMs else {
      return nil
    }
    return baseMs + ms
  }

  static func parseClockTimeMs(_ raw: String) -> Int? {
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return nil }
    var mainPart = trimmed
    var fracPart: String?
    if let dotOrComma = trimmed.firstIndex(where: { $0 == "." || $0 == "," }) {
      mainPart = String(trimmed[..<dotOrComma])
      fracPart = String(trimmed[trimmed.index(after: dotOrComma)...])
    }
    let colonParts = mainPart.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    var hours = 0
    let minutes: Int
    let seconds: Int
    if colonParts.count == 4 && fracPart == nil {
      guard let h = parseStrictUint(colonParts[0]),
            let m = parseStrictUint(colonParts[1]),
            let s = parseStrictUint(colonParts[2]),
            isPureDigits(colonParts[3])
      else { return nil }
      hours = h; minutes = m; seconds = s; fracPart = colonParts[3]
    } else if colonParts.count == 3 {
      guard let h = parseStrictUint(colonParts[0]),
            let m = parseStrictUint(colonParts[1]),
            let s = parseStrictUint(colonParts[2])
      else { return nil }
      hours = h; minutes = m; seconds = s
    } else if colonParts.count == 2 {
      guard let m = parseStrictUint(colonParts[0]), let s = parseStrictUint(colonParts[1]) else { return nil }
      minutes = m; seconds = s
    } else {
      return nil
    }
    guard minutes < 60, seconds < 60 else { return nil }
    let ms: Int
    if let fracPart {
      guard !fracPart.isEmpty, isPureDigits(fracPart) else { return nil }
      let prefix3 = String(fracPart.prefix(3))
      let padded = prefix3 + String(repeating: "0", count: max(0, 3 - prefix3.count))
      ms = Int(padded) ?? 0
    } else {
      ms = 0
    }
    return boundedClockTimeMs(hours: hours, minutes: minutes, seconds: seconds, ms: ms)
  }

  private static func stripSrtVttMarkup(_ text: String) -> String {
    var out = ""
    out.reserveCapacity(text.count)
    var i = text.startIndex
    while i < text.endIndex {
      let ch = text[i]
      if ch == "<" {
        let afterOpen = text.index(after: i)
        if let close = findDelimitedClose(in: text, from: afterOpen, openChar: "<", closeChar: ">") {
          let inner = String(text[afterOpen..<close])
          let trimmedInner = inner.trimmingCharacters(in: .whitespaces).lowercased()
          if trimmedInner == "br" || trimmedInner == "br/" || trimmedInner == "br /" {
            out.append("\n")
            i = text.index(after: close)
            continue
          }
          if isLikelyHtmlOrVttTag(inner) {
            i = text.index(after: close)
            continue
          }
        }
      } else if ch == "{" {
        let afterOpen = text.index(after: i)
        if afterOpen < text.endIndex,
           text[afterOpen] == "\\",
           let close = findDelimitedClose(in: text, from: text.index(after: afterOpen), openChar: "{", closeChar: "}")
        {
          i = text.index(after: close)
          continue
        }
      }
      out.append(ch)
      i = text.index(after: i)
    }
    return decodeHtmlEntities(out)
  }

  /// Linear bounded delimiter search: scans forward until `closeChar`, aborting immediately if
  /// another `openChar` appears first so unclosed delimiters (`<a><a>...`, `{\\{\\...`) stay strictly O(N).
  private static func findDelimitedClose(
    in text: String,
    from start: String.Index,
    openChar: Character,
    closeChar: Character
  ) -> String.Index? {
    var j = start
    while j < text.endIndex {
      let ch = text[j]
      if ch == closeChar { return j }
      if ch == openChar { return nil }
      j = text.index(after: j)
    }
    return nil
  }

  private static func isLikelyHtmlOrVttTag(_ inner: String) -> Bool {
    guard let first = inner.first else { return false }
    if first == "/" {
      guard let second = inner.dropFirst().first else { return false }
      return second.isASCII && second.isLetter
    }
    if first.isASCII && first.isLetter { return true }
    return first.isASCII && first.isNumber && inner.contains(":")
  }

  private static func normalizeCueText(_ raw: String) -> String {
    raw.split(separator: "\n")
      .map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { !$0.isEmpty }
      .joined(separator: "\n")
  }

  static func isPureDigits(_ s: String) -> Bool {
    !s.isEmpty && s.allSatisfy { $0.isASCII && $0.isNumber }
  }

  static func parseStrictUint(_ s: String) -> Int? {
    guard isPureDigits(s) else { return nil }
    return Int(s)
  }

  static func decodeHtmlEntities(_ input: String) -> String {
    guard input.contains("&") else { return input }
    var out = ""
    out.reserveCapacity(input.count)
    var i = input.startIndex
    while i < input.endIndex {
      if input[i] == "&" {
        let afterAmp = input.index(after: i)
        var j = afterAmp
        var steps = 0
        var semi: String.Index?
        while j < input.endIndex && steps < 16 {
          let ch = input[j]
          if ch == ";" {
            semi = j
            break
          }
          if ch == "&" || ch.isWhitespace {
            break
          }
          j = input.index(after: j)
          steps += 1
        }
        if let semi {
          let entity = String(input[afterAmp..<semi])
          if let decoded = decodeSingleEntity(entity) {
            out.append(decoded)
            i = input.index(after: semi)
            continue
          }
        }
      }
      out.append(input[i])
      i = input.index(after: i)
    }
    return out
  }

  private static func decodeSingleEntity(_ entity: String) -> String? {
    switch entity.lowercased() {
    case "amp": return "&"
    case "lt": return "<"
    case "gt": return ">"
    case "quot": return "\""
    case "apos": return "'"
    case "nbsp": return " "
    default:
      guard entity.hasPrefix("#") else { return nil }
      let rest = entity.dropFirst()
      let code: UInt32? = (rest.hasPrefix("x") || rest.hasPrefix("X"))
        ? UInt32(rest.dropFirst(), radix: 16)
        : UInt32(rest, radix: 10)
      guard let code, let scalar = Unicode.Scalar(code) else { return nil }
      return String(scalar)
    }
  }
}

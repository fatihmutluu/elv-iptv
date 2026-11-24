import Foundation

extension ExternalSubtitleParser {
  private static let defaultAssFields = [
    "layer", "start", "end", "style", "name",
    "marginl", "marginr", "marginv", "effect", "text",
  ]

  // MARK: - ASS / SSA

  static func parseAss(
    _ content: String,
    warnings: inout [String]
  ) -> [(startMs: Int, endMs: Int, text: String)] {
    var cues: [(Int, Int, String)] = []
    var inEvents = false
    var sawAnySection = false
    var fields: [String]?
    var warnedMissingFormat = false

    for rawLine in content.split(separator: "\n", omittingEmptySubsequences: false) {
      let trimmed = String(rawLine).trimmingCharacters(in: .whitespaces)
      if trimmed.hasPrefix("[") && trimmed.hasSuffix("]") && trimmed.count >= 2 {
        sawAnySection = true
        let name = trimmed.dropFirst().dropLast().trimmingCharacters(in: .whitespaces).lowercased()
        inEvents = (name == "events")
        continue
      }
      if sawAnySection && !inEvents { continue }

      if let formatRest = stripPrefixCaseInsensitive(trimmed, key: "format") {
        fields = formatRest
          .split(separator: ",")
          .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
          .filter { !$0.isEmpty }
        continue
      }

      guard let dialogueRest = stripPrefixCaseInsensitive(trimmed, key: "dialogue") else { continue }
      let activeFields: [String]
      if let fields {
        activeFields = fields
      } else {
        activeFields = defaultAssFields
        if !warnedMissingFormat {
          warnings.append("missing-ass-format")
          warnedMissingFormat = true
        }
      }
      guard let startIdx = activeFields.firstIndex(of: "start"),
            let endIdx = activeFields.firstIndex(of: "end"),
            let textIdx = activeFields.firstIndex(of: "text")
      else {
        warnings.append("malformed-ass-format")
        continue
      }
      guard let cols = splitAssFields(dialogueRest, count: activeFields.count, textIdx: textIdx) else {
        warnings.append("malformed-dialogue")
        continue
      }
      guard let startMs = parseClockTimeMs(cols[startIdx]), let endMs = parseClockTimeMs(cols[endIdx]) else {
        warnings.append("malformed-timecode")
        continue
      }
      guard endMs > startMs else {
        warnings.append("non-positive-duration")
        continue
      }
      let stripped = stripAssOverridesAndDrawings(cols[textIdx])
      if !stripped.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        cues.append((startMs, endMs, stripped))
      }
    }
    return cues
  }

  private static func stripPrefixCaseInsensitive(_ line: String, key: String) -> String? {
    guard let colon = line.firstIndex(of: ":") else { return nil }
    let head = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
    guard head == key else { return nil }
    return String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces)
  }

  private static func splitAssFields(_ raw: String, count: Int, textIdx: Int) -> [String]? {
    guard count > 0, textIdx >= 0, textIdx < count else { return nil }
    var result = Array(repeating: "", count: count)
    var left = raw.startIndex
    for col in 0..<textIdx {
      guard let comma = raw[left...].firstIndex(of: ",") else { return nil }
      result[col] = String(raw[left..<comma])
      left = raw.index(after: comma)
    }
    var right = raw.endIndex
    if count - 1 > textIdx {
      for col in stride(from: count - 1, through: textIdx + 1, by: -1) {
        guard let comma = raw[left..<right].lastIndex(of: ",") else { return nil }
        result[col] = String(raw[raw.index(after: comma)..<right])
        right = comma
      }
    }
    result[textIdx] = String(raw[left..<right])
    return result
  }

  private static func stripAssOverridesAndDrawings(_ text: String) -> String {
    var out = ""
    out.reserveCapacity(text.count)
    var inDrawing = false
    var i = text.startIndex
    while i < text.endIndex {
      if let open = text[i...].firstIndex(of: "{") {
        if !inDrawing && open > i {
          out.append(contentsOf: text[i..<open])
        }
        let close = text[text.index(after: open)...].firstIndex(of: "}")
        let block = close.map { String(text[text.index(after: open)..<$0]) } ?? String(text[text.index(after: open)...])
        updateAssDrawingState(block: block, inDrawing: &inDrawing)
        guard let close else { break }
        i = text.index(after: close)
      } else {
        if !inDrawing {
          out.append(contentsOf: text[i...])
        }
        break
      }
    }
    return out
      .replacingOccurrences(of: "\\N", with: "\n")
      .replacingOccurrences(of: "\\n", with: "\n")
      .replacingOccurrences(of: "\\h", with: " ")
  }

  private static func updateAssDrawingState(block: String, inDrawing: inout Bool) {
    var idx = block.startIndex
    while let range = block[idx...].range(of: "\\p") {
      let digitsStart = range.upperBound
      var digitsEnd = digitsStart
      while digitsEnd < block.endIndex && block[digitsEnd].isASCII && block[digitsEnd].isNumber {
        digitsEnd = block.index(after: digitsEnd)
      }
      if digitsEnd > digitsStart, let level = Int(block[digitsStart..<digitsEnd]) {
        inDrawing = level > 0
      }
      idx = digitsEnd
    }
  }

  // MARK: - TTML

  static func parseTtml(
    _ content: String,
    warnings: inout [String]
  ) -> [(startMs: Int, endMs: Int, text: String)] {
    var frameRate = 30.0
    var tickRate = 10_000_000.0
    if let rootAttrs = extractFirstTagAttributes(in: content, localName: "tt") {
      if let fps = rootAttrs["framerate"].flatMap(Double.init), fps.isFinite, fps > 0, fps <= 1_000_000 {
        frameRate = fps
      }
      if let tick = rootAttrs["tickrate"].flatMap(Double.init), tick.isFinite, tick > 0, tick <= 1e15 {
        tickRate = tick
      }
    }

    var cues: [(Int, Int, String)] = []
    var searchStart = content.startIndex
    while let openTag = findNextOpenTag(in: content, from: searchStart, localName: "p") {
      guard let closeTag = findCloseTag(in: content, from: openTag.contentStart, localName: "p") else {
        break
      }
      searchStart = closeTag.afterClose
      let attrs = parseXmlAttributes(openTag.attrString)
      let body = String(content[openTag.contentStart..<closeTag.tagStart])
      guard let beginRaw = attrs["begin"] else { continue }
      let startMs = parseTtmlTimeMs(beginRaw, frameRate: frameRate, tickRate: tickRate)
      let endMs: Int?
      if let endRaw = attrs["end"] {
        endMs = parseTtmlTimeMs(endRaw, frameRate: frameRate, tickRate: tickRate)
      } else if let durRaw = attrs["dur"], let startMs,
                let durMs = parseTtmlTimeMs(durRaw, frameRate: frameRate, tickRate: tickRate),
                durMs <= maxSubtitleTimeMs - startMs
      {
        endMs = startMs + durMs
      } else {
        endMs = nil
      }
      guard let startMs, let endMs else {
        warnings.append("malformed-timecode")
        continue
      }
      guard endMs > startMs else {
        warnings.append("non-positive-duration")
        continue
      }
      let collapsedRaw = body
        .replacingOccurrences(of: "\t", with: " ")
        .replacingOccurrences(of: "\n", with: " ")
      let stripped = stripTtmlBodyTags(collapsedRaw)
      let cleaned = decodeHtmlEntities(stripped)
        .split(separator: "\n")
        .map { collapseSpaces(String($0)).trimmingCharacters(in: .whitespaces) }
        .filter { !$0.isEmpty }
        .joined(separator: "\n")
      if !cleaned.isEmpty {
        cues.append((startMs, endMs, cleaned))
      }
    }
    return cues
  }

  private static func extractFirstTagAttributes(in xml: String, localName: String) -> [String: String]? {
    guard let tag = findNextOpenTag(in: xml, from: xml.startIndex, localName: localName) else { return nil }
    return parseXmlAttributes(tag.attrString)
  }

  private static func findNextOpenTag(
    in xml: String,
    from start: String.Index,
    localName: String
  ) -> (attrString: String, contentStart: String.Index)? {
    var cursor = start
    while let lt = xml[cursor...].firstIndex(of: "<") {
      let nameStart = xml.index(after: lt)
      guard nameStart < xml.endIndex else { return nil }
      if xml[nameStart] == "/" || xml[nameStart] == "?" || xml[nameStart] == "!" || xml[nameStart] == "<" {
        cursor = nameStart
        continue
      }
      var nameEnd = nameStart
      while nameEnd < xml.endIndex {
        let ch = xml[nameEnd]
        if ch == " " || ch == "\t" || ch == "\n" || ch == ">" || ch == "/" || ch == "<" { break }
        nameEnd = xml.index(after: nameEnd)
      }
      if nameEnd < xml.endIndex && xml[nameEnd] == "<" {
        cursor = nameEnd
        continue
      }
      let fullName = String(xml[nameStart..<nameEnd]).lowercased()
      let tagLocal = fullName.split(separator: ":").last.map(String.init) ?? fullName
      var gtScan = nameEnd
      var foundGt: String.Index?
      while gtScan < xml.endIndex {
        let ch = xml[gtScan]
        if ch == ">" { foundGt = gtScan; break }
        if ch == "<" { break }
        gtScan = xml.index(after: gtScan)
      }
      guard let gt = foundGt else {
        if gtScan < xml.endIndex && xml[gtScan] == "<" {
          cursor = gtScan
          continue
        }
        return nil
      }
      if tagLocal == localName {
        let isSelfClosing = gt > nameEnd && xml[xml.index(before: gt)] == "/"
        if !isSelfClosing {
          return (String(xml[nameEnd..<gt]), xml.index(after: gt))
        }
      }
      cursor = xml.index(after: gt)
    }
    return nil
  }

  private static func findCloseTag(
    in xml: String,
    from start: String.Index,
    localName: String
  ) -> (tagStart: String.Index, afterClose: String.Index)? {
    var cursor = start
    while let range = xml[cursor...].range(of: "</") {
      let nameStart = range.upperBound
      var j = nameStart
      var foundGt: String.Index?
      while j < xml.endIndex {
        let ch = xml[j]
        if ch == ">" { foundGt = j; break }
        if ch == "<" { break }
        j = xml.index(after: j)
      }
      guard let gt = foundGt else {
        if j < xml.endIndex && xml[j] == "<" {
          cursor = j
          continue
        }
        return nil
      }
      let fullName = xml[nameStart..<gt].trimmingCharacters(in: .whitespaces).lowercased()
      let tagLocal = fullName.split(separator: ":").last.map(String.init) ?? fullName
      if tagLocal == localName {
        return (range.lowerBound, xml.index(after: gt))
      }
      cursor = xml.index(after: gt)
    }
    return nil
  }

  private static func parseXmlAttributes(_ source: String) -> [String: String] {
    var attrs: [String: String] = [:]
    var i = source.startIndex
    while i < source.endIndex {
      while i < source.endIndex && source[i].isWhitespace { i = source.index(after: i) }
      guard i < source.endIndex else { break }
      let keyStart = i
      while i < source.endIndex && !source[i].isWhitespace && source[i] != "=" {
        i = source.index(after: i)
      }
      let rawKey = String(source[keyStart..<i]).lowercased()
      while i < source.endIndex && source[i].isWhitespace { i = source.index(after: i) }
      guard i < source.endIndex, source[i] == "=" else {
        if i < source.endIndex { i = source.index(after: i) }
        continue
      }
      i = source.index(after: i)
      while i < source.endIndex && source[i].isWhitespace { i = source.index(after: i) }
      guard i < source.endIndex, source[i] == "\"" || source[i] == "'" else { continue }
      let quote = source[i]
      i = source.index(after: i)
      let valStart = i
      while i < source.endIndex && source[i] != quote { i = source.index(after: i) }
      let value = String(source[valStart..<i])
      if i < source.endIndex { i = source.index(after: i) }
      guard !rawKey.isEmpty else { continue }
      attrs[rawKey] = value
      if let colon = rawKey.firstIndex(of: ":") {
        let local = String(rawKey[rawKey.index(after: colon)...])
        if attrs[local] == nil { attrs[local] = value }
      }
    }
    return attrs
  }

  private static func parseTtmlTimeMs(_ raw: String, frameRate: Double, tickRate: Double) -> Int? {
    let trimmed = raw.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return nil }
    let maxDouble = Double(maxSubtitleTimeMs)
    let units: [(String, Double)] = [
      ("ms", 1.0), ("h", 3_600_000.0), ("m", 60_000.0),
      ("s", 1_000.0), ("f", 1_000.0 / frameRate), ("t", 1_000.0 / tickRate),
    ]
    for (suffix, multiplier) in units {
      if trimmed.hasSuffix(suffix) {
        let numStr = String(trimmed.dropLast(suffix.count))
        guard let val = Double(numStr),
              val.isFinite,
              val >= 0,
              multiplier.isFinite,
              multiplier > 0,
              val <= maxDouble / multiplier
        else {
          return nil
        }
        let scaled = (val * multiplier).rounded()
        guard scaled.isFinite, scaled >= 0, scaled <= maxDouble else {
          return nil
        }
        return Int(scaled)
      }
    }
    let parts = trimmed.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
    if parts.count == 4,
       let h = parseStrictUint(parts[0]),
       let m = parseStrictUint(parts[1]),
       let s = parseStrictUint(parts[2]),
       m < 60, s < 60
    {
      let frameStr = parts[3].split(separator: ".").first.map(String.init) ?? parts[3]
      guard let frames = Double(frameStr),
            frames.isFinite,
            frames >= 0,
            frameRate.isFinite,
            frameRate > 0,
            frames <= (maxDouble / 1_000.0) * frameRate
      else {
        return nil
      }
      let scaledFrameMs = ((frames / frameRate) * 1_000.0).rounded()
      guard scaledFrameMs.isFinite, scaledFrameMs >= 0, scaledFrameMs <= maxDouble else {
        return nil
      }
      return boundedClockTimeMs(hours: h, minutes: m, seconds: s, ms: Int(scaledFrameMs))
    }
    return parseClockTimeMs(trimmed)
  }

  private static func stripTtmlBodyTags(_ body: String) -> String {
    var out = ""
    out.reserveCapacity(body.count)
    var i = body.startIndex
    while i < body.endIndex {
      if body[i] == "<" {
        let afterOpen = body.index(after: i)
        var j = afterOpen
        var foundGt: String.Index?
        while j < body.endIndex {
          let ch = body[j]
          if ch == ">" { foundGt = j; break }
          if ch == "<" { break }
          j = body.index(after: j)
        }
        if let gt = foundGt {
          let inner = String(body[afterOpen..<gt]).trimmingCharacters(in: .whitespaces).lowercased()
          let firstToken = inner.split(whereSeparator: { $0 == " " || $0 == "/" }).first.map(String.init) ?? ""
          let local = firstToken.split(separator: ":").last.map(String.init) ?? firstToken
          if local == "br" { out.append("\n") }
          i = body.index(after: gt)
          continue
        }
      }
      out.append(body[i])
      i = body.index(after: i)
    }
    return out
  }

  private static func collapseSpaces(_ s: String) -> String {
    var out = ""
    out.reserveCapacity(s.count)
    var prevSpace = false
    for ch in s {
      if ch == " " {
        if !prevSpace { out.append(" "); prevSpace = true }
      } else {
        out.append(ch)
        prevSpace = false
      }
    }
    return out
  }
}

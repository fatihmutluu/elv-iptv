import Foundation

/// Low-level UTF-8 byte-array XML tokenization helpers for `XmltvByteScanner`.
enum XmltvByteTokens {
  static let bValue = Array("value".utf8)

  static func indexOfByte(_ bytes: [UInt8], from: Int, to: Int, target: UInt8) -> Int {
    var i = from
    while i < to {
      if bytes[i] == target { return i }
      i += 1
    }
    return -1
  }

  static func matchesAt(_ bytes: [UInt8], at: Int, needle: [UInt8]) -> Bool {
    guard at >= 0 && at + needle.count <= bytes.count else { return false }
    for i in 0..<needle.count where bytes[at + i] != needle[i] { return false }
    return true
  }

  static func isMarkupStart(_ b: UInt8) -> Bool {
    b == 47 || b == 33 || b == 63 ||
      (b >= 65 && b <= 90) || (b >= 97 && b <= 122) || b == 95 || b == 58 || b >= 0x80
  }

  static func isNameStop(_ b: UInt8) -> Bool {
    b == 32 || b == 9 || b == 13 || b == 10 || b == 62 || b == 47 || b == 61
  }

  static func isWs(_ b: UInt8) -> Bool {
    b == 32 || b == 9 || b == 13 || b == 10
  }

  static func nameEnd(_ bytes: [UInt8], from: Int, limit: Int) -> Int {
    var i = from
    while i < limit && !isNameStop(bytes[i]) { i += 1 }
    return i
  }

  static func isTag(_ bytes: [UInt8], at: Int, len: Int, expected: [UInt8]) -> Bool {
    guard len == expected.count else { return false }
    for i in 0..<len where bytes[at + i] != expected[i] { return false }
    return true
  }

  static func matchTagName(_ bytes: [UInt8], at: Int, limit: Int, expected: [UInt8]) -> Int {
    if at + expected.count >= limit { return -1 }
    for i in 0..<expected.count where bytes[at + i] != expected[i] { return 0 }
    let after = bytes[at + expected.count]
    return (after == 32 || after == 9 || after == 13 || after == 10 || after == 62 || after == 47) ? 1 : 0
  }

  static func findTagEnd(_ bytes: [UInt8], lt: Int, limit: Int) -> Int {
    var i = lt + 1
    var quote: UInt8 = 0
    while i < limit {
      let b = bytes[i]
      if quote != 0 {
        if b == quote { quote = 0 }
      } else {
        if b == 34 || b == 39 { quote = b }
        else if b == 62 { return i + 1 }
        else if b == 60 { return -2 }
      }
      i += 1
    }
    return -1
  }

  static func skipMarkup(_ bytes: [UInt8], lt: Int, limit: Int) -> Int {
    if lt + 1 >= limit { return -1 }
    let b1 = bytes[lt + 1]
    if b1 == 63 { // '?'
      var i = lt + 2
      while i + 1 < limit {
        if bytes[i] == 63 && bytes[i + 1] == 62 { return i + 2 }
        i += 1
      }
      return -1
    }
    if b1 == 33 { // '!'
      if lt + 3 < limit && bytes[lt + 2] == 45 && bytes[lt + 3] == 45 {
        var i = lt + 4
        while i + 2 < limit {
          if bytes[i] == 45 && bytes[i + 1] == 45 && bytes[i + 2] == 62 { return i + 3 }
          i += 1
        }
        return -1
      }
      if lt + 8 < limit && isCdataStart(bytes, lt: lt) {
        var i = lt + 9
        while i + 2 < limit {
          if bytes[i] == 93 && bytes[i + 1] == 93 && bytes[i + 2] == 62 { return i + 3 }
          i += 1
        }
        return -1
      }
      if lt + 8 >= limit { return -1 }
      var i = lt + 2
      var depth = 0
      var quote: UInt8 = 0
      while i < limit {
        let b = bytes[i]
        if quote != 0 {
          if b == quote { quote = 0 }
        } else {
          if b == 34 || b == 39 { quote = b }
          else if b == 91 { depth += 1 }
          else if b == 93 && depth > 0 { depth -= 1 }
          else if b == 62 && depth == 0 { return i + 1 }
        }
        i += 1
      }
      return -1
    }
    return lt + 1
  }

  private static func isCdataStart(_ bytes: [UInt8], lt: Int) -> Bool {
    bytes[lt + 2] == 91 && bytes[lt + 3] == 67 && bytes[lt + 4] == 68 &&
      bytes[lt + 5] == 65 && bytes[lt + 6] == 84 && bytes[lt + 7] == 65 && bytes[lt + 8] == 91
  }

  static func findCloseTag(
    _ bytes: [UInt8],
    from: Int,
    limit: Int,
    name: [UInt8],
    allowIncomplete: Bool
  ) -> Int {
    var pos = from
    while pos < limit {
      let lt = indexOfByte(bytes, from: pos, to: limit, target: 60)
      if lt < 0 || lt + 1 >= limit { return -1 }
      let b1 = bytes[lt + 1]
      if b1 == 33 || b1 == 63 {
        let skip = skipMarkup(bytes, lt: lt, limit: limit)
        if skip < 0 { return -1 }
        pos = skip
        continue
      }
      if b1 == 47 {
        let needed = lt + 2 + name.count
        if needed >= limit { return allowIncomplete ? -1 : -2 }
        var same = true
        for j in 0..<name.count where bytes[lt + 2 + j] != name[j] {
          same = false
          break
        }
        if same {
          let after = bytes[needed]
          if after == 62 || isWs(after) { return lt }
        }
      }
      pos = lt + 1
    }
    return -1
  }

  static func readAttr(_ bytes: [UInt8], from: Int, to: Int, target: String) -> String? {
    var found: String?
    readAttrs(bytes, from: from, to: to) { name, value in
      if name == target && found == nil { found = value }
    }
    return found
  }

  static func readAttrs(_ bytes: [UInt8], from: Int, to: Int, onAttr: (String, String) -> Void) {
    var i = from
    while i < to {
      while i < to && isWs(bytes[i]) { i += 1 }
      if i >= to || bytes[i] == 47 || bytes[i] == 62 { break }
      let ns = i
      while i < to && !isNameStop(bytes[i]) { i += 1 }
      let ne = i
      if ne == ns { i += 1; continue }
      while i < to && isWs(bytes[i]) { i += 1 }
      if i >= to || bytes[i] != 61 { continue }
      i += 1
      while i < to && isWs(bytes[i]) { i += 1 }
      if i >= to { break }
      let q = bytes[i]
      if q != 34 && q != 39 { continue }
      i += 1
      let vs = i
      while i < to && bytes[i] != q { i += 1 }
      let ve = i
      if i < to { i += 1 }
      let name = String(decoding: bytes[ns..<ne], as: UTF8.self)
      let val = XmltvTextHelpers.decodeXmlEntities(String(decoding: bytes[vs..<ve], as: UTF8.self))
      onAttr(name, val)
    }
  }

  static func readElementText(_ bytes: [UInt8], from: Int, to: Int) -> String {
    guard from < to else { return "" }
    if indexOfByte(bytes, from: from, to: to, target: 60) < 0 {
      return XmltvTextHelpers.decodeXmlEntities(String(decoding: bytes[from..<to], as: UTF8.self))
        .trimmingCharacters(in: .whitespacesAndNewlines)
    }
    var out = ""
    var pos = from
    while pos < to {
      let lt = indexOfByte(bytes, from: pos, to: to, target: 60)
      if lt < 0 {
        out.append(XmltvTextHelpers.decodeXmlEntities(String(decoding: bytes[pos..<to], as: UTF8.self)))
        break
      }
      if lt > pos {
        out.append(XmltvTextHelpers.decodeXmlEntities(String(decoding: bytes[pos..<lt], as: UTF8.self)))
      }
      if lt + 8 < to && bytes[lt + 1] == 33 && isCdataStart(bytes, lt: lt) {
        var end = lt + 9
        while end + 2 < to {
          if bytes[end] == 93 && bytes[end + 1] == 93 && bytes[end + 2] == 62 { break }
          end += 1
        }
        if end + 2 < to {
          out.append(String(decoding: bytes[(lt + 9)..<end], as: UTF8.self))
          pos = end + 3
          continue
        }
      }
      let skip = skipMarkup(bytes, lt: lt, limit: to)
      if skip > lt { pos = skip }
      else { out.append("<"); pos = lt + 1 }
    }
    return out.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  static func extractRatingValue(_ bytes: [UInt8], from: Int, to: Int) -> String? {
    var pos = from
    while pos < to {
      let lt = indexOfByte(bytes, from: pos, to: to, target: 60)
      if lt < 0 || lt + 1 >= to { return nil }
      let b1 = bytes[lt + 1]
      if !isMarkupStart(b1) { pos = lt + 1; continue }
      if b1 == 47 {
        let gt = indexOfByte(bytes, from: lt + 2, to: to, target: 62)
        if gt < 0 { return nil }
        pos = gt + 1
        continue
      }
      if b1 == 33 || b1 == 63 {
        let skip = skipMarkup(bytes, lt: lt, limit: to)
        if skip < 0 { return nil }
        pos = skip
        continue
      }
      let tagEnd = findTagEnd(bytes, lt: lt, limit: to)
      if tagEnd < 0 { return nil }
      let ns = lt + 1
      let nLen = nameEnd(bytes, from: ns, limit: tagEnd) - ns
      let selfClosing = bytes[tagEnd - 2] == 47
      if !selfClosing && isTag(bytes, at: ns, len: nLen, expected: bValue) {
        let close = findCloseTag(bytes, from: tagEnd, limit: to, name: bValue, allowIncomplete: false)
        if close < 0 { return nil }
        let t = readElementText(bytes, from: tagEnd, to: close)
        if !t.isEmpty { return t }
        let gt = indexOfByte(bytes, from: close, to: to, target: 62)
        if gt < 0 { return nil }
        pos = gt + 1
        continue
      }
      pos = tagEnd
    }
    return nil
  }
}

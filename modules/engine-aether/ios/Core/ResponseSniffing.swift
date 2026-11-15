import Foundation

/// Number of initial bytes inspected before classifying a progressive live response.
public let sniffBytes = 1_024

private let tsPacketSize = 188
private let tsSyncByte: UInt8 = 0x47
private let utf8Bom: [UInt8] = [0xEF, 0xBB, 0xBF]
private let extM3uMarker = Array("#EXTM3U".utf8)

private let hlsContentTypes: Set<String> = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
]

/// Classification of a 2xx response on a progressive live stream guess.
public enum ProgressiveVerdict: Equatable, Sendable {
  case media(formatHint: String?)
  case playlist
  case notice
}

/// Returns true when `contentType` names an HLS playlist media type.
public func isHlsContentType(_ contentType: String?) -> Bool {
  guard let raw = contentType else { return false }
  let mediaType = raw.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
    .first?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
  guard let mediaType else { return false }
  return hlsContentTypes.contains(mediaType)
}

/// Returns true when `contentType` is HTML, XHTML, JSON, or `text/*` on a non-HLS progressive stream.
public func isProgressiveNoticeContentType(_ contentType: String?) -> Bool {
  guard let raw = contentType else { return false }
  let mediaType = raw.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
    .first?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
  guard let mediaType, !mediaType.isEmpty else { return false }
  if mediaType == "text/html" || mediaType == "application/xhtml+xml" || mediaType == "application/json" {
    return true
  }
  return mediaType.hasPrefix("text/") && !hlsContentTypes.contains(mediaType)
}

/// Returns true when `prefix` begins with `#EXTM3U` after an optional UTF-8 BOM and ASCII whitespace.
public func hasExtM3uSignature(_ prefix: Data) -> Bool {
  let bytes = [UInt8](prefix.prefix(sniffBytes))
  return startsWithAfterBomAndBlanks(bytes, marker: extM3uMarker)
}

/// Classifies a progressive stream response from its `Content-Type` header and initial `prefix` bytes.
public func classifyProgressive(contentType: String?, prefix: Data) -> ProgressiveVerdict {
  let bytes = [UInt8](prefix.prefix(sniffBytes))
  if isHlsContentType(contentType) || startsWithAfterBomAndBlanks(bytes, marker: extM3uMarker) {
    return .playlist
  }
  if isProgressiveNoticeContentType(contentType) {
    return .notice
  }
  let tsSync = hasTsSync(bytes)
  if !bytes.isEmpty && isValidPrintableUtf8(bytes) && !tsSync {
    return .notice
  }
  if tsSync {
    return .media(formatHint: "mpegts")
  }
  return .media(formatHint: nil)
}

private func startsWithAfterBomAndBlanks(_ bytes: [UInt8], marker: [UInt8]) -> Bool {
  var start = 0
  if bytes.count >= utf8Bom.count && Array(bytes[0..<utf8Bom.count]) == utf8Bom {
    start = utf8Bom.count
  }
  while start < bytes.count {
    let b = bytes[start]
    if b == 0x20 || b == 0x09 || b == 0x0D || b == 0x0A {
      start += 1
    } else {
      break
    }
  }
  guard bytes.count - start >= marker.count else { return false }
  for i in 0..<marker.count where bytes[start + i] != marker[i] {
    return false
  }
  return true
}

private func hasTsSync(_ bytes: [UInt8]) -> Bool {
  let limit = max(0, min(tsPacketSize, bytes.count - tsPacketSize))
  guard limit > 0 else { return false }
  for start in 0..<limit {
    var count = 0
    var allSync = true
    var pos = start
    while pos < bytes.count && count < 3 {
      if bytes[pos] != tsSyncByte {
        allSync = false
        break
      }
      count += 1
      pos += tsPacketSize
    }
    if allSync && count >= 2 {
      return true
    }
  }
  return false
}

private func isValidPrintableUtf8(_ bytes: [UInt8]) -> Bool {
  let length = bytes.count
  var i = 0
  while i < length {
    let b0 = bytes[i]
    switch b0 {
    case 0x09, 0x0A, 0x0D, 0x20...0x7E:
      i += 1
    case 0xC2...0xDF:
      if !checkContinuations(bytes, start: i + 1, count: 1, firstRange: 0x80...0xBF) { return false }
      i += 2
    case 0xE0:
      if !checkContinuations(bytes, start: i + 1, count: 2, firstRange: 0xA0...0xBF) { return false }
      i += 3
    case 0xE1...0xEC, 0xEE...0xEF:
      if !checkContinuations(bytes, start: i + 1, count: 2, firstRange: 0x80...0xBF) { return false }
      i += 3
    case 0xED:
      if !checkContinuations(bytes, start: i + 1, count: 2, firstRange: 0x80...0x9F) { return false }
      i += 3
    case 0xF0:
      if !checkContinuations(bytes, start: i + 1, count: 3, firstRange: 0x90...0xBF) { return false }
      i += 4
    case 0xF1...0xF3:
      if !checkContinuations(bytes, start: i + 1, count: 3, firstRange: 0x80...0xBF) { return false }
      i += 4
    case 0xF4:
      if !checkContinuations(bytes, start: i + 1, count: 3, firstRange: 0x80...0x8F) { return false }
      i += 4
    default:
      return false
    }
  }
  return true
}

private func checkContinuations(
  _ bytes: [UInt8],
  start: Int,
  count: Int,
  firstRange: ClosedRange<UInt8>
) -> Bool {
  let length = bytes.count
  if start + count > length && length < sniffBytes {
    return false
  }
  let end = min(start + count, length)
  guard start < end else { return true }
  for idx in start..<end {
    let b = bytes[idx]
    let allowed = (idx == start) ? firstRange : (0x80...0xBF)
    if !allowed.contains(b) {
      return false
    }
  }
  return true
}

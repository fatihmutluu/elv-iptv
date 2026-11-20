import Foundation

private let mask = "***"

private let safeExtensions: Set<String> = [
  ".ts", ".m2ts", ".mts", ".m3u8", ".m3u", ".mp4", ".m4s", ".m4v", ".m4a",
  ".mkv", ".webm", ".avi", ".mov", ".flv", ".mpd", ".aac", ".mp3", ".ac3",
  ".eac3", ".ogg", ".opus", ".wav", ".flac", ".srt", ".vtt", ".ass", ".ssa",
  ".sub", ".xml", ".gz", ".php",
]

/// Strict allowlist URL redaction: preserves only `scheme://host(:port)` and a safe media/playlist
/// extension on the final non-empty segment, masking all path segments, user-info, matrix parameters
/// (`;...`), query strings (`?...`), and fragments (`#...`).
public func redactUrl(_ url: String) -> String {
  let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return "" }

  let noFragment = substringBefore(trimmed, delimiter: "#")
  let withoutTail = substringBefore(noFragment, delimiter: "?")
  guard !withoutTail.isEmpty else { return "" }

  let origin: String
  let path: String
  if let schemeRange = withoutTail.range(of: "://") {
    let authorityStart = schemeRange.upperBound
    let remainder = withoutTail[authorityStart...]
    let authorityEnd = remainder.firstIndex(of: "/") ?? withoutTail.endIndex
    let rawAuthority = String(withoutTail[authorityStart..<authorityEnd])
    let hostPart: String
    if let atIndex = rawAuthority.lastIndex(of: "@") {
      hostPart = String(rawAuthority[rawAuthority.index(after: atIndex)...])
    } else {
      hostPart = rawAuthority
    }
    let cleanAuthority = substringBefore(hostPart, delimiter: ";")
    origin = String(withoutTail[..<authorityStart]) + cleanAuthority
    path = String(withoutTail[authorityEnd...])
  } else {
    origin = ""
    path = withoutTail
  }

  return origin + redactPath(path)
}

private func substringBefore(_ text: String, delimiter: Character) -> String {
  guard let index = text.firstIndex(of: delimiter) else { return text }
  return String(text[..<index])
}

private func redactPath(_ path: String) -> String {
  guard !path.isEmpty else { return "" }
  if path == "/" { return "/" }
  if path.hasPrefix(";") {
    return ""
  }
  if !path.hasPrefix("/") {
    return maskSegment(path, isLastNonEmpty: true)
  }

  let rawSegments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  var lastNonEmpty = -1
  for index in rawSegments.indices.reversed() where !rawSegments[index].isEmpty {
    lastNonEmpty = index
    break
  }
  guard lastNonEmpty >= 0 else { return path }

  let masked = rawSegments.enumerated().map { index, segment in
    maskSegment(segment, isLastNonEmpty: index == lastNonEmpty)
  }
  return masked.joined(separator: "/")
}

private func maskSegment(_ segment: String, isLastNonEmpty: Bool) -> String {
  guard !segment.isEmpty else { return "" }
  guard isLastNonEmpty else { return mask }
  let base = substringBefore(segment, delimiter: ";")
  guard !base.isEmpty, let dot = base.lastIndex(of: "."), dot > base.startIndex else {
    return mask
  }
  let ext = String(base[dot...])
  return safeExtensions.contains(ext.lowercased()) ? "\(mask)\(ext)" : mask
}

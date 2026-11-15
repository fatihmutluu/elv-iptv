import Foundation

private let credentialMarkers: Set<String> = ["live", "movie", "series", "timeshift"]
private let tokenMarker = "play"
private let mask = "***"

/// Returns `url` safe for diagnostics: strips query, fragment, and user-info, masks the user and
/// password segments after `/live/`, `/movie/`, `/series/`, and `/timeshift/`, masks the token
/// after `/play/`, and masks the bare Xtream form `/<user>/<pass>/<id>` when no marker appeared.
public func redactUrl(_ url: String) -> String {
  let noFragment = substringBefore(url, delimiter: "#")
  let withoutTail = substringBefore(noFragment, delimiter: "?")

  let origin: String
  let path: String
  if let schemeRange = withoutTail.range(of: "://") {
    let authorityStart = schemeRange.upperBound
    let remainder = withoutTail[authorityStart...]
    let pathStart = remainder.firstIndex(of: "/") ?? withoutTail.endIndex
    let rawAuthority = String(withoutTail[authorityStart..<pathStart])
    let authority: String
    if let atIndex = rawAuthority.lastIndex(of: "@") {
      authority = String(rawAuthority[rawAuthority.index(after: atIndex)...])
    } else {
      authority = rawAuthority
    }
    origin = String(withoutTail[..<authorityStart]) + authority
    path = String(withoutTail[pathStart...])
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
  var segments = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  var marked = false
  var index = 0

  while index < segments.count {
    let lower = segments[index].lowercased()
    let masked: Int
    if credentialMarkers.contains(lower) {
      masked = 2
    } else if lower == tokenMarker {
      masked = 1
    } else {
      masked = 0
    }

    if masked > 0 {
      marked = true
      for offset in 1...masked {
        let target = index + offset
        if target < segments.count && !segments[target].isEmpty {
          segments[target] = mask
        }
      }
    }
    index += 1 + masked
  }

  if !marked {
    maskBareXtream(&segments)
  }
  return segments.joined(separator: "/")
}

private func maskBareXtream(_ segments: inout [String]) {
  let named = segments.indices.filter { !segments[$0].isEmpty }
  guard named.count >= 3, let lastIndex = named.last, isBareXtreamId(segments[lastIndex]) else {
    return
  }
  segments[named[named.count - 2]] = mask
  segments[named[named.count - 3]] = mask
}

private func isBareXtreamId(_ segment: String) -> Bool {
  guard !segment.isEmpty else { return false }
  let parts = segment.split(separator: ".", omittingEmptySubsequences: false)
  guard parts.count == 1 || parts.count == 2 else { return false }
  let digits = parts[0]
  guard !digits.isEmpty && digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return false }
  if parts.count == 2 {
    let ext = parts[1]
    guard !ext.isEmpty && ext.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else {
      return false
    }
  }
  return true
}

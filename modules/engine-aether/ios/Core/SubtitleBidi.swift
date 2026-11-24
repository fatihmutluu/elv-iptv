import Foundation

/// Resolved base paragraph writing direction for a subtitle cue (`#285`).
public enum SubtitleWritingDirection: Equatable, Sendable {
  case rightToLeft
  case leftToRight
  case natural
}

/// Pure Swift 6 RTL/Bidi isolation and overlapping cue merge helpers for Apple subtitle rendering (`#285`).
public enum SubtitleBidi {
  private static let lri: Unicode.Scalar = "\u{2066}"
  private static let rli: Unicode.Scalar = "\u{2067}"
  private static let fsi: Unicode.Scalar = "\u{2068}"
  private static let pdi: Unicode.Scalar = "\u{2069}"
  private static let lrm: UInt32 = 0x200E
  private static let rlm: UInt32 = 0x200F
  private static let alm: UInt32 = 0x061C

  /// Returns `true` when `text` contains any strong right-to-left script character
  /// (Arabic, Hebrew, Syriac, Thaana, N'Ko, or Hebrew/Arabic presentation forms).
  public static func containsStrongRtl(_ text: String) -> Bool {
    for scalar in text.unicodeScalars {
      if isRtlScriptScalar(scalar.value) {
        return true
      }
    }
    return false
  }

  /// Splits `text` into lines and wraps each RTL-first line in Unicode Right-to-Left Isolate
  /// (`\u{2067}...\u{2069}`) idempotently so trailing punctuation in mixed RTL+LTR cues renders
  /// on the visually correct side. LTR-first and neutral-only lines are left untouched.
  public static func isolateLines(_ text: String) -> String {
    guard !text.isEmpty else { return text }
    let normalized = text
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
    let rawLines = normalized.split(separator: "\n", omittingEmptySubsequences: false)
    var out: [String] = []
    out.reserveCapacity(rawLines.count)
    var changed = normalized != text
    for raw in rawLines {
      let line = String(raw)
      if line.isEmpty || isAlreadyRtlIsolated(line) {
        out.append(line)
        continue
      }
      if firstStrongDirection(in: line) == .rightToLeft {
        out.append("\u{2067}\(line)\u{2069}")
        changed = true
      } else {
        out.append(line)
      }
    }
    return changed ? out.joined(separator: "\n") : text
  }

  /// Determines the paragraph base writing direction from the first strong directional character.
  public static func baseWritingDirection(for text: String) -> SubtitleWritingDirection {
    firstStrongDirection(in: text)
  }

  /// Deduplicates identical overlapping subtitle cue lines while preserving display order and
  /// trimming blank leading/trailing lines cleanly.
  public static func mergeOverlappingLines(_ lines: [String]) -> String {
    guard !lines.isEmpty else { return "" }
    var seen = Set<String>()
    var merged: [String] = []
    for block in lines {
      let normalized = block
        .replacingOccurrences(of: "\r\n", with: "\n")
        .replacingOccurrences(of: "\r", with: "\n")
      for rawSub in normalized.split(separator: "\n", omittingEmptySubsequences: false) {
        let trimmed = rawSub.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { continue }
        if seen.insert(trimmed).inserted {
          merged.append(trimmed)
        }
      }
    }
    return merged.joined(separator: "\n")
  }

  private static func isAlreadyRtlIsolated(_ line: String) -> Bool {
    let scalars = Array(line.unicodeScalars)
    guard scalars.count >= 2, scalars.first == rli, scalars.last == pdi else {
      return false
    }
    var depth = 0
    for (idx, scalar) in scalars.enumerated() {
      if scalar == rli || scalar == lri || scalar == fsi {
        depth += 1
      } else if scalar == pdi {
        depth -= 1
        if depth == 0 && idx < scalars.count - 1 {
          return false
        }
      }
    }
    return depth == 0
  }

  private static func firstStrongDirection(in text: String) -> SubtitleWritingDirection {
    for scalar in text.unicodeScalars {
      let v = scalar.value
      if v == rlm || v == alm || isRtlScriptScalar(v) {
        return .rightToLeft
      }
      if v == lrm || isStrongLtrScalar(v) {
        return .leftToRight
      }
    }
    return .natural
  }

  private static func isRtlScriptScalar(_ cp: UInt32) -> Bool {
    // Hebrew
    if cp == 0x05BE || cp == 0x05C0 || cp == 0x05C3 || cp == 0x05C6
      || (cp >= 0x05D0 && cp <= 0x05EA)
      || (cp >= 0x05EF && cp <= 0x05F4)
    {
      return true
    }
    // Arabic (excluding Arabic-Indic digits 0660-0669 / 06F0-06F9 and combining marks)
    if cp == 0x0608 || cp == 0x060B || cp == 0x060D
      || (cp >= 0x061B && cp <= 0x064A)
      || (cp >= 0x066D && cp <= 0x066F)
      || (cp >= 0x0671 && cp <= 0x06D5)
      || cp == 0x06E5 || cp == 0x06E6 || cp == 0x06EE || cp == 0x06EF
      || (cp >= 0x06FA && cp <= 0x06FF)
    {
      return true
    }
    // Syriac, Arabic Supplement, Thaana, N'Ko
    if (cp >= 0x0700 && cp <= 0x070D)
      || cp == 0x0710
      || (cp >= 0x0712 && cp <= 0x072F)
      || (cp >= 0x074D && cp <= 0x07A5)
      || cp == 0x07B1
      || (cp >= 0x07C0 && cp <= 0x07EA)
      || cp == 0x07F4 || cp == 0x07F5 || cp == 0x07FA
    {
      return true
    }
    // Samaritan, Mandaic, Syriac Supplement, Arabic Extended-B & Extended-A
    if (cp >= 0x0800 && cp <= 0x0897) || (cp >= 0x08A0 && cp <= 0x08C9) {
      return true
    }
    // Hebrew & Arabic Presentation Forms (excluding U+FEFF BOM)
    if cp == 0xFB1D
      || (cp >= 0xFB1F && cp <= 0xFB28)
      || (cp >= 0xFB2A && cp <= 0xFD3D)
      || (cp >= 0xFD50 && cp <= 0xFDFC)
      || (cp >= 0xFE70 && cp <= 0xFEFC)
    {
      return true
    }
    // Arabic Mathematical Alphabetic Symbols
    return cp >= 0x1EE00 && cp <= 0x1EEFF
  }

  private static func isStrongLtrScalar(_ cp: UInt32) -> Bool {
    if (cp >= 0x0041 && cp <= 0x005A) || (cp >= 0x0061 && cp <= 0x007A) {
      return true
    }
    if (cp >= 0x00C0 && cp <= 0x00D6)
      || (cp >= 0x00D8 && cp <= 0x00F6)
      || (cp >= 0x00F8 && cp <= 0x02AF)
      || (cp >= 0x0370 && cp <= 0x058F)
      || (cp >= 0x0900 && cp <= 0x1FFF)
      || (cp >= 0x2C00 && cp <= 0x2FEF)
      || (cp >= 0x3040 && cp <= 0xD7FF)
      || (cp >= 0xF900 && cp <= 0xFAFF)
      || (cp >= 0xFF21 && cp <= 0xFF3A)
      || (cp >= 0xFF41 && cp <= 0xFF5A)
      || (cp >= 0xFF66 && cp <= 0xFFDC)
    {
      return true
    }
    return false
  }
}

import Foundation

private let undeterminedTags: Set<String> = ["und", "zxx", "mul", "mis", "unknown"]

private let iso639Canonical: [String: String] = [
  "en": "en", "eng": "en",
  "tr": "tr", "tur": "tr",
  "de": "de", "deu": "de", "ger": "de",
  "fr": "fr", "fra": "fr", "fre": "fr",
  "es": "es", "spa": "es",
  "ar": "ar", "ara": "ar",
  "ru": "ru", "rus": "ru",
  "it": "it", "ita": "it",
  "pt": "pt", "por": "pt",
  "nl": "nl", "nld": "nl", "dut": "nl",
  "pl": "pl", "pol": "pl",
  "zh": "zh", "zho": "zh", "chi": "zh",
  "ja": "ja", "jpn": "ja",
  "ko": "ko", "kor": "ko",
  "fa": "fa", "fas": "fa", "per": "fa",
  "el": "el", "ell": "el", "gre": "el",
  "cs": "cs", "ces": "cs", "cze": "cs",
  "ro": "ro", "ron": "ro", "rum": "ro",
  "sv": "sv", "swe": "sv",
  "uk": "uk", "ukr": "uk",
  "ku": "ku", "kur": "ku",
  "az": "az", "aze": "az",
  "bg": "bg", "bul": "bg",
  "da": "da", "dan": "da",
  "fi": "fi", "fin": "fi",
  "he": "he", "heb": "he",
  "hi": "hi", "hin": "hi",
  "hr": "hr", "hrv": "hr",
  "hu": "hu", "hun": "hu",
  "id": "id", "ind": "id",
  "ms": "ms", "msa": "ms", "may": "ms",
  "no": "no", "nor": "no",
  "nb": "nb", "nob": "nb",
  "nn": "nn", "nno": "nn",
  "sk": "sk", "slk": "sk", "slo": "sk",
  "sl": "sl", "slv": "sl",
  "sr": "sr", "srp": "sr",
  "th": "th", "tha": "th",
  "vi": "vi", "vie": "vi",
  "sq": "sq", "sqi": "sq", "alb": "sq",
  "mk": "mk", "mkd": "mk", "mac": "mk",
  "ka": "ka", "kat": "ka", "geo": "ka",
  "hy": "hy", "hye": "hy", "arm": "hy",
  "is": "is", "isl": "is", "ice": "is",
  "cy": "cy", "cym": "cy", "wel": "cy",
  "eu": "eu", "eus": "eu", "baq": "eu",
  "bo": "bo", "bod": "bo", "tib": "bo",
  "my": "my", "mya": "my", "bur": "my",
]

/// Formats an `AetherEngine` audio track `id` into a stable `"a:<id>"` identifier.
public func formatAudioTrackId(_ streamId: Int) -> String {
  "a:\(streamId)"
}

/// Formats an `AetherEngine` subtitle track `id` into a stable `"s:<id>"` identifier.
public func formatSubtitleTrackId(_ streamId: Int) -> String {
  "s:\(streamId)"
}

/// Parses a strict `"a:<nonNegativeInt32>"` audio track identifier to its stream ID.
public func parseAudioTrackStreamId(_ id: String) -> Int? {
  parsePrefixedStreamId(id, prefix: "a:")
}

/// Parses a strict `"s:<nonNegativeInt32>"` subtitle track identifier to its stream ID.
public func parseSubtitleTrackStreamId(_ id: String) -> Int? {
  parsePrefixedStreamId(id, prefix: "s:")
}

/// Normalizes a container or HLS language code, dropping empty or undetermined values.
public func normalizeTrackLanguage(_ raw: String?) -> String? {
  guard
    let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
    !trimmed.isEmpty,
    !undeterminedTags.contains(trimmed)
  else {
    return nil
  }
  return trimmed
}

/// Canonicalizes ISO 639-1, ISO 639-2(T/B), and BCP-47 tags to a common primary code.
public func canonicalTrackLanguage(_ raw: String?) -> String? {
  guard let normalized = normalizeTrackLanguage(raw) else { return nil }
  let primary = normalized.split(whereSeparator: { $0 == "-" || $0 == "_" }).first.map(String.init) ?? ""
  guard (2...8).contains(primary.count),
        primary.allSatisfy({ $0.isASCII && $0.isLetter }),
        !undeterminedTags.contains(primary)
  else {
    return nil
  }
  return iso639Canonical[primary] ?? primary
}

/// Returns `true` when both tags represent the same known canonical language.
public func sameTrackLanguage(_ a: String?, _ b: String?) -> Bool {
  guard let canonA = canonicalTrackLanguage(a) else { return false }
  return canonA == canonicalTrackLanguage(b)
}

private func parsePrefixedStreamId(_ raw: String, prefix: String) -> Int? {
  let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  guard trimmed.hasPrefix(prefix) else { return nil }
  let digits = trimmed.dropFirst(prefix.count)
  guard !digits.isEmpty, digits.count <= 10, digits.allSatisfy({ $0.isASCII && $0.isNumber }),
        let parsed = Int(digits), parsed >= 0, parsed <= Int(Int32.max)
  else {
    return nil
  }
  return parsed
}

import ElvAetherCore
import Foundation
import Testing

@Suite("SubtitleBidi (#285)")
struct SubtitleBidiTests {
  @Test("containsStrongRtl detects Arabic, Hebrew, Syriac, Thaana, N'Ko, and presentation forms while ignoring Latin/digits/BOM")
  func detectsStrongRtlScripts() {
    #expect(SubtitleBidi.containsStrongRtl("مرحبا بالعالم!"))
    #expect(SubtitleBidi.containsStrongRtl("שלום עולם?"))
    #expect(SubtitleBidi.containsStrongRtl("Hello مرحبا"))
    #expect(SubtitleBidi.containsStrongRtl("ܫܠܡܐ")) // Syriac
    #expect(SubtitleBidi.containsStrongRtl("ދިވެހި")) // Thaana
    #expect(SubtitleBidi.containsStrongRtl("ߒߞߏ")) // N'Ko
    #expect(SubtitleBidi.containsStrongRtl("\u{FB50}")) // Arabic Presentation Form-A
    #expect(SubtitleBidi.containsStrongRtl("\u{FE8D}")) // Arabic Presentation Form-B

    #expect(!SubtitleBidi.containsStrongRtl(""))
    #expect(!SubtitleBidi.containsStrongRtl("Hello world! 12345"))
    #expect(!SubtitleBidi.containsStrongRtl("Türkçe ğüşıöç 2026"))
    #expect(!SubtitleBidi.containsStrongRtl("\u{FEFF}Hello"))
    #expect(!SubtitleBidi.containsStrongRtl("0660 ٠١٢٣")) // Arabic-Indic digits only
  }

  @Test("isolateLines wraps RTL-first lines with RLI/PDI idempotently and preserves trailing punctuation in mixed RTL+LTR cues")
  func isolatesMixedRtlAndLtrLinesIdempotently() {
    let arabicMixed = "مرحبا Apple TV!"
    let isolatedArabic = SubtitleBidi.isolateLines(arabicMixed)
    #expect(isolatedArabic == "\u{2067}مرحبا Apple TV!\u{2069}")
    // Idempotent when called twice.
    #expect(SubtitleBidi.isolateLines(isolatedArabic) == isolatedArabic)

    let hebrewQuestion = "שלום iOS?"
    #expect(SubtitleBidi.isolateLines(hebrewQuestion) == "\u{2067}שלום iOS?\u{2069}")

    let arabicPeriod = "هذا اختبار 4K HDR."
    #expect(SubtitleBidi.isolateLines(arabicPeriod) == "\u{2067}هذا اختبار 4K HDR.\u{2069}")

    // LTR-first line with embedded RTL word stays untouched.
    let ltrFirst = "Channel مرحبا!"
    #expect(SubtitleBidi.isolateLines(ltrFirst) == ltrFirst)

    // Neutral-only / empty lines stay untouched.
    #expect(SubtitleBidi.isolateLines("") == "")
    #expect(SubtitleBidi.isolateLines("12345 !?.") == "12345 !?.")
  }

  @Test("isolateLines handles multi-line mixed RTL and LTR cues independently per line")
  func isolatesMultiLineMixedCues() {
    let multi = "مرحبا بالعالم!\nHello world.\nשלום חברים?\n42"
    let expected = "\u{2067}مرحبا بالعالم!\u{2069}\nHello world.\n\u{2067}שלום חברים?\u{2069}\n42"
    #expect(SubtitleBidi.isolateLines(multi) == expected)
    #expect(SubtitleBidi.isolateLines(expected) == expected)

    // Line containing two separate isolated spans is still wrapped at the outer level when RTL-first.
    let adjacentSpans = "\u{2067}مرحبا\u{2069} \u{2067}عالم\u{2069}"
    #expect(SubtitleBidi.isolateLines(adjacentSpans) == "\u{2067}\(adjacentSpans)\u{2069}")
  }

  @Test("baseWritingDirection resolves rightToLeft, leftToRight, and natural correctly")
  func resolvesBaseWritingDirection() {
    #expect(SubtitleBidi.baseWritingDirection(for: "مرحبا world!") == .rightToLeft)
    #expect(SubtitleBidi.baseWritingDirection(for: "\u{2067}שלום?\u{2069}") == .rightToLeft)
    #expect(SubtitleBidi.baseWritingDirection(for: "- مرحبا") == .rightToLeft)
    #expect(SubtitleBidi.baseWritingDirection(for: "Hello مرحبا") == .leftToRight)
    #expect(SubtitleBidi.baseWritingDirection(for: "12345 !?") == .natural)
    #expect(SubtitleBidi.baseWritingDirection(for: "") == .natural)
  }

  @Test("mergeOverlappingLines deduplicates identical overlapping cues and strips blank lines cleanly")
  func mergesOverlappingLinesCleanly() {
    #expect(SubtitleBidi.mergeOverlappingLines([]) == "")
    #expect(SubtitleBidi.mergeOverlappingLines(["   ", "\n\n"]) == "")
    #expect(SubtitleBidi.mergeOverlappingLines(["Hello!", "Hello!"]) == "Hello!")
    #expect(
      SubtitleBidi.mergeOverlappingLines([
        "  Line one  \r\nLine two\n",
        "Line two\nLine three  ",
        "",
        "Line one",
      ]) == "Line one\nLine two\nLine three"
    )
    #expect(
      SubtitleBidi.mergeOverlappingLines(["مرحبا!", "مرحبا!", "أهلاً!"]) == "مرحبا!\nأهلاً!"
    )
  }
}

import ElvAetherCore
import Foundation
import Testing

private struct MockCaptionAppearanceSource: CaptionAppearanceSource {
  let style: CaptionAppearanceStyle?

  func readCaptionAppearance() -> CaptionAppearanceStyle? {
    style
  }
}

@Suite("CaptionAppearanceStyle & VoiceOverAnnouncementDeduper (#442)")
struct CaptionAppearanceTests {
  @Test("resolveCaptionAppearance falls back to default when source is nil or returns nil")
  func resolveFallsBackToDefault() {
    #expect(resolveCaptionAppearance(source: nil) == .default)
    #expect(resolveCaptionAppearance(source: MockCaptionAppearanceSource(style: nil)) == .default)
    #expect(CaptionAppearanceStyle.default.foreground == CaptionAppearanceColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0))
    #expect(CaptionAppearanceStyle.default.background == CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.74))
    #expect(CaptionAppearanceStyle.default.window == nil)
    #expect(CaptionAppearanceStyle.default.relativeCharacterSize == 1.0)
    #expect(CaptionAppearanceStyle.default.fontName == nil)
  }

  @Test("resolveCaptionAppearance clamps RGB/A channels to [0, 1] and relativeCharacterSize to [0.5, 2.0]")
  func resolveClampsColorsAndScale() {
    let raw = CaptionAppearanceStyle(
      foreground: CaptionAppearanceColor(red: 1.5, green: -0.2, blue: 0.8, alpha: 2.0),
      background: CaptionAppearanceColor(red: -1.0, green: 0.25, blue: 3.0, alpha: -0.5),
      window: CaptionAppearanceColor(red: 0.1, green: 1.2, blue: -0.1, alpha: 0.5),
      relativeCharacterSize: 4.5,
      fontName: "  HelveticaNeue-Bold  "
    )
    let resolved = resolveCaptionAppearance(source: MockCaptionAppearanceSource(style: raw))
    #expect(resolved.foreground == CaptionAppearanceColor(red: 1.0, green: 0.0, blue: 0.8, alpha: 1.0))
    #expect(resolved.background == CaptionAppearanceColor(red: 0.0, green: 0.25, blue: 1.0, alpha: 0.0))
    #expect(resolved.window == CaptionAppearanceColor(red: 0.1, green: 1.0, blue: 0.0, alpha: 0.5))
    #expect(resolved.relativeCharacterSize == 2.0)
    #expect(resolved.fontName == "HelveticaNeue-Bold")

    let smallRaw = CaptionAppearanceStyle(
      foreground: CaptionAppearanceColor(red: .nan, green: 0.5, blue: 0.5, alpha: .infinity),
      background: CaptionAppearanceColor(red: 0.2, green: 0.2, blue: 0.2, alpha: 0.6),
      relativeCharacterSize: 0.1,
      fontName: "   "
    )
    let smallResolved = resolveCaptionAppearance(source: MockCaptionAppearanceSource(style: smallRaw))
    #expect(smallResolved.foreground == CaptionAppearanceColor(red: 1.0, green: 0.5, blue: 0.5, alpha: 1.0))
    #expect(smallResolved.relativeCharacterSize == 0.5)
    #expect(smallResolved.fontName == nil)
  }

  @Test("VoiceOverAnnouncementDeduper joins trimmed cues, deduplicates repeats, and resets on empty gaps")
  func voiceOverDeduperLifecycle() {
    var deduper = VoiceOverAnnouncementDeduper()
    #expect(deduper.nextAnnouncement(for: []) == nil)
    #expect(deduper.nextAnnouncement(for: ["   ", "\n"]) == nil)

    #expect(deduper.nextAnnouncement(for: ["  Line one  ", "", "Line two\n"]) == "Line one\nLine two")
    #expect(deduper.nextAnnouncement(for: ["Line one", "  Line two  "]) == nil)
    #expect(deduper.nextAnnouncement(for: ["Different cue"]) == "Different cue")

    // Empty cue resets the deduper so an identical later cue announces again.
    #expect(deduper.nextAnnouncement(for: ["  "]) == nil)
    #expect(deduper.nextAnnouncement(for: ["Different cue"]) == "Different cue")

    // Explicit reset clears the deduper.
    deduper.reset()
    #expect(deduper.nextAnnouncement(for: ["Different cue"]) == "Different cue")
  }
}

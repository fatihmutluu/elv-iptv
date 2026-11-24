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

  @Test("resolveSubtitleFontName maps accessibility font families to PostScript names and nil for system (#163)")
  func resolveSubtitleFontNameMapping() {
    #expect(resolveSubtitleFontName("atkinson") == "AtkinsonHyperlegibleNext-Regular")
    #expect(resolveSubtitleFontName("  Atkinson  ") == "AtkinsonHyperlegibleNext-Regular")
    #expect(resolveSubtitleFontName("opendyslexic") == "OpenDyslexic-Regular")
    #expect(resolveSubtitleFontName("OpenDyslexic") == "OpenDyslexic-Regular")
    #expect(resolveSubtitleFontName("system") == nil)
    #expect(resolveSubtitleFontName(nil) == nil)
    #expect(resolveSubtitleFontName("") == nil)
    #expect(resolveSubtitleFontName("unknown-font") == nil)
  }

  @Test("applyingSubtitleFontOverride overrides only fontName while preserving system colors, window, and scale (#163)")
  func applyingSubtitleFontOverridePreservesSystemAppearance() {
    let systemStyle = CaptionAppearanceStyle(
      foreground: CaptionAppearanceColor(red: 1.0, green: 0.95, blue: 0.2, alpha: 1.0),
      background: CaptionAppearanceColor(red: 0.05, green: 0.1, blue: 0.2, alpha: 0.8),
      window: CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.4),
      relativeCharacterSize: 1.35,
      fontName: "HelveticaNeue-Medium"
    )

    let atkinson = applyingSubtitleFontOverride(systemStyle, family: "atkinson")
    #expect(atkinson.fontName == "AtkinsonHyperlegibleNext-Regular")
    #expect(atkinson.foreground == systemStyle.foreground)
    #expect(atkinson.background == systemStyle.background)
    #expect(atkinson.window == systemStyle.window)
    #expect(atkinson.relativeCharacterSize == systemStyle.relativeCharacterSize)

    let dyslexic = applyingSubtitleFontOverride(systemStyle, family: "opendyslexic")
    #expect(dyslexic.fontName == "OpenDyslexic-Regular")
    #expect(dyslexic.foreground == systemStyle.foreground)
    #expect(dyslexic.background == systemStyle.background)
    #expect(dyslexic.window == systemStyle.window)
    #expect(dyslexic.relativeCharacterSize == systemStyle.relativeCharacterSize)

    // System / nil / unknown preserves the system font choice cleanly.
    #expect(applyingSubtitleFontOverride(systemStyle, family: "system") == systemStyle)
    #expect(applyingSubtitleFontOverride(systemStyle, family: nil) == systemStyle)
    #expect(applyingSubtitleFontOverride(systemStyle, family: "other") == systemStyle)
  }

  @Test("applyingUserSubtitleStyle layers user size, color, backdrop, edge, and vertical position while preserving fontName (#32)")
  func applyingUserSubtitleStyleOverride() {
    let base = CaptionAppearanceStyle(
      foreground: CaptionAppearanceColor(red: 1.0, green: 1.0, blue: 1.0, alpha: 1.0),
      background: CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.74),
      window: CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.5),
      relativeCharacterSize: 1.0,
      fontName: "AtkinsonHyperlegibleNext-Regular"
    )

    #expect(applyingUserSubtitleStyle(base, override: nil) == base)

    let override = UserSubtitleStyleOverride(
      fontSize: .extraLarge,
      textColor: .yellow,
      backgroundColor: .none,
      edgeStyle: .dropShadow,
      verticalPosition: .raised
    )
    let styled = applyingUserSubtitleStyle(base, override: override)
    #expect(styled.relativeCharacterSize == 1.65)
    #expect(styled.foreground == UserSubtitleTextColor.yellow.captionColor)
    #expect(styled.background == CaptionAppearanceColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.0))
    #expect(styled.window == nil)
    #expect(styled.edgeStyle == .dropShadow)
    #expect(styled.verticalPosition == .raised)
    #expect(styled.fontName == "AtkinsonHyperlegibleNext-Regular")

    // Font override preserves edgeStyle and verticalPosition.
    let withDyslexic = applyingSubtitleFontOverride(styled, family: "opendyslexic")
    #expect(withDyslexic.fontName == "OpenDyslexic-Regular")
    #expect(withDyslexic.edgeStyle == .dropShadow)
    #expect(withDyslexic.verticalPosition == .raised)

    // Raw parser handles valid values and falls back cleanly on invalid/nil inputs.
    let parsed = UserSubtitleStyleOverride.fromRaw(
      fontSize: "small",
      textColor: "cyan",
      backgroundColor: "opaque",
      edgeStyle: "outline",
      verticalPosition: "top"
    )
    #expect(parsed.fontSize == .small)
    #expect(parsed.textColor == .cyan)
    #expect(parsed.backgroundColor == .opaque)
    #expect(parsed.edgeStyle == .outline)
    #expect(parsed.verticalPosition == .top)

    let fallback = UserSubtitleStyleOverride.fromRaw(
      fontSize: "huge",
      textColor: nil,
      backgroundColor: "invalid",
      edgeStyle: "",
      verticalPosition: "middle"
    )
    #expect(fallback == UserSubtitleStyleOverride())
  }
}

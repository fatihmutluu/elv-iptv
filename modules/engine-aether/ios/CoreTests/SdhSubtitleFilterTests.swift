import ElvAetherCore
import Testing

@Suite("SDH subtitle filtering (#310)")
struct SdhSubtitleFilterTests {
  @Test("strips balanced brackets, nested brackets, and parentheticals while preserving numeric/year expressions")
  func balancedBracketsAndYears() {
    #expect(SdhSubtitleFilter.stripSdhAnnotations("[dramatic music] Hello (sighs) world") == "Hello world")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("[laughs [snorts]] Hello") == "Hello")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("[soft music\nplaying]\nHello") == "Hello")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("[thunder rumbling]") == "")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("(footsteps approaching)") == "")

    #expect(SdhSubtitleFilter.stripSdhAnnotations("Released in (2024)") == "Released in (2024)")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("Episode (1-2) and (1–2)") == "Episode (1-2) and (1–2)")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("Score (98%)") == "Score (98%)")
  }

  @Test("strips Unicode uppercase speaker labels including Turkish while preserving RTL, timestamps, prose, and dialogue dashes")
  func speakerLabelsAndIntl() {
    #expect(SdhSubtitleFilter.stripSdhAnnotations("ŞEF: Başlıyoruz") == "Başlıyoruz")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("İSTANBUL: [müzik] Merhaba (2024)") == "Merhaba (2024)")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("- JOHN: Hi\n- MARY: Yo") == "- Hi\n- Yo")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("— DR. O'CONNOR: Stay back.") == "— Stay back.")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("- JOHN: [laughs]\n- MARY: Yo") == "- Yo")

    #expect(SdhSubtitleFilter.stripSdhAnnotations("Note: meet at 10:30") == "Note: meet at 10:30")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("مرحبا: أهلا (2024)") == "مرحبا: أهلا (2024)")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("مرحبا [موسيقى] أهلا") == "مرحبا أهلا")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("\u{2067}- \u{2066}JOHN: Hi\u{2069}") == "\u{2067}- Hi\u{2069}")
  }

  @Test("drops lone dashes and music note lines and suppresses blank cues")
  func loneDashesAndMusicLines() {
    #expect(SdhSubtitleFilter.stripSdhAnnotations("♪") == "")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("♫\n♪ ♫") == "")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("- ♪") == "")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("-") == "")
    #expect(SdhSubtitleFilter.stripSdhAnnotations("♪ [upbeat music] ♪\nKeep this line\n—") == "Keep this line")
  }

  @Test("filters .text and .richText cues, drops blank cues, and leaves .image cues untouched")
  func cueBodyFiltering() {
    #expect(SdhSubtitleFilter.filterCueBody(.text("[music]"), enabled: true) == nil)
    #expect(SdhSubtitleFilter.filterCueBody(.text("[music]"), enabled: false) == .text("[music]"))
    #expect(
      SdhSubtitleFilter.filterCueBody(.text("ŞEF: [alkış] Merhaba (2024)"), enabled: true)
        == .text("Merhaba (2024)")
    )
    #expect(
      SdhSubtitleFilter.filterCueBody(.richText(["[dramatic ", "music]"]), enabled: true)
        == nil
    )
    #expect(
      SdhSubtitleFilter.filterCueBody(.richText(["Clean ", "dialogue"]), enabled: true)
        == .richText(["Clean ", "dialogue"])
    )
    #expect(
      SdhSubtitleFilter.filterCueBody(.richText(["JOHN: ", "Stay back"]), enabled: true)
        == .text("Stay back")
    )
    #expect(SdhSubtitleFilter.filterCueBody(.image, enabled: true) == .image)
  }

  @Test("threads filterSdhSubtitles from LoadRequest into EngineLoadOptions")
  func loadRequestForwarding() throws {
    let defaultReq = LoadRequest(url: "http://h:7878/movie/1.mp4", live: false)
    #expect(defaultReq.filterSdhSubtitles == false)
    let defaultPlan = try #require(planMedia(defaultReq))
    #expect(loadOptions(for: defaultPlan, request: defaultReq).filterSdhSubtitles == false)

    let sdhReq = LoadRequest(url: "http://h:7878/movie/1.mp4", live: false, filterSdhSubtitles: true)
    let sdhPlan = try #require(planMedia(sdhReq))
    #expect(loadOptions(for: sdhPlan, request: sdhReq).filterSdhSubtitles == true)
  }
}

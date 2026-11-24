import ElvAetherCore
import Foundation
import Testing

@Suite("ExternalSubtitleParser (#308, #32)")
struct ExternalSubtitleParserTests {
  @Test("parses malformed SRT with missing indices, arrow typos, short ms, tags, entities, and negative durations")
  func parsesMalformedSrt() {
    let srt = """
    \u{FEFF}1
    00:00:01,5 -> 00:00:03,25
    <i>Hello</i> &amp; <b>welcome</b>!

    00:00:05,000 --> 00:00:04,000
    Dropped negative duration

    00:00:06:500 —> 00:00:08.000
    {\\an8}Line one<br/>Line two &apos;ok&apos;
    """
    let track = ExternalSubtitleParser.parse(srt, hint: "movie.srt")
    #expect(track.format == .srt)
    #expect(track.warnings.contains("non-positive-duration"))
    #expect(track.cues.count == 2)
    #expect(track.cues[0] == ExternalSubtitleCue(startMs: 1_500, endMs: 3_250, text: "Hello & welcome!", isRtl: false))
    #expect(track.cues[1] == ExternalSubtitleCue(startMs: 6_500, endMs: 8_000, text: "Line one\nLine two 'ok'", isRtl: false))
  }

  @Test("parses WebVTT skipping NOTE/STYLE/REGION blocks, cue settings, and inline timestamps")
  func parsesWebVtt() {
    let vtt = """
    WEBVTT - Demo

    STYLE
    ::cue { color: white; }

    NOTE
    Ignored comment block

    00:01.000 --> 00:03.500 align:start position:10%
    <c.yellow>First</c> <00:02.000>cue

    00:04.000 --> 00:06.000
    مرحبا Apple!
    """
    let track = ExternalSubtitleParser.parse(vtt, hint: "text/vtt")
    #expect(track.format == .vtt)
    #expect(track.cues.count == 2)
    #expect(track.cues[0] == ExternalSubtitleCue(startMs: 1_000, endMs: 3_500, text: "First cue", isRtl: false))
    #expect(track.cues[1] == ExternalSubtitleCue(startMs: 4_000, endMs: 6_000, text: "مرحبا Apple!", isRtl: true))
  }

  @Test("parses ASS/SSA with dynamic Format column order, commas in text, overrides, and vector drawings")
  func parsesAssDynamicFormat() {
    let ass = """
    [Script Info]
    Title: Demo

    [Events]
    Format: Start, End, Text, Style
    Dialogue: 0:00:01.20,0:00:03.50,{\\an8}Hello, world!\\NSecond\\hline,Default
    Dialogue: 0:00:04.00,0:00:05.00,{\\p1}m 0 0 l 100 100{\\p0}Visible,Default
    """
    let track = ExternalSubtitleParser.parse(ass, hint: "subs.ass")
    #expect(track.format == .ass)
    #expect(track.cues.count == 2)
    #expect(track.cues[0] == ExternalSubtitleCue(startMs: 1_200, endMs: 3_500, text: "Hello, world!\nSecond line", isRtl: false))
    #expect(track.cues[1] == ExternalSubtitleCue(startMs: 4_000, endMs: 5_000, text: "Visible", isRtl: false))
  }

  @Test("parses TTML with clock times, frame rates, offset units, and br line breaks")
  func parsesTtml() {
    let ttml = """
    <?xml version="1.0" encoding="UTF-8"?>
    <tt xmlns="http://www.w3.org/ns/ttml" ttp:frameRate="25">
      <body>
        <div>
          <p begin="00:00:01.500" end="00:00:03:12">Line A<br/>Line B &amp; C</p>
          <p begin="5s" dur="2500ms">Offset cue</p>
        </div>
      </body>
    </tt>
    """
    let track = ExternalSubtitleParser.parse(ttml, hint: "application/ttml+xml")
    #expect(track.format == .ttml)
    #expect(track.cues.count == 2)
    #expect(track.cues[0] == ExternalSubtitleCue(startMs: 1_500, endMs: 3_480, text: "Line A\nLine B & C", isRtl: false))
    #expect(track.cues[1] == ExternalSubtitleCue(startMs: 5_000, endMs: 7_500, text: "Offset cue", isRtl: false))
  }

  @Test("enforces maxBytes cap cleanly and reports input-truncated warning")
  func enforcesByteCap() {
    let srt = "1\n00:00:01,000 --> 00:00:02,000\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nSecond\n"
    let data = Data(srt.utf8)
    let truncated = ExternalSubtitleParser.parse(data: data, hint: "test.srt", maxBytes: 40)
    #expect(truncated.warnings.contains("input-truncated"))
    #expect(truncated.cues.count == 1)
    #expect(truncated.cues[0].text == "Hello")
  }

  @Test("activeCues uses binary search and returns overlapping cues accurately")
  func activeCuesBinarySearchAndOverlaps() {
    let srt = """
    1
    00:00:05,000 --> 00:00:08,000
    Later cue

    2
    00:00:01,000 --> 00:00:04,000
    First cue

    3
    00:00:02,000 --> 00:00:06,000
    Overlapping cue
    """
    let track = ExternalSubtitleParser.parse(srt)
    #expect(track.cues.map(\.startMs) == [1_000, 2_000, 5_000])
    #expect(track.activeCues(atMs: -1).isEmpty)
    #expect(track.activeCues(atMs: 999).isEmpty)
    #expect(track.activeCues(atMs: 1_000).map(\.text) == ["First cue"])
    #expect(track.activeCues(atMs: 2_500).map(\.text) == ["First cue", "Overlapping cue"])
    #expect(track.activeCues(atMs: 4_000).map(\.text) == ["Overlapping cue"])
    #expect(track.activeCues(atMs: 5_500).map(\.text) == ["Overlapping cue", "Later cue"])
    #expect(track.activeCues(atMs: 8_000).isEmpty)
  }

  @Test("safely skips overflowing and non-finite timestamps without crashing (#285)")
  func guardsOverflowingAndNonFiniteTimestamps() {
    let ttml = """
    <tt xmlns="http://www.w3.org/ns/ttml" ttp:frameRate="30">
      <body>
        <div>
          <p begin="1e25s" end="1e26s">Huge scientific</p>
          <p begin="NaNs" end="10s">NaN begin</p>
          <p begin="0s" end="Infinitys">Inf end</p>
          <p begin="Infinity" end="10s">Bare inf</p>
          <p begin="00:00:01:1e25" end="00:00:02:00">Huge frames</p>
          <p begin="86400000s" dur="10s">Sum exceeds max</p>
          <p begin="1s" end="3s">Valid TTML cue</p>
        </div>
      </body>
    </tt>
    """
    let ttmlTrack = ExternalSubtitleParser.parse(ttml, hint: "overflow.ttml")
    #expect(ttmlTrack.format == .ttml)
    #expect(ttmlTrack.cues == [ExternalSubtitleCue(startMs: 1_000, endMs: 3_000, text: "Valid TTML cue", isRtl: false)])
    #expect(ttmlTrack.warnings.contains("malformed-timecode"))

    let srt = """
    1
    99999999999999999:00:00,000 --> 99999999999999999:00:05,000
    Int64 multiply overflow

    2
    25000:00:00,000 --> 25000:00:05,000
    Exceeds 1000-day cap

    3
    00:00:02,000 --> 00:00:04,000
    Valid SRT cue
    """
    let srtTrack = ExternalSubtitleParser.parse(srt, hint: "overflow.srt")
    #expect(srtTrack.format == .srt)
    #expect(srtTrack.cues == [ExternalSubtitleCue(startMs: 2_000, endMs: 4_000, text: "Valid SRT cue", isRtl: false)])
    #expect(srtTrack.warnings.contains("malformed-timecode"))

    let ass = """
    [Events]
    Format: Start, End, Text
    Dialogue: 99999999999999999:00:00.00,99999999999999999:00:05.00,Overflow
    Dialogue: 0:00:01.00,0:00:02.00,Valid ASS cue
    """
    let assTrack = ExternalSubtitleParser.parse(ass, hint: "overflow.ass")
    #expect(assTrack.format == .ass)
    #expect(assTrack.cues == [ExternalSubtitleCue(startMs: 1_000, endMs: 2_000, text: "Valid ASS cue", isRtl: false)])
  }

  @Test("linear-time scanning handles 100 KiB pathological unclosed delimiters without O(N^2) stall (#285)")
  func linearTimePathologicalUnclosedDelimiters() {
    let repeatedTags = String(repeating: "<a", count: 50_000)
    let repeatedAss = String(repeating: "{\\", count: 50_000)
    let repeatedAmps = String(repeating: "&", count: 100_000)
    let repeatedP = String(repeating: "<p>", count: 34_000)
    let repeatedTtmlBody = "<tt><body><p begin=\"1s\" end=\"2s\">" + repeatedTags + "</p></body></tt>"
    let repeatedBrackets = String(repeating: "[", count: 100_000)

    let srtPayload = "1\n00:00:01,000 --> 00:00:02,000\n\(repeatedTags)\n\(repeatedAss)\n\(repeatedAmps)\n"
    let ttmlUnclosed = "<tt><body>\(repeatedP)</body></tt>"

    let clock = ContinuousClock()
    let elapsed = clock.measure {
      let srtTrack = ExternalSubtitleParser.parse(srtPayload, hint: "pathological.srt")
      #expect(srtTrack.cues.count == 1)
      let ttmlTrack1 = ExternalSubtitleParser.parse(ttmlUnclosed, hint: "pathological.ttml")
      #expect(ttmlTrack1.cues.isEmpty)
      let ttmlTrack2 = ExternalSubtitleParser.parse(repeatedTtmlBody, hint: "pathological2.ttml")
      #expect(ttmlTrack2.cues.count == 1)
      let sdh = SdhSubtitleFilter.stripSdhAnnotations(repeatedBrackets)
      #expect(sdh.count == 100_000)
    }
    #expect(elapsed < .seconds(3))
  }

  @Test("readValidatedLocalSubtitle rejects traversal, disallowed extensions, symlink extension bypasses, and oversize files (#308)")
  func validatesLocalSubtitleFileUris() throws {
    let fm = FileManager.default
    let root = fm.temporaryDirectory.appendingPathComponent("elv-sub-test-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? fm.removeItem(at: root) }

    let validSrt = root.appendingPathComponent("movie.srt")
    let validPayload = Data("1\n00:00:01,000 --> 00:00:02,000\nHello\n".utf8)
    try validPayload.write(to: validSrt)
    #expect(ExternalSubtitleParser.readValidatedLocalSubtitle(url: validSrt) == validPayload)

    // Path traversal segment `..` is rejected even when targeting a valid `.srt`.
    let subDir = root.appendingPathComponent("nested", isDirectory: true)
    try fm.createDirectory(at: subDir, withIntermediateDirectories: true)
    let traversalUrl = URL(fileURLWithPath: subDir.path + "/../movie.srt")
    #expect(ExternalSubtitleParser.readValidatedLocalSubtitle(url: traversalUrl) == nil)

    // Non-allowlisted extension is rejected.
    let secretTxt = root.appendingPathComponent("secret.txt")
    try Data("top-secret".utf8).write(to: secretTxt)
    #expect(ExternalSubtitleParser.readValidatedLocalSubtitle(url: secretTxt) == nil)

    // Symlink `.srt -> .txt` is rejected after resolving symlinks.
    let evilSymlink = root.appendingPathComponent("evil.srt")
    try fm.createSymbolicLink(at: evilSymlink, withDestinationURL: secretTxt)
    #expect(ExternalSubtitleParser.readValidatedLocalSubtitle(url: evilSymlink) == nil)

    // Symlink `.srt -> .vtt` is allowed because both extensions are allowlisted.
    let targetVtt = root.appendingPathComponent("target.vtt")
    let vttPayload = Data("WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n".utf8)
    try vttPayload.write(to: targetVtt)
    let goodSymlink = root.appendingPathComponent("good.srt")
    try fm.createSymbolicLink(at: goodSymlink, withDestinationURL: targetVtt)
    #expect(ExternalSubtitleParser.readValidatedLocalSubtitle(url: goodSymlink) == vttPayload)

    // Oversize file exceeding maxBytes is rejected.
    #expect(ExternalSubtitleParser.readValidatedLocalSubtitle(url: validSrt, maxBytes: 8) == nil)
  }
}

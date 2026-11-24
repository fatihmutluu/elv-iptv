import { describe, expect, it } from 'vitest';
import {
  containsRtlText,
  DEFAULT_MAX_SUBTITLE_BYTES,
  detectSubtitleFormat,
  findActiveCues,
  isolateBidiLines,
  type ParsedSubtitleCue,
  parseSubtitles,
  stripSdhSubtitleLine,
} from './index';

const RLI = '\u2067';
const PDI = '\u2069';

describe('subtitles-bidi', () => {
  describe('containsRtlText', () => {
    it('detects Arabic, Hebrew, Syriac, Thaana, NKo and presentation forms', () => {
      expect(containsRtlText('مرحبا بالعالم')).toBe(true);
      expect(containsRtlText('שלום עולם')).toBe(true);
      expect(containsRtlText('ܫܠܡܐ')).toBe(true); // Syriac
      expect(containsRtlText('މަރުޙަބާ')).toBe(true); // Thaana
      expect(containsRtlText('ߒߞߏ')).toBe(true); // N'Ko
      expect(containsRtlText('\uFB1D')).toBe(true); // Hebrew presentation form
      expect(containsRtlText('\uFB50')).toBe(true); // Arabic presentation form A
      expect(containsRtlText('\uFE70')).toBe(true); // Arabic presentation form B
      expect(containsRtlText('Hello مرحبا')).toBe(true);
    });

    it('returns false for pure LTR, digits, punctuation, BOM and empty text', () => {
      expect(containsRtlText('')).toBe(false);
      expect(containsRtlText('Hello, world! 2024')).toBe(false);
      expect(containsRtlText('Türkçe ÇĞİÖŞÜ — Привет — 日本語')).toBe(false);
      expect(containsRtlText('\uFEFFHello')).toBe(false);
    });
  });

  describe('isolateBidiLines', () => {
    it('wraps RTL-first lines in RLI/PDI and leaves LTR-first lines untouched', () => {
      const input = 'مرحبا بالعالم!\nHello world!\nTitle: مرحبا\n- שלום, John!';
      const expected = [
        `${RLI}مرحبا بالعالم!${PDI}`,
        'Hello world!',
        'Title: مرحبا',
        `${RLI}- שלום, John!${PDI}`,
      ].join('\n');

      expect(isolateBidiLines(input)).toBe(expected);
    });

    it('is idempotent and never double-wraps already isolated lines', () => {
      const once = isolateBidiLines('مرحبا!\n2024 שלום?');
      expect(once).toBe(`${RLI}مرحبا!${PDI}\n${RLI}2024 שלום?${PDI}`);
      expect(isolateBidiLines(once)).toBe(once);
    });

    it('leaves empty and neutral-only lines untouched', () => {
      expect(isolateBidiLines('')).toBe('');
      expect(isolateBidiLines('2024!\n...')).toBe('2024!\n...');
    });

    it('handles separate inner isolates, surrogate-pair RTL symbols, and RLM/ALM/LRM marks', () => {
      const splitIsolates = `${RLI}مرحبا${PDI} و ${RLI}عالم${PDI}`;
      expect(isolateBidiLines(splitIsolates)).toBe(`${RLI}${splitIsolates}${PDI}`);
      expect(containsRtlText('😀 \u{1EE00}')).toBe(true);
      expect(containsRtlText('😀 123')).toBe(false);
      expect(isolateBidiLines('\u200F123')).toBe(`${RLI}\u200F123${PDI}`);
      expect(isolateBidiLines('\u061C123')).toBe(`${RLI}\u061C123${PDI}`);
      expect(containsRtlText('\u061C')).toBe(true);
      expect(isolateBidiLines('\u200Eمرحبا')).toBe('\u200Eمرحبا');
    });
  });

  describe('stripSdhSubtitleLine', () => {
    it('strips bracketed cues, non-numeric parentheticals, and uppercase speaker prefixes', () => {
      expect(stripSdhSubtitleLine('[music playing] Hello there')).toBe('Hello there');
      expect(stripSdhSubtitleLine('Hello (chuckles softly) world')).toBe('Hello world');
      expect(stripSdhSubtitleLine('JOHN: Stay right here.')).toBe('Stay right here.');
      expect(stripSdhSubtitleLine('DR. SMITH: [whispers] Move now!')).toBe('Move now!');
      expect(stripSdhSubtitleLine('[whispers] MAN 1: Follow me.')).toBe('Follow me.');
      expect(stripSdhSubtitleLine("O'NEIL: () Move!")).toBe('Move!');
      expect(stripSdhSubtitleLine('')).toBe('');
    });

    it('preserves dialogue dashes, numeric years, and mixed-case colons', () => {
      expect(stripSdhSubtitleLine('- ALICE: Wait for me!')).toBe('- Wait for me!');
      expect(stripSdhSubtitleLine('- [sighs] I cannot go.')).toBe('- I cannot go.');
      expect(stripSdhSubtitleLine('Released in (2024) [applause]')).toBe('Released in (2024)');
      expect(stripSdhSubtitleLine('Era (1999-2004) (dramatic music)')).toBe('Era (1999-2004)');
      expect(stripSdhSubtitleLine('Note: check 12:30 sharp')).toBe('Note: check 12:30 sharp');
    });

    it('returns empty string when nothing remains after SDH removal', () => {
      expect(stripSdhSubtitleLine('[DOOR SLAMS]')).toBe('');
      expect(stripSdhSubtitleLine('- [sighs]')).toBe('');
      expect(stripSdhSubtitleLine('NARRATOR:')).toBe('');
      expect(stripSdhSubtitleLine('[music]\nJOHN: Real line\n(applause)')).toBe('Real line');
    });
  });
});

describe('detectSubtitleFormat', () => {
  it('detects formats from content headers and markers', () => {
    expect(detectSubtitleFormat('\uFEFFWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi')).toBe('vtt');
    expect(detectSubtitleFormat('WEBVTT - Episode 1\n\n00:01.000 --> 00:02.000\nHi')).toBe('vtt');
    expect(detectSubtitleFormat('[Script Info]\nTitle: Demo')).toBe('ass');
    expect(detectSubtitleFormat('Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,Hi')).toBe(
      'ass',
    );
    expect(
      detectSubtitleFormat('<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml">'),
    ).toBe('ttml');
    expect(detectSubtitleFormat('<tt xml:lang="en"><body></body></tt>')).toBe('ttml');
    expect(detectSubtitleFormat('1\n00:00:01,000 --> 00:00:02,000\nHello')).toBe('srt');
    expect(detectSubtitleFormat('01:02.5 --> 01:04.0\nHello', 'captions.vtt')).toBe('vtt');
  });

  it('falls back to filename extension or MIME type and returns null when unknown', () => {
    expect(detectSubtitleFormat('', 'movie.srt')).toBe('srt');
    expect(detectSubtitleFormat('', 'https://cdn.example/sub.vtt?token=1')).toBe('vtt');
    expect(detectSubtitleFormat('', 'movie.ass')).toBe('ass');
    expect(detectSubtitleFormat('', 'movie.ssa')).toBe('ass');
    expect(detectSubtitleFormat('', 'captions.ttml')).toBe('ttml');
    expect(detectSubtitleFormat('', 'captions.xml')).toBe('ttml');
    expect(detectSubtitleFormat('', 'text/vtt; charset=utf-8')).toBe('vtt');
    expect(detectSubtitleFormat('', 'application/x-subrip')).toBe('srt');
    expect(detectSubtitleFormat('', 'text/x-ssa')).toBe('ass');
    expect(detectSubtitleFormat('', 'application/ttml+xml')).toBe('ttml');
    expect(detectSubtitleFormat('just plain text without timestamps')).toBeNull();
  });
});

describe('parseSubtitles — SRT & WebVTT', () => {
  it('recovers from missing, duplicated, and corrupt indices, extra blank lines, and missing separators', () => {
    const malformedSrt = [
      '\uFEFF00:00:01,5 --> 00:00:03,05',
      'First line',
      '',
      '',
      '1',
      '00:00:04:500 -> 00:00:06.25',
      'Second line',
      '99',
      '00:00:07,000 —> 00:00:09,000',
      'Third line',
      '',
      'corrupt-index',
      '00:10.5 --> 00:12.000',
      'Fourth line',
    ].join('\r\n');

    const result = parseSubtitles(malformedSrt);
    expect(result.format).toBe('srt');
    expect(result.warnings).toEqual([]);
    expect(result.cues).toEqual([
      { startMs: 1500, endMs: 3050, text: 'First line', isRtl: false },
      { startMs: 4500, endMs: 6250, text: 'Second line', isRtl: false },
      { startMs: 7000, endMs: 9000, text: 'Third line', isRtl: false },
      { startMs: 10500, endMs: 12000, text: 'Fourth line', isRtl: false },
    ]);
  });

  it('skips WebVTT NOTE, STYLE, REGION blocks and cue settings cleanly', () => {
    const vtt = [
      'WEBVTT',
      'Kind: captions',
      'Language: en',
      '',
      'STYLE',
      '::cue { color: yellow; }',
      '',
      'REGION',
      'id:top width:40%',
      '',
      'NOTE This is a multi-line',
      'comment that must be ignored',
      '',
      'cue-1',
      '00:01.000 --> 00:04.500 align:start position:20% line:80%',
      '<c.yellow>Hello</c> <00:02.000><i>world</i> &amp; friends!',
      '',
      '00:05.000 --> 00:07.000',
      '{\\an8}x < 5 &lt;b&gt;literal&lt;/b&gt;<br/>Line&nbsp;two',
    ].join('\n');

    const result = parseSubtitles(vtt);
    expect(result.format).toBe('vtt');
    expect(result.warnings).toEqual([]);
    expect(result.cues).toEqual([
      { startMs: 1000, endMs: 4500, text: 'Hello world & friends!', isRtl: false },
      { startMs: 5000, endMs: 7000, text: 'x < 5 <b>literal</b>\nLine two', isRtl: false },
    ]);

    const compactVtt = [
      'WEBVTT',
      '00:01.000 --> 00:02.000',
      '<brown>Text</brown>',
      '',
      'NOTE inline without trailing blank',
      '00:03.000 --> 00:04.000',
      '',
      'Trailing text after blank',
    ].join('\n');
    const compact = parseSubtitles(compactVtt);
    expect(compact.cues).toEqual([
      { startMs: 1000, endMs: 2000, text: 'Text', isRtl: false },
      { startMs: 3000, endMs: 4000, text: 'Trailing text after blank', isRtl: false },
    ]);
  });

  it('skips negative/zero durations and corrupt timecodes with warnings without dropping subsequent cues', () => {
    const srt = [
      '1',
      '00:00:05,000 --> 00:00:02,000',
      'Negative duration',
      '',
      '2',
      '00:00:06,000 --> 00:00:06,000',
      'Zero duration',
      '',
      '3',
      '00:00:07,000 --> bad-time',
      'Corrupt line',
      '',
      '4',
      '00:99:00,000 --> 00:99:01,000',
      'Out of range minutes',
      '',
      '5',
      '00:00:08,000 --> 00:00:10,000',
      'Surviving cue',
    ].join('\n');

    const result = parseSubtitles(srt);
    expect(result.cues).toEqual([
      { startMs: 8000, endMs: 10000, text: 'Surviving cue', isRtl: false },
    ]);
    expect(result.warnings).toContain('non-positive-duration');
    expect(result.warnings).toContain('malformed-timecode');
  });

  it('applies RTL bidi isolation by default, supports isolateBidi:false, filterSdh, and sorts cues', () => {
    const srt = [
      '1',
      '00:00:05,000 --> 00:00:07,000',
      '[music] مرحبا بالعالم!',
      '',
      '2',
      '00:00:01,000 --> 00:00:03,000',
      '[applause]',
      '',
      '3',
      '00:00:02,000 --> 00:00:04,000',
      'JOHN: Released (2024)',
    ].join('\n');

    const withSdh = parseSubtitles(srt, { filterSdh: true });
    expect(withSdh.cues).toEqual([
      { startMs: 2000, endMs: 4000, text: 'Released (2024)', isRtl: false },
      { startMs: 5000, endMs: 7000, text: `${RLI}مرحبا بالعالم!${PDI}`, isRtl: true },
    ]);

    const noBidi = parseSubtitles(srt, { filterSdh: true, isolateBidi: false });
    expect(noBidi.cues[1]).toEqual({
      startMs: 5000,
      endMs: 7000,
      text: 'مرحبا بالعالم!',
      isRtl: true,
    });
  });
});

describe('parseSubtitles — ASS / SSA', () => {
  it('parses dynamic [Events] Format columns, centiseconds, newlines, commas, and strips overrides/drawings', () => {
    const ass = [
      '[Script Info]',
      'Title: Dynamic Order',
      '',
      '[Events]',
      'Format: End, Start, Style, Text',
      'Comment: 0:00:02.00,0:00:01.00,Default,Ignored comment',
      'Dialogue: 0:00:04.50,0:00:01.05,Default,{\\an8\\pos(100,200)}Hello, world!\\NSecond\\hline',
      'Dialogue: 0:00:06.00,0:00:05.00,Default,{\\p1}m 0 0 l 100 0 100 100{\\p0}After drawing',
      'Dialogue: 0:00:08.00,0:00:07.00,Default,{\\p1}m 0 0 l 50 50',
      'Dialogue: 0:00:09.00,0:00:10.00,Default,Negative duration',
      '',
      '[Fonts]',
      'Dialogue: 0:00:20.00,0:00:15.00,Default,Not an event',
    ].join('\n');

    const result = parseSubtitles(ass);
    expect(result.format).toBe('ass');
    expect(result.warnings).toContain('non-positive-duration');
    expect(result.cues).toEqual([
      { startMs: 1050, endMs: 4500, text: 'Hello, world!\nSecond line', isRtl: false },
      { startMs: 5000, endMs: 6000, text: 'After drawing', isRtl: false },
    ]);
  });

  it('supports Text not in the final column and missing Format fallback', () => {
    const reordered = [
      '[Events]',
      'Format: Start, Text, End, Style',
      'Dialogue: 0:00:01.00,One, two, three,0:00:03.25,Default',
    ].join('\n');

    const r1 = parseSubtitles(reordered);
    expect(r1.cues).toEqual([
      { startMs: 1000, endMs: 3250, text: 'One, two, three', isRtl: false },
    ]);

    const missingFormat = 'Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,Fallback\\nline';
    const r2 = parseSubtitles(missingFormat);
    expect(r2.format).toBe('ass');
    expect(r2.warnings).toContain('missing-ass-format');
    expect(r2.cues).toEqual([{ startMs: 2000, endMs: 4000, text: 'Fallback\nline', isRtl: false }]);

    const malformedAss = [
      '[Events]',
      'Format: Style, Text',
      'Dialogue: Default,Missing start and end',
      'Format: Start, End, Text',
      'Dialogue: only-one-col',
      'Dialogue: bad,0:00:02.00,Bad time',
      'Dialogue: 0:00:01.00,0:00:03.00,Good{\\unclosed',
    ].join('\n');
    const r3 = parseSubtitles(malformedAss);
    expect(r3.warnings).toContain('malformed-ass-format');
    expect(r3.warnings).toContain('malformed-dialogue');
    expect(r3.warnings).toContain('malformed-timecode');
    expect(r3.cues).toEqual([{ startMs: 1000, endMs: 3000, text: 'Good', isRtl: false }]);
  });
});

describe('parseSubtitles — TTML', () => {
  it('parses clock, frame-rate, and offset times, <br/>, nested <span>, and XML entities', () => {
    const ttml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="25" ttp:tickRate="1000">',
      '  <body><div>',
      '    <p>Untimed metadata paragraph</p>',
      '    <p begin="00:00:01.250" end="00:00:03:12">',
      '      <span>Hello &amp; welcome</span><br />',
      '      Line two',
      '    </p>',
      '    <p begin="12.5s" dur="2500ms">Offset seconds &amp; ms</p>',
      "    <p begin='1m' end='1h'>Minutes to hour</p>",
      '    <p begin="25f" dur="500t">Frames and ticks</p>',
      '    <tt:p begin="5s" end="3s">Bad negative</tt:p>',
      '    <p begin="bad" end="6s">Bad timestamp</p>',
      '  </div></body>',
      '</tt>',
    ].join('\n');

    const result = parseSubtitles(ttml);
    expect(result.format).toBe('ttml');
    expect(result.warnings).toContain('non-positive-duration');
    expect(result.warnings).toContain('malformed-timecode');
    expect(result.cues).toEqual([
      { startMs: 1000, endMs: 1500, text: 'Frames and ticks', isRtl: false },
      { startMs: 1250, endMs: 3480, text: 'Hello & welcome\nLine two', isRtl: false },
      { startMs: 12500, endMs: 15000, text: 'Offset seconds & ms', isRtl: false },
      { startMs: 60000, endMs: 3600000, text: 'Minutes to hour', isRtl: false },
    ]);

    const defaultFpsTtml =
      '<tt><body><p begin="00:00:01:15" end="00:00:02:00">30fps</p></body></tt>';
    expect(parseSubtitles(defaultFpsTtml).cues).toEqual([
      { startMs: 1500, endMs: 2000, text: '30fps', isRtl: false },
    ]);
  });
});

describe('parseSubtitles — limits & unknown format', () => {
  it('truncates oversized input at maxBytes with warning and keeps earlier cues', () => {
    expect(DEFAULT_MAX_SUBTITLE_BYTES).toBe(4 * 1024 * 1024);

    const srt = [
      '1',
      '00:00:01,000 --> 00:00:02,000',
      'Keep me',
      '',
      '2',
      '00:00:03,000 --> 00:00:04,000',
      'مرحبا 😀 '.repeat(20),
    ].join('\n');

    const result = parseSubtitles(srt, { maxBytes: 50 });
    expect(result.warnings).toContain('input-truncated');
    expect(result.cues).toEqual([{ startMs: 1000, endMs: 2000, text: 'Keep me', isRtl: false }]);

    const exactUtf8 = '1\n00:00:01,000 --> 00:00:02,000\nمرحبا';
    // 32 ASCII bytes + 10 UTF-8 bytes = 42 bytes
    const exactFit = parseSubtitles(exactUtf8, { maxBytes: 42 });
    expect(exactFit.warnings).toEqual([]);
    expect(exactFit.cues).toHaveLength(1);

    const zeroCap = parseSubtitles(srt, { maxBytes: 0 });
    expect(zeroCap.warnings).toContain('input-truncated');
    expect(zeroCap.cues).toEqual([]);
  });

  it('handles empty and unrecognized input without throwing', () => {
    expect(parseSubtitles('')).toEqual({ format: 'srt', cues: [], warnings: [] });
    const unknown = parseSubtitles('completely unrecognized garbage text');
    expect(unknown.cues).toEqual([]);
    expect(unknown.warnings).toContain('unknown-format');
  });

  it('parses pathological 200 KiB unclosed-delimiter payloads in linear time (< 1000 ms)', () => {
    const ttmlUnclosedP = `<tt><body>${'<p>'.repeat(40_000)}</body></tt>`;
    const ttmlUnclosedRoot = `${'<tt '.repeat(40_000)}`;
    const ttmlUnclosedBr = `<tt><body><p begin="1s" end="2s">${'<br '.repeat(40_000)}ok</p></body></tt>`;
    const srtUnclosedBrace = `1\n00:00:01,000 --> 00:00:02,000\n${'{\\'.repeat(40_000)}ok`;
    const sdhUnclosedBrackets = '['.repeat(40_000);
    const sdhUnclosedParens = '('.repeat(40_000);

    const start = performance.now();
    expect(parseSubtitles(ttmlUnclosedP, { format: 'ttml' }).cues).toEqual([]);
    expect(parseSubtitles(ttmlUnclosedRoot, { format: 'ttml' }).cues).toEqual([]);
    expect(parseSubtitles(ttmlUnclosedBr, { format: 'ttml' }).cues).toHaveLength(1);
    expect(parseSubtitles(srtUnclosedBrace, { format: 'srt' }).cues).toHaveLength(1);
    expect(stripSdhSubtitleLine(sdhUnclosedBrackets)).toBe(sdhUnclosedBrackets);
    expect(stripSdhSubtitleLine(sdhUnclosedParens)).toBe(sdhUnclosedParens);
    const elapsedMs = performance.now() - start;

    expect(elapsedMs).toBeLessThan(1_000);
  });
});

describe('findActiveCues', () => {
  const cues: ParsedSubtitleCue[] = [
    { startMs: 1000, endMs: 10000, text: 'Long banner', isRtl: false },
    { startMs: 2000, endMs: 3000, text: 'Short A', isRtl: false },
    { startMs: 4000, endMs: 5000, text: 'Short B', isRtl: false },
    { startMs: 6000, endMs: 7000, text: 'Short C', isRtl: false },
  ];

  it('uses half-open [startMs, endMs) boundaries and returns all overlapping cues', () => {
    expect(findActiveCues([], 1000)).toEqual([]);
    expect(findActiveCues(cues, -1)).toEqual([]);
    expect(findActiveCues(cues, Number.NaN)).toEqual([]);
    expect(findActiveCues(cues, 999)).toEqual([]);
    expect(findActiveCues(cues, 1000).map((c) => c.text)).toEqual(['Long banner']);
    expect(findActiveCues(cues, 2000).map((c) => c.text)).toEqual(['Long banner', 'Short A']);
    expect(findActiveCues(cues, 3000).map((c) => c.text)).toEqual(['Long banner']);
    expect(findActiveCues(cues, 6500).map((c) => c.text)).toEqual(['Long banner', 'Short C']);
    expect(findActiveCues(cues, 10000)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { extractLanguageCodeFromLabel, normalizeLanguageCode, sameLanguageCode } from './index';

describe('normalizeLanguageCode', () => {
  it('normalizes ISO 639-1, ISO 639-2(T+B), and BCP-47 tags to canonical codes', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['en', 'en'],
      ['eng', 'en'],
      ['en-US', 'en'],
      ['EN_gb', 'en'],
      ['tr', 'tr'],
      ['tur', 'tr'],
      ['tr-TR', 'tr'],
      ['de', 'de'],
      ['deu', 'de'],
      ['ger', 'de'],
      ['fr', 'fr'],
      ['fra', 'fr'],
      ['fre', 'fr'],
      ['es', 'es'],
      ['spa', 'es'],
      ['ar', 'ar'],
      ['ara', 'ar'],
      ['ru', 'ru'],
      ['rus', 'ru'],
      ['it', 'it'],
      ['ita', 'it'],
      ['pt', 'pt'],
      ['por', 'pt'],
      ['pt-BR', 'pt'],
      ['nl', 'nl'],
      ['nld', 'nl'],
      ['dut', 'nl'],
      ['pl', 'pl'],
      ['pol', 'pl'],
      ['zh', 'zh'],
      ['zho', 'zh'],
      ['chi', 'zh'],
      ['zh-Hant-HK', 'zh'],
      ['ja', 'ja'],
      ['jpn', 'ja'],
      ['ko', 'ko'],
      ['kor', 'ko'],
      ['fa', 'fa'],
      ['fas', 'fa'],
      ['per', 'fa'],
      ['el', 'el'],
      ['ell', 'el'],
      ['gre', 'el'],
      ['cs', 'cs'],
      ['ces', 'cs'],
      ['cze', 'cs'],
      ['ro', 'ro'],
      ['ron', 'ro'],
      ['rum', 'ro'],
      ['sv', 'sv'],
      ['swe', 'sv'],
      ['uk', 'uk'],
      ['ukr', 'uk'],
      ['ku', 'ku'],
      ['kur', 'ku'],
      ['az', 'az'],
      ['aze', 'az'],
      ['bo', 'bo'],
      ['bod', 'bo'],
      ['tib', 'bo'],
      ['my', 'my'],
      ['mya', 'my'],
      ['bur', 'my'],
      ['is', 'is'],
      ['isl', 'is'],
      ['ice', 'is'],
      ['cy', 'cy'],
      ['cym', 'cy'],
      ['wel', 'cy'],
      ['eu', 'eu'],
      ['eus', 'eu'],
      ['baq', 'eu'],
      ['mi', 'mi'],
      ['mri', 'mi'],
      ['mao', 'mi'],
      ['bn', 'bn'],
      ['ben', 'bn'],
      ['ca', 'ca'],
      ['cat', 'ca'],
      ['gl', 'gl'],
      ['glg', 'gl'],
      ['ta', 'ta'],
      ['tam', 'ta'],
      ['te', 'te'],
      ['tel', 'te'],
      ['ur', 'ur'],
      ['urd', 'ur'],
      ['fil', 'fil'],
    ];
    for (const [input, expected] of cases) {
      expect(normalizeLanguageCode(input), `input: ${input}`).toBe(expected);
    }
  });

  it('treats undetermined, empty, malformed, and prototype tags safely', () => {
    for (const raw of [
      undefined,
      null,
      '',
      '   ',
      'und',
      'UND',
      'zxx',
      'mul',
      'mis',
      'unknown',
      '---',
      '123',
      '__proto__',
    ]) {
      expect(normalizeLanguageCode(raw), `input: ${String(raw)}`).toBeUndefined();
    }
    expect(normalizeLanguageCode('constructor')).toBeUndefined();
  });

  it('compares canonical language equality across 2-letter, 3-letter, and region tags', () => {
    expect(sameLanguageCode('en-US', 'eng')).toBe(true);
    expect(sameLanguageCode('ger', 'deu')).toBe(true);
    expect(sameLanguageCode('fre', 'fra')).toBe(true);
    expect(sameLanguageCode('tib', 'bod')).toBe(true);
    expect(sameLanguageCode('bur', 'mya')).toBe(true);
    expect(sameLanguageCode('mao', 'mri')).toBe(true);
    expect(sameLanguageCode('tur', 'TR')).toBe(true);
    expect(sameLanguageCode('bos', 'bs')).toBe(true);
    expect(sameLanguageCode('und', 'und')).toBe(false);
    expect(sameLanguageCode(undefined, 'en')).toBe(false);
  });

  it('never matches language codes as substrings of unrelated words (#189)', () => {
    expect(sameLanguageCode('es', 'Chinese')).toBe(false);
    expect(sameLanguageCode('es', 'Japanese')).toBe(false);
    expect(sameLanguageCode('es', 'Portuguese')).toBe(false);
    expect(sameLanguageCode('en', 'French')).toBe(false);
    expect(sameLanguageCode('de', 'Sweden')).toBe(false);
  });
});

describe('extractLanguageCodeFromLabel', () => {
  it('extracts canonical language codes from whole-word names and ISO 639-2(T+B) tokens (#189)', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['Chinese', 'zh'],
      ['Chinese (Simplified)', 'zh'],
      ['Japanese', 'ja'],
      ['Japanese (Forced)', 'ja'],
      ['Spanish', 'es'],
      ['Español (Latino)', 'es'],
      ['English (SDH)', 'en'],
      ['Turkish', 'tr'],
      ['Türkçe 5.1', 'tr'],
      ['Deutsch', 'de'],
      ['Français', 'fr'],
      ['[ES] Audio', 'es'],
      ['SPA 5.1', 'es'],
      ['GER Dolby Digital', 'de'],
      ['DEU', 'de'],
      ['FRE', 'fr'],
      ['FRA', 'fr'],
      ['TIB', 'bo'],
      ['BOD', 'bo'],
      ['BUR', 'my'],
      ['MYA', 'my'],
      ['MAO', 'mi'],
      ['MRI', 'mi'],
      ['en-US (Forced)', 'en'],
      ['pt_BR', 'pt'],
      ['IT', 'it'],
      ['[NO]', 'no'],
      ['IS', 'is'],
    ];
    for (const [label, expected] of cases) {
      expect(extractLanguageCodeFromLabel(label), `label: ${label}`).toBe(expected);
    }
  });

  it('never matches "es" inside Chinese/Japanese or ambiguous English words in multi-word labels', () => {
    expect(extractLanguageCodeFromLabel('Chinese')).not.toBe('es');
    expect(extractLanguageCodeFromLabel('Japanese')).not.toBe('es');
    expect(extractLanguageCodeFromLabel('Vietnamese')).toBe('vi');
    expect(extractLanguageCodeFromLabel('Portuguese')).toBe('pt');
    for (const nonLanguage of [
      undefined,
      null,
      '',
      '   ',
      'und',
      'No Subtitles',
      'This is commentary',
      'Hi-Fi Stereo',
      'Track ID 2',
      'My Audio',
      'Original',
      'Commentary 2.0',
      'Forced SDH',
    ]) {
      expect(
        extractLanguageCodeFromLabel(nonLanguage),
        `label: ${String(nonLanguage)}`,
      ).toBeUndefined();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { normalizeLanguageCode, sameLanguageCode } from './index';

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
    expect(sameLanguageCode('tur', 'TR')).toBe(true);
    expect(sameLanguageCode('und', 'und')).toBe(false);
    expect(sameLanguageCode(undefined, 'en')).toBe(false);
  });
});

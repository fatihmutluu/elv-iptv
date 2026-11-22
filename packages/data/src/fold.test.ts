import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { foldGuideMatchText, foldText, sortTitleKey } from './fold';

describe('foldText', () => {
  it.each([
    ['İSTANBUL Iğdır', 'istanbul igdir'],
    ['ÇAĞRI  Şükrü', 'cagri sukru'],
    ['Straße', 'strasse'],
    ['Café-Crème, HD!', 'cafe creme hd'],
    ['', ''],
    ['   ', ''],
    ['Ȧbc', 'abc'],
  ])('folds %j to %j', (input, expected) => {
    expect(foldText(input)).toBe(expected);
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => foldText(foldText(s)) === foldText(s)),
    );
  });
});

describe('sortTitleKey', () => {
  it.each([
    ['The Signal', 'signal'],
    ['A Quiet Harbor', 'quiet harbor'],
    ['An Ocean Story', 'ocean story'],
    ['Bir Zamanlar', 'zamanlar'],
    ['BİR İstanbul Masalı', 'istanbul masali'],
    ['The', 'the'],
    ['A', 'a'],
    ['An', 'an'],
    ['Bir', 'bir'],
    ['  The  ', 'the'],
    ['Theater Night', 'theater night'],
    ['Birinci Kanal', 'birinci kanal'],
    ['İstanbul', 'istanbul'],
    ['', ''],
    ['---', ''],
  ])('maps %j to %j', (input, expected) => {
    expect(sortTitleKey(input)).toBe(expected);
  });
});

describe('foldGuideMatchText (#194)', () => {
  it.each([
    ['NewsOne', 'news 1'],
    ['NewsChannel', 'news channel'],
    ['SportsTV2', 'sports tv 2'],
    ['SportsTVNews', 'sports tv news'],
    ['TV2HD', 'tv 2 hd'],
    ['Channel Zero', 'channel 0'],
    ['One Two Three Four Five Six Seven Eight Nine', '1 2 3 4 5 6 7 8 9'],
    ['Someone Nineveh', 'someone nineveh'],
    ['İSTANBULOne', 'istanbul 1'],
    ['ÇağrıTVŞov', 'cagri tv sov'],
    ['IğdırTwo', 'igdir 2'],
    ['ÖzgürÜç', 'ozgur uc'],
    ['Straße', 'strasse'],
    ['', ''],
    ['   ', ''],
  ])('folds %j to %j', (input, expected) => {
    expect(foldGuideMatchText(input)).toBe(expected);
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary' }),
        (s) => foldGuideMatchText(foldGuideMatchText(s)) === foldGuideMatchText(s),
      ),
    );
  });
});

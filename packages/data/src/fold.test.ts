import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { foldText, sortTitleKey } from './fold';

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

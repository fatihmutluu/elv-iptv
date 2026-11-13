import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { foldText } from './fold';

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

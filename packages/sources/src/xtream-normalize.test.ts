import { describe, expect, it } from 'vitest';
import { mergeById, toNumber, toText } from './xtream-normalize';

describe('toNumber', () => {
  it('accepts numbers and numeric strings', () => {
    expect(toNumber(5)).toBe(5);
    expect(toNumber(' 7.5 ')).toBe(7.5);
    expect(toNumber('0')).toBe(0);
  });
  it('treats empty, null, NaN and junk as absent', () => {
    for (const v of ['', '  ', null, undefined, Number.NaN, 'abc', {}, [], true, Infinity]) {
      expect(toNumber(v)).toBeUndefined();
    }
  });
});

describe('toText', () => {
  it('decodes entities and trims', () => {
    expect(toText('Kanal &amp; Co ')).toBe('Kanal & Co');
  });
  it('turns numbers into text and empties into absent', () => {
    expect(toText(2024)).toBe('2024');
    for (const v of ['', '   ', null, undefined, {}, Number.NaN]) expect(toText(v)).toBeUndefined();
  });
});

describe('mergeById', () => {
  it('keeps the first record and unions categories in order', () => {
    const merged = mergeById([
      { id: 1, categoryIds: ['1'], n: 'a' },
      { id: 2, categoryIds: ['3'], n: 'b' },
      { id: 1, categoryIds: ['2', '1'], n: 'c' },
    ]);
    expect(merged).toEqual([
      { id: 1, categoryIds: ['1', '2'], n: 'a' },
      { id: 2, categoryIds: ['3'], n: 'b' },
    ]);
  });
});

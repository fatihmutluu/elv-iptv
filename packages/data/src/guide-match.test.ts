import { describe, expect, it } from 'vitest';
import { buildChannelIndex, matchGuideChannel, resolveMappings } from './guide-match';

const rows = [
  { key: 'a', guide_id: 'haber1.tr', name_fold: 'haber bir' },
  { key: 'b', guide_id: 'haber1.tr', name_fold: 'haber bir hd' },
  { key: 'c', guide_id: null, name_fold: 'spor iki' },
  { key: 'd', guide_id: '', name_fold: 'ikiz' },
  { key: 'e', guide_id: null, name_fold: 'ikiz' },
  { key: 'f', guide_id: null, name_fold: 'cagri tv' },
  { key: 'g', guide_id: null, name_fold: '' },
];
const index = buildChannelIndex(rows);
const keys = (id: string, names: string[]) => matchGuideChannel(index, { id, names }).keys;

describe('guide matching', () => {
  it('maps every live channel that shares the guide id', () => {
    const match = matchGuideChannel(index, { id: 'haber1.tr', names: ['Other'] });
    expect(match.byId).toBe(true);
    expect(match.keys.sort()).toEqual(['a', 'b']);
  });

  it('falls back to a unique folded name', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['SPOR  İKİ'] })).toEqual({
      keys: ['c'],
      byId: false,
    });
  });

  it('folds case and Turkish letters', () => {
    expect(keys('x', ['ÇAĞRI TV'])).toEqual(['f']);
  });

  it('ambiguous names are skipped', () => {
    expect(keys('x', ['Ikiz'])).toEqual([]);
  });

  it('skips an ambiguous name but accepts another unique one', () => {
    expect(keys('x', ['Ikiz', 'Spor Iki'])).toEqual(['c']);
  });

  it('refuses names that point at different channels', () => {
    expect(keys('x', ['Spor Iki', 'Cagri TV'])).toEqual([]);
  });

  it('ignores empty names and unknown channels', () => {
    expect(keys('x', ['', '!!!', 'Nope'])).toEqual([]);
  });
});

describe('resolveMappings', () => {
  it('lets an id match win over a name match in either order', () => {
    expect(resolveMappings([['k', 'exact']], [['k', 'named']])).toEqual([['k', 'exact']]);
  });

  it('drops a channel that several guide channels name and keeps repeated names of one', () => {
    expect(
      resolveMappings(
        [],
        [
          ['k', 'one'],
          ['k', 'two'],
          ['m', 'same'],
          ['m', 'same'],
        ],
      ),
    ).toEqual([['m', 'same']]);
  });

  it('keeps the first id match of a channel', () => {
    expect(
      resolveMappings(
        [
          ['k', 'first'],
          ['k', 'second'],
        ],
        [],
      ),
    ).toEqual([['k', 'first']]);
  });
});

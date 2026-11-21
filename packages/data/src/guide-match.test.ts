import { describe, expect, it } from 'vitest';
import { buildChannelIndex, matchGuideChannel, resolveMappings } from './guide-match';

const rows = [
  { key: 'a', guide_id: 'haber1.tr', name_fold: 'haber bir', num: 1 },
  { key: 'b', guide_id: 'haber1.tr', name_fold: 'haber bir hd', num: 2 },
  { key: 'c', guide_id: null, name_fold: 'spor iki', num: 10 },
  { key: 'd', guide_id: '', name_fold: 'ikiz', num: 200 },
  { key: 'e', guide_id: null, name_fold: 'ikiz', num: 200 },
  { key: 'f', guide_id: null, name_fold: 'cagri tv', num: 30 },
  { key: 'g', guide_id: null, name_fold: '', num: 101 },
  { key: 'h', guide_id: null, name_fold: 'channel one oh two', num: 102 },
  { key: 'm', guide_id: null, name_fold: 'channel twenty four', num: 24 },
  { key: 'n', guide_id: null, name_fold: 'channel three sixty', num: 360 },
  { key: 'o', guide_id: null, name_fold: 'channel thousand one', num: 1001 },
  { key: 'i', guide_id: null, name_fold: 'bad nums', num: 0 },
  { key: 'j', guide_id: null, name_fold: 'neg num', num: -5 },
  { key: 'k', guide_id: null, name_fold: 'float num', num: 12.5 },
  { key: 'l', guide_id: null, name_fold: 'null num', num: null },
];
const index = buildChannelIndex(rows);
const keys = (id: string, names: string[]) => matchGuideChannel(index, { id, names }).keys;

describe('guide matching', () => {
  it('maps every live channel that shares the guide id', () => {
    const match = matchGuideChannel(index, { id: 'haber1.tr', names: ['Other'] });
    expect(match.byId).toBe(true);
    expect(match.tier).toBe('id');
    expect(match.keys.sort()).toEqual(['a', 'b']);
  });

  it('falls back to a unique folded name', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['SPOR  İKİ'] })).toEqual({
      keys: ['c'],
      byId: false,
      tier: 'name',
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

  it('refuses names that point at different channels without falling back to num', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['Spor Iki', 'Cagri TV', '101'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
  });

  it('ignores empty names and unknown channels', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['', '!!!', 'Nope'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
  });

  it('falls back to a unique channel number from exact, #-prefixed, or delimiter-separated display names', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['101'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['#101'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['#101 Sports'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['101 - Sports'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['#101 - Sports HD'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['101: News', '101'] })).toEqual({
      keys: ['g'],
      byId: false,
      tier: 'num',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['102 | Cinema'] })).toEqual({
      keys: ['h'],
      byId: false,
      tier: 'num',
    });
  });

  it('does not treat bare space-separated numeric brand names as channel numbers', () => {
    for (const brand of ['24 News', '360 TV', '1001 Nights', '101 Sports']) {
      expect(matchGuideChannel(index, { id: 'x', names: [brand] })).toEqual({
        keys: [],
        byId: false,
        tier: 'none',
      });
    }
  });

  it('prefers byId over byName and byName over byNum', () => {
    expect(matchGuideChannel(index, { id: 'haber1.tr', names: ['Spor Iki', '101'] })).toMatchObject(
      { byId: true, tier: 'id' },
    );
    expect(matchGuideChannel(index, { id: 'x', names: ['101', 'Spor Iki'] })).toEqual({
      keys: ['c'],
      byId: false,
      tier: 'name',
    });
  });

  it('rejects ambiguous live channel numbers, conflicting display-name numbers, and non-channel tokens', () => {
    // Two live channels share num = 200
    expect(matchGuideChannel(index, { id: 'x', names: ['200', '200 - Twin'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
    // Conflicting numbers pointing to two different live channels (101 -> g, 102 -> h)
    expect(matchGuideChannel(index, { id: 'x', names: ['101', '102'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
    // Conflicting extracted numbers where one is ambiguous (200) or absent (999) still refuse to guess
    expect(matchGuideChannel(index, { id: 'x', names: ['200', '101'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
    expect(matchGuideChannel(index, { id: 'x', names: ['999', '101'] })).toEqual({
      keys: [],
      byId: false,
      tier: 'none',
    });
    // Non-positive, invalid, or non-channel-number prefixes never match
    expect(keys('x', ['0', '-5', '12.5', '101:30 News', '101/7', '101p HD'])).toEqual([]);
    expect(index.byNum.has(0)).toBe(false);
    expect(index.byNum.has(-5)).toBe(false);
    expect(index.byNum.has(12.5)).toBe(false);
  });
});

describe('resolveMappings', () => {
  it('lets an id match win over a name match in either order', () => {
    expect(resolveMappings([['k', 'exact']], [['k', 'named']])).toEqual([['k', 'exact']]);
  });

  it('enforces strict 3-tier precedence: byId > byName > byNum', () => {
    expect(
      resolveMappings(
        [['k1', 'id-winner']],
        [
          ['k1', 'name-loser'],
          ['k2', 'name-winner'],
        ],
        [
          ['k1', 'num-loser-1'],
          ['k2', 'num-loser-2'],
          ['k3', 'num-winner'],
          ['k3', 'num-winner'],
        ],
      ),
    ).toEqual([
      ['k1', 'id-winner'],
      ['k2', 'name-winner'],
      ['k3', 'num-winner'],
    ]);
  });

  it('drops a channel that several guide channels claim by number', () => {
    expect(
      resolveMappings(
        [],
        [],
        [
          ['k', 'guide-a'],
          ['k', 'guide-b'],
          ['m', 'guide-c'],
        ],
      ),
    ).toEqual([['m', 'guide-c']]);
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

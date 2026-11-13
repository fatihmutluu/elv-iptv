import { describe, expect, it } from 'vitest';
import { buildChannelIndex, matchGuideChannel } from './guide-match';

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

describe('guide matching', () => {
  it('maps every live channel that shares the guide id', () => {
    expect(matchGuideChannel(index, { id: 'haber1.tr', names: ['Other'] }).sort()).toEqual([
      'a',
      'b',
    ]);
  });

  it('falls back to a unique folded name', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['SPOR  İKİ'] })).toEqual(['c']);
  });

  it('folds case and Turkish letters', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['ÇAĞRI TV'] })).toEqual(['f']);
  });

  it('ambiguous names are skipped', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['Ikiz'] })).toEqual([]);
  });

  it('skips an ambiguous name but accepts another unique one', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['Ikiz', 'Spor Iki'] })).toEqual(['c']);
  });

  it('refuses names that point at different channels', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['Spor Iki', 'Cagri TV'] })).toEqual([]);
  });

  it('ignores empty names and unknown channels', () => {
    expect(matchGuideChannel(index, { id: 'x', names: ['', '!!!', 'Nope'] })).toEqual([]);
  });
});

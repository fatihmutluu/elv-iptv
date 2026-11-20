import { describe, expect, it } from 'vitest';
import { buildDesktopCorpusItems } from '../../apps/desktop/renderer/src/gate/corpus-items.ts';
import { buildCorpusItems } from '../../apps/tv-mobile/src/gate/corpus/corpus-items.ts';
import { buildGateCorpusItems } from '../src/gates/corpus-gate.ts';
import { CORPUS_ITEM_COUNT } from '../src/gates/corpus-judge.ts';
import { corpusCatalog } from '../src/sim/corpus.ts';

const base = 'http://127.0.0.1:7878';
const account = 'demo';

describe('format corpus manifests', () => {
  for (const burst of [0, 8]) {
    it(`agree item for item across the gate, the TV app and the desktop app (burst ${burst})`, () => {
      const opts = { base, account, burst };
      const gate = buildGateCorpusItems(opts);
      expect(gate).toHaveLength(CORPUS_ITEM_COUNT);
      expect(new Set(gate.map((item) => item.id)).size).toBe(CORPUS_ITEM_COUNT);
      expect(buildCorpusItems(opts)).toEqual(gate);
      expect(buildDesktopCorpusItems(opts)).toEqual(gate);
    });
  }

  it('cover every corpusCatalog channel and movie', () => {
    const catalog = corpusCatalog(1);
    const ids = new Set(buildGateCorpusItems({ base, account }).map((item) => item.id));
    for (const ch of catalog.live) expect(ids).toContain(`live-${ch.id}`);
    for (const movie of catalog.movies) expect(ids).toContain(`vod-${movie.id}`);
  });

  it('expect the empty VOD to fail as an empty media response, flag audio-only items and align live-1010 tracks', () => {
    const items = buildGateCorpusItems({ base, account });
    expect(items.find((item) => item.id === 'live-1010')).toMatchObject({
      selectAudioLang: 'eng',
    });
    expect(items.find((item) => item.id === 'live-1010')?.selectSubtitleLang).toBeUndefined();
    expect(items.find((item) => item.id === 'vod-200001-empty')).toMatchObject({
      url: `${base}/movie/demo/demo/200001.mp4?fault=empty`,
      expect: 'failed',
      expectErrors: ['playback/network', 'playback/unsupported-format'],
    });
    expect(items.filter((item) => item.audioOnly === true).map((item) => item.id)).toEqual([
      'live-1006',
      'vod-200006',
    ]);
  });
});

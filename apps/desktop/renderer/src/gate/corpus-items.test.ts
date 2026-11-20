import { describe, expect, it } from 'vitest';
import { buildDesktopCorpusItems } from './corpus-items.ts';
import { parseGateParams } from './params.ts';

describe('desktop corpus gate params and items', () => {
  it('parses elv-gate=corpus and builds all 29 items', () => {
    expect(parseGateParams('elv-gate=corpus')).toMatchObject({
      base: 'http://127.0.0.1:7878',
      account: 'corpus',
      corpus: true,
      burst: 0,
    });
    expect(
      parseGateParams('elv-gate=player&corpus=1&base=http://127.0.0.1:7878&account=demo&burst=8'),
    ).toMatchObject({
      base: 'http://127.0.0.1:7878',
      account: 'demo',
      corpus: true,
      burst: 8,
    });
    const items = buildDesktopCorpusItems({ base: 'http://127.0.0.1:7878', account: 'demo' });
    expect(items).toHaveLength(29);
    expect(new Set(items.map((item) => item.id)).size).toBe(29);
    expect(items[0]?.url).toBe('http://127.0.0.1:7878/live/demo/demo/1001.ts');
    expect(items[12]?.url).toBe('http://127.0.0.1:7878/demo/demo/1013');
  });

  it('joins the burst into every live TS fault query', () => {
    const items = buildDesktopCorpusItems({
      base: 'http://127.0.0.1:7878',
      account: 'demo',
      burst: 8,
    });
    expect(items[0]?.url).toBe('http://127.0.0.1:7878/live/demo/demo/1001.ts?fault=burst=8');
    expect(items[11]?.url).toBe(
      'http://127.0.0.1:7878/live/demo/demo/1012.ts?fault=type=text/html,burst=8',
    );
  });

  it('expects the empty VOD item to fail as empty media and sets track checks accurately', () => {
    const items = buildDesktopCorpusItems({ base: 'http://127.0.0.1:7878', account: 'demo' });
    expect(items[28]).toEqual({
      id: 'vod-200001-empty',
      label: 'Empty 200 VOD response',
      kind: 'vod',
      url: 'http://127.0.0.1:7878/movie/demo/demo/200001.mp4?fault=empty',
      expect: 'failed',
      expectErrors: ['playback/network', 'playback/unsupported-format'],
    });
    expect(items.filter((item) => item.expect === 'failed')).toHaveLength(1);
    expect(items.find((item) => item.id === 'live-1010')).toMatchObject({
      selectAudioLang: 'eng',
    });
    expect(items.find((item) => item.id === 'live-1010')?.selectSubtitleLang).toBeUndefined();
    expect(
      items
        .filter(
          (item) => item.selectAudioLang !== undefined || item.selectSubtitleLang !== undefined,
        )
        .map((item) => item.id),
    ).toEqual(['live-1010', 'live-1010-hls', 'vod-200010', 'vod-200011', 'vod-200010-hls']);
    expect(items.filter((item) => item.audioOnly === true).map((item) => item.id)).toEqual([
      'live-1006',
      'vod-200006',
    ]);
  });
});

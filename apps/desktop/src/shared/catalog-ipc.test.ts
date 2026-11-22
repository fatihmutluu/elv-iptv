import { describe, expect, it } from 'vitest';
import {
  CATALOG_CHANNELS,
  isCatalogClientMessage,
  isCatalogConnectMessage,
  isCatalogPortMessage,
  isCatalogWorkerMessage,
} from './catalog-ipc.ts';

describe('CATALOG_CHANNELS', () => {
  it('exposes frozen channel names', () => {
    expect(Object.isFrozen(CATALOG_CHANNELS)).toBe(true);
    expect(CATALOG_CHANNELS).toEqual({
      connect: 'catalog:connect',
      port: 'catalog:port',
      disconnected: 'catalog:disconnected',
      changed: 'catalog:changed',
    });
  });
});

describe('isCatalogConnectMessage / isCatalogPortMessage', () => {
  it('accepts positive integer connectIds and rejects everything else', () => {
    expect(isCatalogConnectMessage({ connectId: 1 })).toBe(true);
    expect(isCatalogPortMessage({ connectId: 42 })).toBe(true);
    for (const bad of [
      null,
      '1',
      {},
      { connectId: 0 },
      { connectId: -1 },
      { connectId: 1.5 },
      { connectId: Number.NaN },
    ]) {
      expect(isCatalogConnectMessage(bad)).toBe(false);
      expect(isCatalogPortMessage(bad)).toBe(false);
    }
  });
});

describe('isCatalogClientMessage', () => {
  it('accepts valid calls across every CatalogService method and cancel', () => {
    const valid: unknown[] = [
      { type: 'call', reqId: 1, call: { method: 'ping' } },
      {
        type: 'call',
        reqId: 2,
        call: {
          method: 'addSource',
          input: {
            kind: 'xtream',
            name: 'Main',
            server: 'http://127.0.0.1:7879',
            username: 'demo',
            password: 'secret',
            guideUrl: 'http://127.0.0.1:7879/xmltv.php',
            transport: { userAgent: 'ELV/0.1', referer: 'http://example.test', xtreamFormat: 'ts' },
          },
        },
      },
      {
        type: 'call',
        reqId: 3,
        call: {
          method: 'addSource',
          input: {
            kind: 'm3u',
            name: 'Playlist',
            playlistUrl: 'http://127.0.0.1:7879/get.php?token=abc',
            vodPlaylist: true,
          },
        },
      },
      {
        type: 'call',
        reqId: 4,
        call: {
          method: 'addSourceFromLink',
          input: {
            name: 'Linked',
            url: 'http://127.0.0.1:7879/get.php?username=u&password=p',
            keepAsM3u: false,
            transport: { xtreamFormat: 'm3u8' },
          },
        },
      },
      { type: 'call', reqId: 5, call: { method: 'removeSource', id: 'src_1' } },
      {
        type: 'call',
        reqId: 6,
        call: {
          method: 'importSource',
          id: 'src_1',
          batchSize: 5000,
          maxBodyBytes: 4096,
          progress: true,
        },
      },
      { type: 'call', reqId: 7, call: { method: 'listSources' } },
      { type: 'call', reqId: 8, call: { method: 'categories', sourceId: 'src_1', kind: 'live' } },
      {
        type: 'call',
        reqId: 9,
        call: { method: 'items', categoryId: 'src_1|live|10', offset: 0, limit: 100 },
      },
      { type: 'call', reqId: 9, call: { method: 'itemDetail', itemKey: 'x:src_1:series:42' } },
      { type: 'call', reqId: 9, call: { method: 'search', query: 'İstanbul Haber' } },
      { type: 'call', reqId: 9, call: { method: 'search', query: '' } },
      {
        type: 'call',
        reqId: 9,
        call: {
          method: 'search',
          query: 'gunes',
          opts: { scope: 'movie', limit: 60, sourceId: 'src_1' },
        },
      },
      {
        type: 'call',
        reqId: 9,
        call: { method: 'search', query: 'ozgur', opts: { scope: 'all', limit: 0 } },
      },
      { type: 'call', reqId: 10, call: { method: 'seasons', seriesId: 12 } },
      { type: 'call', reqId: 10, call: { method: 'seasons', seriesId: 0 } },
      { type: 'call', reqId: 11, call: { method: 'episodes', seriesId: 12, season: 1 } },
      { type: 'call', reqId: 11, call: { method: 'episodes', seriesId: 0, season: 1 } },
      { type: 'call', reqId: 12, call: { method: 'resolveStream', itemKey: 'x:src_1:live:1001' } },
      { type: 'call', reqId: 12, call: { method: 'resolveStream', itemKey: '' } },
      { type: 'call', reqId: 13, call: { method: 'categories', sourceId: '', kind: 'live' } },
      { type: 'call', reqId: 14, call: { method: 'items', categoryId: '', offset: 0, limit: 25 } },
      { type: 'call', reqId: 15, call: { method: 'removeSource', id: '' } },
      { type: 'call', reqId: 16, call: { method: 'removeSource', id: '../bad' } },
      { type: 'call', reqId: 17, call: { method: 'importSource', id: '' } },
      {
        type: 'call',
        reqId: 18,
        call: {
          method: 'addSourceFromLink',
          input: { name: 'Pasted', url: '  http://127.0.0.1:7879/list.m3u\r\n' },
        },
      },
      {
        type: 'call',
        reqId: 19,
        call: {
          method: 'saveProgress',
          input: {
            sourceId: 'src_1',
            itemKey: 'm:src_1:10',
            kind: 'episode',
            title: 'Northern Signal',
            subtitle: 'S1 E2',
            logo: 'https://img.example/poster.jpg',
            seriesKey: 's:src_1:1',
            season: 1,
            episode: 2,
            positionMs: 42_000,
            durationMs: 120_000,
            watched: false,
          },
        },
      },
      {
        type: 'call',
        reqId: 20,
        call: { method: 'setWatched', itemKey: 'm:src_1:10', watched: true, profileId: 'kids' },
      },
      {
        type: 'call',
        reqId: 21,
        call: { method: 'getProgress', itemKey: 'm:src_1:10' },
      },
      {
        type: 'call',
        reqId: 22,
        call: { method: 'listContinueWatching', limit: 24, profileId: 'default' },
      },
      {
        type: 'call',
        reqId: 23,
        call: { method: 'listProgressByKeys', itemKeys: ['m:src_1:10', 'm:src_1:11'] },
      },
      {
        type: 'call',
        reqId: 24,
        call: { method: 'clearProgress', itemKey: 'm:src_1:10' },
      },
      {
        type: 'call',
        reqId: 25,
        call: {
          method: 'toggleFavorite',
          input: {
            sourceId: 'src_1',
            itemKey: 'm:src_1:10',
            kind: 'movie',
            title: 'Orbital Nine',
            logo: null,
            year: 2025,
            rating: 8.2,
          },
        },
      },
      {
        type: 'call',
        reqId: 25,
        call: {
          method: 'setFavorite',
          input: {
            sourceId: 'src_1',
            itemKey: 'm:src_1:10',
            kind: 'movie',
            title: 'Orbital Nine',
            logo: null,
            year: 2025,
            rating: 8.2,
          },
          active: true,
        },
      },
      {
        type: 'call',
        reqId: 25,
        call: {
          method: 'setFavorite',
          input: {
            sourceId: 'src_1',
            itemKey: 'm:src_1:10',
            kind: 'movie',
            title: 'Orbital Nine',
          },
          active: false,
        },
      },
      {
        type: 'call',
        reqId: 26,
        call: { method: 'listFavorites', limit: 50 },
      },
      {
        type: 'call',
        reqId: 27,
        call: { method: 'listFavoriteKeys', profileId: 'default' },
      },
      {
        type: 'call',
        reqId: 28,
        call: {
          method: 'saveProgress',
          input: {
            sourceId: 'src_1',
            itemKey: 'm:src_1:12',
            kind: 'episode',
            title: 'Dirty\tProvider\r\nTitle',
            subtitle: 'S0\tE0',
            season: 0,
            episode: 0,
            positionMs: 0,
            durationMs: 1000,
          },
        },
      },
      {
        type: 'call',
        reqId: 29,
        call: {
          method: 'toggleFavorite',
          input: {
            sourceId: 'src_1',
            itemKey: 'm:src_1:12',
            kind: 'movie',
            title: 'Tab\tTitle\r',
          },
        },
      },
      { type: 'call', reqId: 30, call: { method: 'importGuide', id: 'src_1' } },
      {
        type: 'call',
        reqId: 31,
        call: {
          method: 'nowNext',
          channelKeys: ['x:src_1:live:1', 'x:src_1:live:2'],
          nowMs: 1_700_000_000_000,
        },
      },
      { type: 'call', reqId: 32, call: { method: 'nowNext', channelKeys: [], nowMs: 0 } },
      {
        type: 'call',
        reqId: 33,
        call: {
          method: 'epgWindow',
          channelKeys: ['x:src_1:live:1'],
          fromMs: 1_700_000_000_000,
          toMs: 1_700_010_800_000,
        },
      },
      { type: 'call', reqId: 34, call: { method: 'channelByNumber', num: 0 } },
      { type: 'call', reqId: 35, call: { method: 'channelByNumber', num: 101, sourceId: 'src_1' } },
      { type: 'call', reqId: 36, call: { method: 'channelByNumber', num: 4.1, sourceId: 'src_1' } },
      { type: 'cancel', reqId: 6 },
    ];
    for (const msg of valid) {
      expect(isCatalogClientMessage(msg)).toBe(true);
    }
  });

  it('rejects malformed envelopes, control characters in headers or mid-URL, and bad args', () => {
    const invalid: unknown[] = [
      null,
      42,
      { type: 'unknown', reqId: 1 },
      { type: 'cancel', reqId: 0 },
      { type: 'call', reqId: -1, call: { method: 'ping' } },
      { type: 'call', reqId: 1, call: null },
      { type: 'call', reqId: 1, call: { method: 'dropTable' } },
      { type: 'call', reqId: 1, call: { method: 'removeSource', id: 'x'.repeat(300) } },
      { type: 'call', reqId: 1, call: { method: 'importSource', id: 'src_1', batchSize: 0 } },
      { type: 'call', reqId: 1, call: { method: 'importSource', id: 'src_1', maxBodyBytes: -5 } },
      { type: 'call', reqId: 1, call: { method: 'importSource', id: 'src_1', progress: 'yes' } },
      { type: 'call', reqId: 1, call: { method: 'categories', sourceId: 'src_1', kind: 'vod' } },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'items', categoryId: 'a|live|1', offset: Number.NaN, limit: 10 },
      },
      { type: 'call', reqId: 1, call: { method: 'seasons', seriesId: 1.5 } },
      { type: 'call', reqId: 1, call: { method: 'itemDetail', itemKey: '' } },
      { type: 'call', reqId: 1, call: { method: 'itemDetail', itemKey: 'bad\nkey' } },
      { type: 'call', reqId: 1, call: { method: 'itemDetail', itemKey: 123 } },
      { type: 'call', reqId: 1, call: { method: 'itemDetail', itemKey: 'k'.repeat(1025) } },
      { type: 'call', reqId: 1, call: { method: 'search', query: 123 } },
      { type: 'call', reqId: 1, call: { method: 'search', query: 'q'.repeat(257) } },
      { type: 'call', reqId: 1, call: { method: 'search', query: 'bad\nquery' } },
      { type: 'call', reqId: 1, call: { method: 'search', query: 'ok', opts: null } },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'search', query: 'ok', opts: { scope: 'vod' } },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'search', query: 'ok', opts: { limit: 61 } },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'search', query: 'ok', opts: { limit: -1 } },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'search', query: 'ok', opts: { limit: 1.5 } },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'search', query: 'ok', opts: { sourceId: '' } },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'search', query: 'ok', opts: { sourceId: 'bad\nsrc' } },
      },
      { type: 'call', reqId: 1, call: { method: 'episodes', seriesId: 1, season: 1.2 } },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'addSourceFromLink',
          input: { name: 'Injected', url: 'http://127.0.0.1:7879/a\r\nb.m3u' },
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'addSource',
          input: {
            kind: 'xtream',
            name: 'Main',
            server: 'http://127.0.0.1:7879',
            username: 'u',
            password: 'p',
            transport: { userAgent: 'bad\r\nheader' },
          },
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'addSource',
          input: {
            kind: 'xtream',
            name: 'Main',
            server: 'http://127.0.0.1:7879',
            username: 'u',
            password: 'p',
            transport: { xtreamFormat: 'mp4' },
          },
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'addSource',
          input: { kind: 'other', name: 'x' },
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'addSourceFromLink',
          input: { name: 'x', url: 123 },
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'saveProgress',
          input: {
            sourceId: 'src_1',
            itemKey: 'k1',
            kind: 'vod',
            title: 'Bad Kind',
            positionMs: 1000,
            durationMs: 2000,
          },
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'saveProgress',
          input: {
            sourceId: 'src_1',
            itemKey: 'k1',
            kind: 'movie',
            title: 'Negative Pos',
            positionMs: -1,
            durationMs: 2000,
          },
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'saveProgress',
          input: JSON.parse(
            '{"__proto__":{"polluted":true},"sourceId":"s1","itemKey":"k1","kind":"movie","title":"T","positionMs":0,"durationMs":0}',
          ),
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'setWatched', itemKey: 'k1', watched: 'yes' },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'getProgress', itemKey: '' },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'listContinueWatching', limit: 101 },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'listContinueWatching', limit: -1 },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'listProgressByKeys',
          itemKeys: Array.from({ length: 201 }, (_, i) => `k${i}`),
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'listProgressByKeys', itemKeys: ['ok', ''] },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'clearProgress', itemKey: 'bad\nkey' },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'toggleFavorite',
          input: { sourceId: 's1', itemKey: 'k1', kind: 'movie', title: 'T', rating: Number.NaN },
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'setFavorite',
          input: { sourceId: 's1', itemKey: 'k1', kind: 'movie', title: 'T' },
          active: 'yes',
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'setFavorite',
          input: { sourceId: 's1', itemKey: 'k1', kind: 'movie', title: 'T', rating: Number.NaN },
          active: true,
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'listFavorites', limit: 1.5 },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'listFavoriteKeys', profileId: '' },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'saveProgress',
          input: {
            sourceId: 'src_1',
            itemKey: 'k1',
            kind: 'episode',
            title: 'Neg Season',
            season: -1,
            positionMs: 1000,
            durationMs: 2000,
          },
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'saveProgress',
          input: {
            sourceId: 'src_1',
            itemKey: 'k1',
            kind: 'episode',
            title: 'Neg Episode',
            episode: -2,
            positionMs: 1000,
            durationMs: 2000,
          },
        },
      },
      { type: 'call', reqId: 1, call: { method: 'importGuide', id: '' } },
      { type: 'call', reqId: 1, call: { method: 'importGuide', id: 'bad\nsrc' } },
      { type: 'call', reqId: 1, call: { method: 'importGuide', id: 's'.repeat(257) } },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'nowNext',
          channelKeys: Array.from({ length: 61 }, (_, i) => `x:s1:live:${i}`),
          nowMs: 1000,
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'nowNext', channelKeys: ['bad\nkey'], nowMs: 1000 },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'nowNext', channelKeys: ['x:s1:live:1'], nowMs: -1 },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'nowNext', channelKeys: ['x:s1:live:1'], nowMs: Number.NaN },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'epgWindow',
          channelKeys: Array.from({ length: 41 }, (_, i) => `x:s1:live:${i}`),
          fromMs: 1000,
          toMs: 2000,
        },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'epgWindow', channelKeys: [''], fromMs: 1000, toMs: 2000 },
      },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'epgWindow', channelKeys: ['x:s1:live:1'], fromMs: -1, toMs: 2000 },
      },
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'epgWindow',
          channelKeys: ['x:s1:live:1'],
          fromMs: 1000,
          toMs: Number.POSITIVE_INFINITY,
        },
      },
      { type: 'call', reqId: 1, call: { method: 'channelByNumber', num: -1 } },
      { type: 'call', reqId: 1, call: { method: 'channelByNumber', num: Number.NaN } },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'channelByNumber', num: Number.POSITIVE_INFINITY },
      },
      { type: 'call', reqId: 1, call: { method: 'channelByNumber', num: 101, sourceId: '' } },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'channelByNumber', num: 101, sourceId: 'bad\nsrc' },
      },
    ];
    for (const msg of invalid) {
      expect(isCatalogClientMessage(msg)).toBe(false);
    }
  });
});

describe('isCatalogWorkerMessage', () => {
  it('validates result, fault and progress worker messages', () => {
    expect(isCatalogWorkerMessage({ type: 'result', reqId: 1, value: [] })).toBe(true);
    expect(
      isCatalogWorkerMessage({
        type: 'fault',
        reqId: 2,
        error: { category: 'storage', code: 'worker-exited' },
      }),
    ).toBe(true);
    expect(
      isCatalogWorkerMessage({
        type: 'progress',
        reqId: 3,
        progress: { phase: 'live', done: 5000, total: 25000 },
      }),
    ).toBe(true);

    for (const bad of [
      null,
      { type: 'result', reqId: 0, value: null },
      { type: 'result', reqId: 1 },
      { type: 'fault', reqId: 1, error: { category: 'bogus', code: 'x' } },
      { type: 'fault', reqId: 1, error: { category: 'storage', code: '' } },
      { type: 'progress', reqId: 1, progress: { phase: 'unknown', done: 0 } },
      { type: 'progress', reqId: 1, progress: { phase: 'live', done: -1 } },
      { type: 'progress', reqId: 1, progress: { phase: 'live', done: 1, total: -2 } },
    ]) {
      expect(isCatalogWorkerMessage(bad)).toBe(false);
    }
  });
});

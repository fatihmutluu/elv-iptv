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
      { type: 'call', reqId: 10, call: { method: 'seasons', seriesId: 12 } },
      { type: 'call', reqId: 11, call: { method: 'episodes', seriesId: 12, season: 1 } },
      { type: 'call', reqId: 12, call: { method: 'resolveStream', itemKey: 'x:src_1:live:1001' } },
      { type: 'cancel', reqId: 6 },
    ];
    for (const msg of valid) {
      expect(isCatalogClientMessage(msg)).toBe(true);
    }
  });

  it('rejects malformed envelopes, unsafe source ids, control characters in headers, and bad args', () => {
    const invalid: unknown[] = [
      null,
      42,
      { type: 'unknown', reqId: 1 },
      { type: 'cancel', reqId: 0 },
      { type: 'call', reqId: -1, call: { method: 'ping' } },
      { type: 'call', reqId: 1, call: null },
      { type: 'call', reqId: 1, call: { method: 'dropTable' } },
      { type: 'call', reqId: 1, call: { method: 'removeSource', id: '../bad' } },
      { type: 'call', reqId: 1, call: { method: 'removeSource', id: '' } },
      { type: 'call', reqId: 1, call: { method: 'importSource', id: 'src_1', batchSize: 0 } },
      { type: 'call', reqId: 1, call: { method: 'importSource', id: 'src_1', maxBodyBytes: -5 } },
      { type: 'call', reqId: 1, call: { method: 'importSource', id: 'src_1', progress: 'yes' } },
      { type: 'call', reqId: 1, call: { method: 'categories', sourceId: 'src_1', kind: 'vod' } },
      { type: 'call', reqId: 1, call: { method: 'items', categoryId: '', offset: 0, limit: 10 } },
      {
        type: 'call',
        reqId: 1,
        call: { method: 'items', categoryId: 'a|live|1', offset: Number.NaN, limit: 10 },
      },
      { type: 'call', reqId: 1, call: { method: 'seasons', seriesId: 0 } },
      { type: 'call', reqId: 1, call: { method: 'episodes', seriesId: 1, season: 1.2 } },
      { type: 'call', reqId: 1, call: { method: 'resolveStream', itemKey: '' } },
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

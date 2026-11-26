import { EventEmitter } from 'node:events';
import type { CatalogService } from '@elv/data';
import { describe, expect, it, vi } from 'vitest';
import {
  type CatalogIpcRendererLike,
  createCatalogBridge,
  type PreloadClientPortLike,
} from '../preload/catalog-bridge.ts';
import { executeUserStateRpcCall } from '../utility/catalog-worker-user-state.ts';
import { CATALOG_CHANNELS, isCatalogClientMessage } from './catalog-ipc.ts';

describe('Desktop Catalog IPC — ratings & extraSeriesKeys', () => {
  it('validates setRating, getRating, listRatings, listRatingMap and rejects Live TV or malformed payloads', () => {
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 1,
        call: {
          method: 'setRating',
          input: {
            sourceId: 's1',
            itemKey: 's1:movie:1',
            kind: 'movie',
            title: 'Dune',
            logo: 'https://cdn.example/dune.jpg',
            year: 2021,
            rating: 8.3,
          },
          value: 'like',
        },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 2,
        call: {
          method: 'setRating',
          input: { sourceId: 's1', itemKey: 's1:series:2', kind: 'series', title: 'Dark' },
          value: null,
        },
      }),
    ).toBe(true);

    // Rejects Live TV
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 3,
        call: {
          method: 'setRating',
          input: { sourceId: 's1', itemKey: 's1:live:1', kind: 'live', title: 'News' },
          value: 'like',
        },
      }),
    ).toBe(false);

    // Rejects invalid rating value
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 4,
        call: {
          method: 'setRating',
          input: { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: 'Dune' },
          value: 'super',
        },
      }),
    ).toBe(false);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 5,
        call: { method: 'getRating', itemKey: 's1:movie:1', profileId: 'default' },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 6,
        call: {
          method: 'listRatings',
          opts: { value: 'dislike', limit: 25, profileId: 'default', parentalUnlocked: true },
        },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 7,
        call: { method: 'listRatings', opts: { limit: 999 } },
      }),
    ).toBe(false);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 8,
        call: { method: 'listRatingMap', profileId: 'default' },
      }),
    ).toBe(true);
  });

  it('validates extraSeriesKeys on refreshMyListNewEpisodes options', () => {
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 10,
        call: {
          method: 'refreshMyListNewEpisodes',
          profileId: 'default',
          opts: {
            cooldownMs: 60_000,
            maxSeries: 10,
            extraSeriesKeys: ['s1:series:1', 's1:series:2'],
          },
        },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 11,
        call: {
          method: 'refreshMyListNewEpisodes',
          profileId: 'default',
          opts: { extraSeriesKeys: ['bad\u0000key'] },
        },
      }),
    ).toBe(false);
  });

  it('dispatches rating RPCs through worker user-state, preload bridge, and desktop catalog wrapper', async () => {
    const service = {
      setRating: vi.fn(async () => ({ ok: true as const, value: 'like' as const })),
      getRating: vi.fn(async () => 'like' as const),
      listRatings: vi.fn(async () => []),
      listRatingMap: vi.fn(async () => ({ 's1:movie:1': 'like' as const })),
    } as unknown as CatalogService;

    const r1 = await executeUserStateRpcCall(
      service,
      {
        method: 'setRating',
        input: { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: '  Dune\u0000 ' },
        value: 'like',
      },
      (s) => s.replaceAll('\u0000', '').trim(),
    );
    expect(r1).toEqual({ ok: true, value: 'like' });
    expect(service.setRating).toHaveBeenCalledWith(
      { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: 'Dune' },
      'like',
    );
    expect(
      await executeUserStateRpcCall(
        service,
        { method: 'getRating', itemKey: 's1:movie:1', profileId: 'default' },
        (s) => s,
      ),
    ).toBe('like');
    expect(
      await executeUserStateRpcCall(
        service,
        { method: 'listRatings', opts: { value: 'like', limit: 10 } },
        (s) => s,
      ),
    ).toEqual([]);
    expect(
      await executeUserStateRpcCall(
        service,
        { method: 'listRatingMap', profileId: 'default' },
        (s) => s,
      ),
    ).toEqual({ 's1:movie:1': 'like' });

    // Preload bridge round-trip + notifyOnOk on setRating
    const emitter = new EventEmitter();
    let onMessage: ((ev: { readonly data: unknown }) => void) | undefined;
    const posted: unknown[] = [];
    const fakePort: PreloadClientPortLike = {
      postMessage: (msg) => {
        posted.push(msg);
        const m = msg as { reqId: number; call: { method: string } };
        const value =
          m.call.method === 'ping'
            ? { ok: true, value: undefined }
            : m.call.method === 'setRating'
              ? { ok: true, value: 'like' }
              : m.call.method === 'getRating'
                ? 'like'
                : m.call.method === 'listRatingMap'
                  ? { 's1:movie:1': 'like' }
                  : [];
        queueMicrotask(() => onMessage?.({ data: { type: 'result', reqId: m.reqId, value } }));
      },
      start: () => undefined,
      close: () => undefined,
      addEventListener: (_type, listener) => {
        onMessage = listener;
      },
      removeEventListener: () => undefined,
    };
    const ipc: CatalogIpcRendererLike = {
      send(channel, ...args) {
        if (channel === CATALOG_CHANNELS.connect) {
          const { connectId } = args[0] as { connectId: number };
          queueMicrotask(() => {
            emitter.emit(CATALOG_CHANNELS.port, { ports: [fakePort] }, { connectId });
          });
        }
      },
      on(channel, listener) {
        emitter.on(channel, listener);
      },
      removeListener(channel, listener) {
        emitter.off(channel, listener);
      },
    };
    const bridge = createCatalogBridge(ipc);
    const changed = vi.fn();
    bridge.onChanged(changed);
    expect((await bridge.open()).ok).toBe(true);

    expect(
      await bridge.setRating?.(
        { sourceId: 's1', itemKey: 's1:movie:1', kind: 'movie', title: 'Dune' },
        'like',
      ),
    ).toEqual({ ok: true, value: 'like' });
    expect(changed).toHaveBeenCalledTimes(1);
    expect(await bridge.getRating?.('s1:movie:1')).toBe('like');
    expect(await bridge.listRatings?.({ value: 'like' })).toEqual([]);
    expect(await bridge.listRatingMap?.('default')).toEqual({ 's1:movie:1': 'like' });
    expect(posted.length).toBe(5);
    await bridge.close();
  });
});

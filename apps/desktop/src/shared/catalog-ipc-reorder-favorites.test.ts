import { describe, expect, it, vi } from 'vitest';
import { createCatalogBridge, type PreloadClientPortLike } from '../preload/catalog-bridge.ts';
import { CATALOG_CHANNELS, isCatalogClientMessage } from './catalog-ipc.ts';
import { isListWatchedOptions, isOrderedFavoriteKeys } from './catalog-ipc-guards.ts';

describe('reorderFavorites Desktop Catalog IPC', () => {
  it('validates ordered favorite keys strictly with isOrderedFavoriteKeys and isCatalogClientMessage', () => {
    expect(isOrderedFavoriteKeys([])).toBe(true);
    expect(isOrderedFavoriteKeys(['x:s1:live:1', 'x:s1:live:2'])).toBe(true);
    expect(isOrderedFavoriteKeys('not-array')).toBe(false);
    expect(isOrderedFavoriteKeys([''])).toBe(false);
    expect(isOrderedFavoriteKeys(['   '])).toBe(false);
    expect(isOrderedFavoriteKeys(['bad\nkey'])).toBe(false);
    expect(isOrderedFavoriteKeys(['a'.repeat(257)])).toBe(false);
    expect(isOrderedFavoriteKeys(Array.from({ length: 251 }, (_, i) => `k:${i}`))).toBe(false);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 1,
        call: { method: 'reorderFavorites', orderedItemKeys: ['k:1', 'k:2'], profileId: 'kids' },
      }),
    ).toBe(true);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 1,
        call: { method: 'reorderFavorites', orderedItemKeys: ['k:1'], profileId: '../bad' },
      }),
    ).toBe(false);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 1,
        call: { method: 'reorderFavorites', orderedItemKeys: [''] },
      }),
    ).toBe(false);
  });

  it('forwards reorderFavorites through preload createCatalogBridge', async () => {
    const sentMessages: unknown[] = [];
    let portListener:
      | ((event: { ports?: readonly PreloadClientPortLike[] }, ...args: unknown[]) => void)
      | undefined;
    let onPortMessage: ((ev: { readonly data: unknown }) => void) | undefined;

    const fakePort: PreloadClientPortLike = {
      addEventListener: (_type: 'message', listener: (ev: { readonly data: unknown }) => void) => {
        onPortMessage = listener;
      },
      removeEventListener: vi.fn(),
      postMessage: (msg) => {
        sentMessages.push(msg);
        if (msg.type === 'call') {
          onPortMessage?.({
            data: { type: 'result', reqId: msg.reqId, value: { ok: true, value: undefined } },
          });
        }
      },
      start: vi.fn(),
      close: vi.fn(),
    };

    const bridge = createCatalogBridge({
      send: (channel, msg) => {
        if (channel === CATALOG_CHANNELS.connect) {
          portListener?.({ ports: [fakePort] }, msg);
        }
      },
      on: (channel, listener) => {
        if (channel === CATALOG_CHANNELS.port) {
          portListener = listener;
        }
      },
      removeListener: vi.fn(),
    });

    const res = await bridge.reorderFavorites?.(['x:s1:live:2', 'x:s1:live:1'], 'kids');
    expect(res).toEqual({ ok: true, value: undefined });
    expect(sentMessages).toEqual([
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'reorderFavorites',
          orderedItemKeys: ['x:s1:live:2', 'x:s1:live:1'],
          profileId: 'kids',
        },
      },
    ]);
  });

  it('validates listWatched options strictly and forwards through preload createCatalogBridge', async () => {
    expect(isListWatchedOptions({})).toBe(true);
    expect(isListWatchedOptions({ kind: 'movie' })).toBe(true);
    expect(isListWatchedOptions({ kind: 'series', parentalUnlocked: true })).toBe(true);
    expect(isListWatchedOptions({ kind: 'live' })).toBe(false);
    expect(isListWatchedOptions({ kind: 'episode' })).toBe(false);
    expect(isListWatchedOptions({ parentalUnlocked: 'yes' })).toBe(false);
    expect(isListWatchedOptions({ extra: 1 })).toBe(false);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 2,
        call: {
          method: 'listWatched',
          limit: 50,
          profileId: 'kids',
          opts: { kind: 'movie', parentalUnlocked: false },
        },
      }),
    ).toBe(true);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 2,
        call: { method: 'listWatched', limit: 999 },
      }),
    ).toBe(false);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 2,
        call: { method: 'listWatched', opts: { kind: 'live' } },
      }),
    ).toBe(false);

    const sentMessages: unknown[] = [];
    let portListener:
      | ((event: { ports?: readonly PreloadClientPortLike[] }, ...args: unknown[]) => void)
      | undefined;
    let onPortMessage: ((ev: { readonly data: unknown }) => void) | undefined;

    const fakePort: PreloadClientPortLike = {
      addEventListener: (_type: 'message', listener: (ev: { readonly data: unknown }) => void) => {
        onPortMessage = listener;
      },
      removeEventListener: vi.fn(),
      postMessage: (msg) => {
        sentMessages.push(msg);
        if (msg.type === 'call') {
          onPortMessage?.({
            data: { type: 'result', reqId: msg.reqId, value: [] },
          });
        }
      },
      start: vi.fn(),
      close: vi.fn(),
    };

    const bridge = createCatalogBridge({
      send: (channel, msg) => {
        if (channel === CATALOG_CHANNELS.connect) {
          portListener?.({ ports: [fakePort] }, msg);
        }
      },
      on: (channel, listener) => {
        if (channel === CATALOG_CHANNELS.port) {
          portListener = listener;
        }
      },
      removeListener: vi.fn(),
    });

    const rows = await bridge.listWatched?.(25, 'kids', { kind: 'series', parentalUnlocked: true });
    expect(rows).toEqual([]);
    expect(sentMessages).toEqual([
      {
        type: 'call',
        reqId: 1,
        call: {
          method: 'listWatched',
          limit: 25,
          profileId: 'kids',
          opts: { kind: 'series', parentalUnlocked: true },
        },
      },
    ]);
  });
});

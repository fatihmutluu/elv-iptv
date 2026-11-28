import { EventEmitter } from 'node:events';
import type { CatalogService } from '@elv/data';
import { describe, expect, it, vi } from 'vitest';
import {
  type CatalogIpcRendererLike,
  createCatalogBridge,
  type PreloadClientPortLike,
} from '../preload/catalog-bridge.ts';
import { executeWaveR3OpsRpcCall } from '../utility/catalog-worker-wave-r3-ops.ts';
import { CATALOG_CHANNELS, isCatalogClientMessage } from './catalog-ipc.ts';

describe('Desktop Catalog IPC — Wave R3 recommendation dismissals', () => {
  it('validates dismissRecommendation, restoreRecommendation, and listDismissedRecommendationKeys and rejects malformed payloads', () => {
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 1,
        call: {
          method: 'dismissRecommendation',
          itemKey: 's1:movie:1',
          kind: 'movie',
          profileId: 'default',
        },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 2,
        call: {
          method: 'dismissRecommendation',
          itemKey: 's1:series:1',
          kind: 'series',
        },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 3,
        call: { method: 'restoreRecommendation', itemKey: 's1:movie:1', profileId: 'kids_1' },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 4,
        call: { method: 'listDismissedRecommendationKeys', profileId: 'default' },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 5,
        call: { method: 'listDismissedRecommendationKeys' },
      }),
    ).toBe(true);

    // Rejects invalid kind, blank/control-char keys, bad profileId, or unexpected fields
    const invalidCalls: unknown[] = [
      { method: 'dismissRecommendation', itemKey: 's1:live:1', kind: 'live' },
      { method: 'dismissRecommendation', itemKey: 's1:ep:1', kind: 'episode' },
      { method: 'dismissRecommendation', itemKey: '', kind: 'movie' },
      { method: 'dismissRecommendation', itemKey: '   ', kind: 'movie' },
      { method: 'dismissRecommendation', itemKey: 'bad\u0000key', kind: 'movie' },
      { method: 'dismissRecommendation', itemKey: 'x'.repeat(1025), kind: 'movie' },
      {
        method: 'dismissRecommendation',
        itemKey: 's1:movie:1',
        kind: 'movie',
        profileId: 'bad/id',
      },
      { method: 'dismissRecommendation', itemKey: 's1:movie:1', kind: 'movie', extra: 1 },
      { method: 'restoreRecommendation', itemKey: '   ' },
      { method: 'restoreRecommendation', itemKey: 'bad\u0007key' },
      { method: 'restoreRecommendation', itemKey: 's1:movie:1', profileId: '../etc' },
      { method: 'restoreRecommendation', itemKey: 's1:movie:1', extra: true },
      { method: 'listDismissedRecommendationKeys', profileId: 'bad profile' },
      { method: 'listDismissedRecommendationKeys', extra: 'nope' },
    ];
    invalidCalls.forEach((call, idx) => {
      expect(
        isCatalogClientMessage({ type: 'call', reqId: 100 + idx, call }),
        `expected rejection for ${JSON.stringify(call)}`,
      ).toBe(false);
    });
  });

  it('dispatches Wave R3 RPCs cleanly in worker ops and preload bridge without firing onChanged', async () => {
    const dismissRecommendation = vi.fn(async () => undefined);
    const restoreRecommendation = vi.fn(async () => undefined);
    const listDismissedRecommendationKeys = vi.fn(async () => ['s1:movie:1']);
    const service = {
      dismissRecommendation,
      restoreRecommendation,
      listDismissedRecommendationKeys,
    } as unknown as CatalogService;

    await executeWaveR3OpsRpcCall(service, {
      method: 'dismissRecommendation',
      itemKey: 's1:movie:1',
      kind: 'movie',
      profileId: 'p1',
    });
    expect(dismissRecommendation).toHaveBeenCalledWith('s1:movie:1', 'movie', 'p1');

    await executeWaveR3OpsRpcCall(service, {
      method: 'restoreRecommendation',
      itemKey: 's1:movie:1',
      profileId: 'p1',
    });
    expect(restoreRecommendation).toHaveBeenCalledWith('s1:movie:1', 'p1');

    expect(
      await executeWaveR3OpsRpcCall(service, {
        method: 'listDismissedRecommendationKeys',
        profileId: 'p1',
      }),
    ).toEqual(['s1:movie:1']);
    expect(listDismissedRecommendationKeys).toHaveBeenCalledWith('p1');

    // Safe fallback when underlying service omits optional Wave R3 methods
    const minimalService = {} as CatalogService;
    await expect(
      executeWaveR3OpsRpcCall(minimalService, {
        method: 'dismissRecommendation',
        itemKey: 's1:movie:1',
        kind: 'movie',
      }),
    ).resolves.toBeUndefined();
    await expect(
      executeWaveR3OpsRpcCall(minimalService, {
        method: 'restoreRecommendation',
        itemKey: 's1:movie:1',
      }),
    ).resolves.toBeUndefined();
    await expect(
      executeWaveR3OpsRpcCall(minimalService, { method: 'listDismissedRecommendationKeys' }),
    ).resolves.toEqual([]);

    // Preload bridge round-trip (must NOT emit onChanged)
    const emitter = new EventEmitter();
    let onMessage: ((ev: { readonly data: unknown }) => void) | undefined;
    const sent: unknown[] = [];
    const fakePort: PreloadClientPortLike = {
      postMessage: (msg) => {
        sent.push(msg);
        const m = msg as { reqId: number; call: { method: string } };
        const value =
          m.call.method === 'ping'
            ? { ok: true, value: undefined }
            : m.call.method === 'listDismissedRecommendationKeys'
              ? ['s1:movie:1']
              : undefined;
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

    await bridge.dismissRecommendation?.('s1:movie:1', 'movie', 'default');
    expect(await bridge.listDismissedRecommendationKeys?.('default')).toEqual(['s1:movie:1']);
    await bridge.restoreRecommendation?.('s1:movie:1', 'default');
    expect(changed).not.toHaveBeenCalled();
    expect(sent).toHaveLength(4);

    await bridge.close();
  });
});

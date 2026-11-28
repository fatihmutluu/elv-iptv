import type { ServerResponse } from 'node:http';
import type { CatalogService } from '@elv/data';
import type { SqlDriver } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createWorkbenchRemoteCatalog } from '../../renderer/src/workbench/remote-catalog.ts';
import { ALLOWED_RPC_METHODS, dispatchWorkbenchRpc } from './workbench-rpc.ts';

describe('Workbench RPC & remote catalog — Wave R3 recommendation dismissals', () => {
  it('exposes and validates dismissRecommendation, restoreRecommendation, and listDismissedRecommendationKeys', async () => {
    expect(ALLOWED_RPC_METHODS.has('dismissRecommendation')).toBe(true);
    expect(ALLOWED_RPC_METHODS.has('restoreRecommendation')).toBe(true);
    expect(ALLOWED_RPC_METHODS.has('listDismissedRecommendationKeys')).toBe(true);

    const dismissRecommendation = vi.fn(async () => undefined);
    const restoreRecommendation = vi.fn(async () => undefined);
    const listDismissedRecommendationKeys = vi.fn(async () => ['s1:movie:1']);
    const ctx = {
      db: {} as SqlDriver,
      service: {
        dismissRecommendation,
        restoreRecommendation,
        listDismissedRecommendationKeys,
      } as unknown as CatalogService,
      activeImports: new Set<AbortController>(),
      checkpointWal: async () => undefined,
    };
    const res = {} as ServerResponse;

    await expect(
      dispatchWorkbenchRpc(ctx, 'dismissRecommendation', ['s1:movie:1', 'live'], res),
    ).rejects.toThrow();
    await expect(
      dispatchWorkbenchRpc(ctx, 'dismissRecommendation', ['  ', 'movie'], res),
    ).rejects.toThrow();
    await expect(
      dispatchWorkbenchRpc(ctx, 'dismissRecommendation', ['\ts1:movie:1\n', 'movie'], res),
    ).rejects.toThrow();
    await expect(
      dispatchWorkbenchRpc(ctx, 'dismissRecommendation', ['\ns1:movie:1', 'movie'], res),
    ).rejects.toThrow();
    await expect(dispatchWorkbenchRpc(ctx, 'restoreRecommendation', ['  '], res)).rejects.toThrow();
    await expect(
      dispatchWorkbenchRpc(ctx, 'restoreRecommendation', ['\ts1:movie:1'], res),
    ).rejects.toThrow();
    await expect(
      dispatchWorkbenchRpc(ctx, 'restoreRecommendation', ['s1:movie:1\n'], res),
    ).rejects.toThrow();
    await expect(
      dispatchWorkbenchRpc(ctx, 'restoreRecommendation', ['s1:movie:1', 123], res),
    ).rejects.toThrow();
    expect(dismissRecommendation).not.toHaveBeenCalled();
    expect(restoreRecommendation).not.toHaveBeenCalled();

    await dispatchWorkbenchRpc(ctx, 'dismissRecommendation', ['s1:movie:1', 'movie', 'kids'], res);
    expect(dismissRecommendation).toHaveBeenCalledWith('s1:movie:1', 'movie', 'kids');

    expect(
      await dispatchWorkbenchRpc(ctx, 'listDismissedRecommendationKeys', ['kids'], res),
    ).toEqual(['s1:movie:1']);
    expect(listDismissedRecommendationKeys).toHaveBeenCalledWith('kids');

    await dispatchWorkbenchRpc(ctx, 'restoreRecommendation', ['s1:movie:1', 'kids'], res);
    expect(restoreRecommendation).toHaveBeenCalledWith('s1:movie:1', 'kids');

    const calls: Array<{ method: string; args: unknown[] }> = [];
    const fetchMock = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body ?? '{}')) as { method: string; args: unknown[] };
      calls.push(parsed);
      return new Response(
        JSON.stringify({
          value: parsed.method === 'listDismissedRecommendationKeys' ? ['s1:movie:1'] : undefined,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const remote = createWorkbenchRemoteCatalog(
      { baseUrl: 'http://127.0.0.1:8082', token: 'tok' },
      fetchMock,
    );
    await remote.dismissRecommendation?.('s1:movie:1', 'movie', 'kids');
    expect(await remote.listDismissedRecommendationKeys?.('kids')).toEqual(['s1:movie:1']);
    await remote.restoreRecommendation?.('s1:movie:1', 'kids');
    expect(calls).toEqual([
      { method: 'dismissRecommendation', args: ['s1:movie:1', 'movie', 'kids'] },
      { method: 'listDismissedRecommendationKeys', args: ['kids'] },
      { method: 'restoreRecommendation', args: ['s1:movie:1', 'kids'] },
    ]);
  });
});

import type { ServerResponse } from 'node:http';
import type { CatalogService } from '@elv/data';
import { ok, type SqlDriver } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { dispatchWorkbenchRpc } from './workbench-rpc.ts';

describe('dispatchWorkbenchRpc — setSeasonWatched & setSeriesWatched validation', () => {
  it('rejects missing, negative, non-numeric, or non-integer season values without coercing to 0', async () => {
    const setSeasonWatched = vi.fn(async () => ok(2));
    const setSeriesWatched = vi.fn(async () => ok(5));
    const ctx = {
      db: {} as SqlDriver,
      service: { setSeasonWatched, setSeriesWatched } as unknown as CatalogService,
      activeImports: new Set<AbortController>(),
      checkpointWal: async () => undefined,
    };
    const res = {} as ServerResponse;

    for (const badSeason of [undefined, null, '1', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = await dispatchWorkbenchRpc(
        ctx,
        'setSeasonWatched',
        ['x:s1:series:1', badSeason, true],
        res,
      );
      expect(out).toMatchObject({ ok: false, error: { category: 'source-format' } });
    }
    expect(setSeasonWatched).not.toHaveBeenCalled();

    expect(
      await dispatchWorkbenchRpc(ctx, 'setSeasonWatched', ['x:s1:series:1', 0, true, 'kids'], res),
    ).toEqual(ok(2));
    expect(setSeasonWatched).toHaveBeenCalledWith('x:s1:series:1', 0, true, 'kids');

    expect(
      await dispatchWorkbenchRpc(ctx, 'setSeriesWatched', ['x:s1:series:1', false, 'default'], res),
    ).toEqual(ok(5));
    expect(setSeriesWatched).toHaveBeenCalledWith('x:s1:series:1', false, 'default');
  });
});

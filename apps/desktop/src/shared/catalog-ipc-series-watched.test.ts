import type { CatalogService } from '@elv/data';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { executeUserStateRpcCall } from '../utility/catalog-worker-user-state.ts';
import { isCatalogClientMessage } from './catalog-ipc.ts';

describe('Desktop Catalog IPC — setSeasonWatched & setSeriesWatched', () => {
  it('validates well-formed setSeasonWatched and setSeriesWatched calls', () => {
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 1,
        call: {
          method: 'setSeasonWatched',
          seriesKey: 'x:s1:series:42',
          season: 1,
          watched: true,
        },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 2,
        call: {
          method: 'setSeasonWatched',
          seriesKey: 'x:s1:series:42',
          season: 0,
          watched: false,
          profileId: 'kids',
        },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 3,
        call: {
          method: 'setSeriesWatched',
          seriesKey: 'x:s1:series:42',
          watched: true,
        },
      }),
    ).toBe(true);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 4,
        call: {
          method: 'setSeriesWatched',
          seriesKey: 'x:s1:series:42',
          watched: false,
          profileId: 'default',
        },
      }),
    ).toBe(true);
  });

  it('rejects malformed keys, negative/non-integer seasons, invalid watched flags, bad profileIds, and extra fields', () => {
    const invalidCalls: unknown[] = [
      { method: 'setSeasonWatched', seriesKey: '', season: 1, watched: true },
      { method: 'setSeasonWatched', seriesKey: '   ', season: 1, watched: true },
      { method: 'setSeasonWatched', seriesKey: 'x:s1:series:1\n', season: 1, watched: true },
      { method: 'setSeasonWatched', seriesKey: 'x'.repeat(1_025), season: 1, watched: true },
      { method: 'setSeasonWatched', seriesKey: 'x:s1:series:1', season: -1, watched: true },
      { method: 'setSeasonWatched', seriesKey: 'x:s1:series:1', season: 1.5, watched: true },
      { method: 'setSeasonWatched', seriesKey: 'x:s1:series:1', season: Number.NaN, watched: true },
      { method: 'setSeasonWatched', seriesKey: 'x:s1:series:1', season: '1', watched: true },
      { method: 'setSeasonWatched', seriesKey: 'x:s1:series:1', season: 1, watched: 1 },
      {
        method: 'setSeasonWatched',
        seriesKey: 'x:s1:series:1',
        season: 1,
        watched: true,
        profileId: '../bad',
      },
      {
        method: 'setSeasonWatched',
        seriesKey: 'x:s1:series:1',
        season: 1,
        watched: true,
        extra: 'nope',
      },
      { method: 'setSeriesWatched', seriesKey: '', watched: true },
      { method: 'setSeriesWatched', seriesKey: '   ', watched: true },
      { method: 'setSeriesWatched', seriesKey: 'x:s1:series:1\u0007', watched: true },
      { method: 'setSeriesWatched', seriesKey: 'x:s1:series:1', watched: 'yes' },
      {
        method: 'setSeriesWatched',
        seriesKey: 'x:s1:series:1',
        watched: true,
        profileId: 'bad profile!',
      },
      {
        method: 'setSeriesWatched',
        seriesKey: 'x:s1:series:1',
        watched: true,
        extra: true,
      },
    ];

    for (let i = 0; i < invalidCalls.length; i += 1) {
      expect(
        isCatalogClientMessage({ type: 'call', reqId: i + 10, call: invalidCalls[i] }),
        `expected invalid call #${i} to be rejected`,
      ).toBe(false);
    }
  });

  it('dispatches setSeasonWatched and setSeriesWatched through executeUserStateRpcCall and handles unsupported fallback', async () => {
    const setSeasonWatched = vi.fn(async () => ok(4));
    const setSeriesWatched = vi.fn(async () => ok(10));
    const service = { setSeasonWatched, setSeriesWatched } as unknown as CatalogService;

    expect(
      await executeUserStateRpcCall(
        service,
        {
          method: 'setSeasonWatched',
          seriesKey: 'x:s1:series:9',
          season: 2,
          watched: true,
          profileId: 'default',
        },
        (s) => s,
      ),
    ).toEqual(ok(4));
    expect(setSeasonWatched).toHaveBeenCalledWith('x:s1:series:9', 2, true, 'default');

    expect(
      await executeUserStateRpcCall(
        service,
        {
          method: 'setSeriesWatched',
          seriesKey: 'x:s1:series:9',
          watched: false,
          profileId: 'kids',
        },
        (s) => s,
      ),
    ).toEqual(ok(10));
    expect(setSeriesWatched).toHaveBeenCalledWith('x:s1:series:9', false, 'kids');

    const minimal = {} as CatalogService;
    expect(
      await executeUserStateRpcCall(
        minimal,
        { method: 'setSeasonWatched', seriesKey: 'x:s1:series:9', season: 1, watched: true },
        (s) => s,
      ),
    ).toMatchObject({ ok: false, error: { category: 'storage', code: 'unsupported' } });
    expect(
      await executeUserStateRpcCall(
        minimal,
        { method: 'setSeriesWatched', seriesKey: 'x:s1:series:9', watched: true },
        (s) => s,
      ),
    ).toMatchObject({ ok: false, error: { category: 'storage', code: 'unsupported' } });
  });
});

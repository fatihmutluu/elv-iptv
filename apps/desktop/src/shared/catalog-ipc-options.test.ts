import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

describe('ListItemsOptions and allSourcesItems RPC validation (#125)', () => {
  it('validates optional ListItemsOptions on items and allSourcesItems calls', () => {
    const valid: unknown[] = [
      {
        type: 'call',
        reqId: 101,
        call: {
          method: 'items',
          categoryId: 'src-1|movie|10',
          offset: 0,
          limit: 18,
          opts: { sortBy: 'alpha', excludeWatched: true, profileId: 'default' },
        },
      },
      {
        type: 'call',
        reqId: 102,
        call: {
          method: 'allSourcesItems',
          kind: 'series',
          offset: 0,
          limit: 24,
          sourceIds: ['src-1', 'src-2'],
          opts: { sortBy: 'default', excludeWatched: false },
        },
      },
      {
        type: 'call',
        reqId: 103,
        call: { method: 'allSourcesItems', kind: 'movie', offset: 10, limit: 20 },
      },
    ];
    for (const msg of valid) {
      expect(isCatalogClientMessage(msg)).toBe(true);
    }

    const invalid: unknown[] = [
      {
        type: 'call',
        reqId: 201,
        call: {
          method: 'items',
          categoryId: 'src-1|movie|10',
          offset: 0,
          limit: 18,
          opts: { sortBy: 'bogus' },
        },
      },
      {
        type: 'call',
        reqId: 202,
        call: {
          method: 'items',
          categoryId: 'src-1|movie|10',
          offset: 0,
          limit: 18,
          opts: { excludeWatched: 'yes' },
        },
      },
      {
        type: 'call',
        reqId: 203,
        call: {
          method: 'allSourcesItems',
          kind: 'episode',
          offset: 0,
          limit: 10,
        },
      },
      {
        type: 'call',
        reqId: 204,
        call: {
          method: 'allSourcesItems',
          kind: 'movie',
          offset: 0,
          limit: 10,
          sourceIds: [''],
        },
      },
    ];
    for (const msg of invalid) {
      expect(isCatalogClientMessage(msg)).toBe(false);
    }
  });

  it('validates listSeriesUnplayedCounts RPC calls (#409)', () => {
    const valid: unknown[] = [
      {
        type: 'call',
        reqId: 301,
        call: { method: 'listSeriesUnplayedCounts', seriesKeys: [] },
      },
      {
        type: 'call',
        reqId: 302,
        call: {
          method: 'listSeriesUnplayedCounts',
          seriesKeys: ['src-1|series|10', 'src-1|series|11'],
          profileId: 'default',
        },
      },
      {
        type: 'call',
        reqId: 303,
        call: {
          method: 'listSeriesUnplayedCounts',
          seriesKeys: Array.from({ length: 200 }, (_, i) => `s:${i}`),
        },
      },
    ];
    for (const msg of valid) {
      expect(isCatalogClientMessage(msg)).toBe(true);
    }

    const invalid: unknown[] = [
      {
        type: 'call',
        reqId: 401,
        call: {
          method: 'listSeriesUnplayedCounts',
          seriesKeys: Array.from({ length: 201 }, (_, i) => `s:${i}`),
        },
      },
      {
        type: 'call',
        reqId: 402,
        call: { method: 'listSeriesUnplayedCounts', seriesKeys: [''] },
      },
      {
        type: 'call',
        reqId: 403,
        call: { method: 'listSeriesUnplayedCounts', seriesKeys: ['bad\nkey'] },
      },
      {
        type: 'call',
        reqId: 404,
        call: { method: 'listSeriesUnplayedCounts', seriesKeys: 'not-array' },
      },
      {
        type: 'call',
        reqId: 405,
        call: { method: 'listSeriesUnplayedCounts', seriesKeys: ['s:1'], profileId: '' },
      },
    ];
    for (const msg of invalid) {
      expect(isCatalogClientMessage(msg)).toBe(false);
    }
  });
});

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
});

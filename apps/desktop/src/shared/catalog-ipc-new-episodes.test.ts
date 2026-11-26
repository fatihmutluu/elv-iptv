import { describe, expect, it } from 'vitest';
import { isCatalogClientMessage } from './catalog-ipc.ts';

describe('catalog-ipc my-list-new-episodes (#502)', () => {
  it('validates listMyListNewEpisodes, dismissMyListNewEpisode, and refreshMyListNewEpisodes bounds', () => {
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 1,
        call: {
          method: 'listMyListNewEpisodes',
          limit: 24,
          profileId: 'default',
          opts: { parentalUnlocked: true },
        },
      }),
    ).toBe(true);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 2,
        call: { method: 'listMyListNewEpisodes', limit: 101 },
      }),
    ).toBe(false);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 3,
        call: { method: 'listMyListNewEpisodes', limit: -1 },
      }),
    ).toBe(false);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 4,
        call: { method: 'dismissMyListNewEpisode', episodeKey: 'm:s1:ep:1', profileId: 'default' },
      }),
    ).toBe(true);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 5,
        call: { method: 'dismissMyListNewEpisode', episodeKey: '' },
      }),
    ).toBe(false);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 6,
        call: { method: 'dismissMyListNewEpisode', episodeKey: 'bad\x00key' },
      }),
    ).toBe(false);

    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 7,
        call: {
          method: 'refreshMyListNewEpisodes',
          profileId: 'default',
          opts: { cooldownMs: 60_000, maxSeries: 10, force: true },
        },
      }),
    ).toBe(true);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 8,
        call: {
          method: 'refreshMyListNewEpisodes',
          opts: { maxSeries: 51 },
        },
      }),
    ).toBe(false);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 9,
        call: {
          method: 'refreshMyListNewEpisodes',
          opts: { cooldownMs: -1 },
        },
      }),
    ).toBe(false);
    expect(
      isCatalogClientMessage({
        type: 'call',
        reqId: 10,
        call: {
          method: 'refreshMyListNewEpisodes',
          opts: { extra: 1 } as never,
        },
      }),
    ).toBe(false);
  });
});

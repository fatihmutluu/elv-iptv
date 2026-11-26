import type { SourceRow } from '@elv/data';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import type { CatalogBridge } from '../../../src/shared/catalog-ipc.ts';
import { createDesktopCatalogFromBridge } from './desktop-catalog.ts';

function makeMinimalBridge(overrides: Partial<CatalogBridge> = {}): CatalogBridge {
  return {
    open: vi.fn(async () => ok(undefined)),
    addSource: vi.fn(),
    addSourceFromLink: vi.fn(),
    removeSource: vi.fn(),
    startImport: vi.fn(),
    cancelImport: vi.fn(),
    importGuide: vi.fn(),
    listSources: vi.fn(async () => []),
    categories: vi.fn(async () => []),
    items: vi.fn(async () => []),
    itemDetail: vi.fn(async () => null),
    search: vi.fn(async () => ({ live: [], epg: [], movies: [], series: [], episodes: [] })),
    nowNext: vi.fn(async () => []),
    epgWindow: vi.fn(async () => ({})),
    channelByNumber: vi.fn(async () => null),
    seasons: vi.fn(async () => ok([])),
    episodes: vi.fn(async () => []),
    queryNextEpisode: vi.fn(async () => null),
    resolveStream: vi.fn(),
    saveProgress: vi.fn(),
    setWatched: vi.fn(),
    getProgress: vi.fn(async () => null),
    listContinueWatching: vi.fn(async () => []),
    listProgressByKeys: vi.fn(async () => []),
    clearProgress: vi.fn(),
    toggleFavorite: vi.fn(),
    setFavorite: vi.fn(),
    listFavorites: vi.fn(async () => []),
    listFavoriteKeys: vi.fn(async () => []),
    onChanged: vi.fn(() => () => undefined),
    onDisconnected: vi.fn(() => () => undefined),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('createDesktopCatalogFromBridge Wave P7 (#505, #506)', () => {
  it('forwards renameSource (sanitizing control chars) and setSourceExcludedProfiles, with unsupported fallback on legacy bridge', async () => {
    const sampleRow: SourceRow = {
      id: 'src_1',
      kind: 'm3u',
      name: 'Living Room',
      createdAt: 100,
      needsImport: false,
      excludedProfileIds: ['p_kids'],
    };
    const renameSource = vi.fn(async () => ok(sampleRow));
    const setSourceExcludedProfiles = vi.fn(async () => ok(sampleRow));
    const catalog = createDesktopCatalogFromBridge(
      makeMinimalBridge({ renameSource, setSourceExcludedProfiles }),
    );

    const renamed = await catalog.renameSource?.('src_1', 'Living\tRoom\n');
    expect(renamed).toEqual(ok(sampleRow));
    expect(renameSource).toHaveBeenCalledWith('src_1', 'Living Room');

    const excluded = await catalog.setSourceExcludedProfiles?.('src_1', ['p_kids']);
    expect(excluded).toEqual(ok(sampleRow));
    expect(setSourceExcludedProfiles).toHaveBeenCalledWith('src_1', ['p_kids']);

    const legacy = createDesktopCatalogFromBridge(makeMinimalBridge());
    expect((await legacy.renameSource?.('src_1', 'Valid'))?.ok).toBe(false);
    expect((await legacy.setSourceExcludedProfiles?.('src_1', ['p_kids']))?.ok).toBe(false);
  });
});

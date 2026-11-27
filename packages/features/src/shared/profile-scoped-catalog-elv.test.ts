import type { CatalogService } from '@elv/data';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createProfileScopedCatalog } from './profile-scoped-catalog';

describe('createProfileScopedCatalog Wave E2 ELV discovery forwarding (#512)', () => {
  it('wraps and forwards all 8 Wave E2 ELV discovery methods with merged excludedSourceIds, profileId, and parentalUnlocked', async () => {
    const allowedItem = {
      id: 1,
      key: 'x:s1:movie:1',
      sourceId: 's1',
      providerId: '1',
      kind: 'movie' as const,
      name: 'Allowed Film',
      logo: null,
      num: null,
      year: 2024,
      rating: 8.2,
    };
    const blockedItem = {
      ...allowedItem,
      id: 2,
      key: 'x:s2:movie:2',
      sourceId: 's2',
      name: 'Blocked Source Film',
    };
    const fakeEnrichment = {
      itemKey: allowedItem.key,
      sourceId: 's1',
      mediaType: 'movie' as const,
      imdbId: 'tt1375666',
      confidence: 1,
      manualLock: false,
      title: null,
    };

    const listElvImdbGenres = vi.fn(async () => [
      { id: 'imdb-genre:Sci-Fi', name: 'Sci-Fi', count: 3 },
    ]);
    const listElvItemsByImdbGenre = vi.fn(async () => [allowedItem, blockedItem]);
    const getElvRecommendations = vi.fn(async () => [
      { item: allowedItem, enrichment: fakeEnrichment, score: 0.9, reason: 'trending' as const },
      { item: blockedItem, enrichment: fakeEnrichment, score: 0.8, reason: 'top_picks' as const },
    ]);
    const refreshElvFeeds = vi.fn(async () => true);
    const listElvFranchiseItems = vi.fn(async () => [
      {
        item: allowedItem,
        enrichment: fakeEnrichment,
        franchiseKey: 'f1',
        franchiseName: 'Saga',
        franchiseOrder: 1,
      },
      {
        item: blockedItem,
        enrichment: fakeEnrichment,
        franchiseKey: 'f1',
        franchiseName: 'Saga',
        franchiseOrder: 2,
      },
    ]);
    const listElvPersonLibraryItems = vi.fn(async () => [
      { item: allowedItem, enrichment: fakeEnrichment, role: 'cast' as const, character: 'Lead' },
      { item: blockedItem, enrichment: fakeEnrichment, role: 'cast' as const, character: 'Extra' },
    ]);
    const searchElvMatchCandidates = vi.fn(async () => []);
    const applyElvFixMatch = vi.fn(async () => fakeEnrichment);

    const base = {
      addSource: vi.fn(),
      addSourceFromLink: vi.fn(),
      removeSource: vi.fn(),
      importSource: vi.fn(),
      listSources: vi.fn(async () => [
        { id: 's1', kind: 'xtream', name: 'S1', createdAt: 1, needsImport: false },
        {
          id: 's2',
          kind: 'xtream',
          name: 'S2',
          createdAt: 1,
          needsImport: false,
          excludedProfileIds: ['kids-1'],
        },
      ]),
      categories: vi.fn(async () => []),
      items: vi.fn(async () => []),
      seasons: vi.fn(async () => ok([])),
      episodes: vi.fn(async () => []),
      resolveStream: vi.fn(),
      close: vi.fn(async () => undefined),
      listElvImdbGenres,
      listElvItemsByImdbGenre,
      getElvRecommendations,
      refreshElvFeeds,
      listElvFranchiseItems,
      listElvPersonLibraryItems,
      searchElvMatchCandidates,
      applyElvFixMatch,
    } as unknown as CatalogService;

    const scoped = createProfileScopedCatalog(base, () => ({
      profileId: 'kids-1',
      parentalUnlocked: false,
    }));

    const genres = await scoped.listElvImdbGenres?.('movie', { excludedSourceIds: ['s3'] });
    expect(genres).toHaveLength(1);
    expect(listElvImdbGenres).toHaveBeenCalledWith('movie', {
      profileId: 'kids-1',
      parentalUnlocked: false,
      excludedSourceIds: ['s3', 's2'],
    });

    const genreItems = await scoped.listElvItemsByImdbGenre?.('movie', 'imdb-genre:Sci-Fi', {
      offset: 0,
      limit: 20,
      excludedSourceIds: ['s3'],
    });
    expect(genreItems?.map((i) => i.key)).toEqual([allowedItem.key]);
    expect(listElvItemsByImdbGenre).toHaveBeenCalledWith('movie', 'imdb-genre:Sci-Fi', {
      offset: 0,
      limit: 20,
      profileId: 'kids-1',
      parentalUnlocked: false,
      excludedSourceIds: ['s3', 's2'],
    });

    const recs = await scoped.getElvRecommendations?.({
      profile: 'home',
      limit: 24,
      excludedSourceIds: ['s3'],
    });
    expect(recs?.map((r) => r.item.key)).toEqual([allowedItem.key]);
    expect(getElvRecommendations).toHaveBeenCalledWith({
      profile: 'home',
      limit: 24,
      profileId: 'kids-1',
      parentalUnlocked: false,
      excludedSourceIds: ['s3', 's2'],
    });

    expect(await scoped.refreshElvFeeds?.({ force: true })).toBe(true);
    expect(refreshElvFeeds).toHaveBeenCalledWith({ force: true });

    const franchise = await scoped.listElvFranchiseItems?.('tt1375666');
    expect(franchise?.map((f) => f.item.key)).toEqual([allowedItem.key]);
    expect(listElvFranchiseItems).toHaveBeenCalledWith('tt1375666', {
      profileId: 'kids-1',
      parentalUnlocked: false,
      excludedSourceIds: ['s2'],
    });

    const personItems = await scoped.listElvPersonLibraryItems?.(
      { name: 'Actor One' },
      { limit: 10 },
    );
    expect(personItems?.map((p) => p.item.key)).toEqual([allowedItem.key]);
    expect(listElvPersonLibraryItems).toHaveBeenCalledWith(
      { name: 'Actor One' },
      {
        limit: 10,
        profileId: 'kids-1',
        parentalUnlocked: false,
        excludedSourceIds: ['s2'],
      },
    );

    await scoped.searchElvMatchCandidates?.('Inception', 'movie');
    expect(searchElvMatchCandidates).toHaveBeenCalledWith('Inception', 'movie');

    const fixed = await scoped.applyElvFixMatch?.({
      itemKey: allowedItem.key,
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt1375666',
      lang: 'en',
    });
    expect(fixed).toEqual(fakeEnrichment);
    expect(applyElvFixMatch).toHaveBeenCalledWith({
      itemKey: allowedItem.key,
      sourceId: 's1',
      mediaType: 'movie',
      imdbId: 'tt1375666',
      lang: 'en',
    });
  });
});

import { type CatalogService, createCatalogService, openCatalog } from '@elv/data';
import { countingScheduler, memorySecrets, testDb } from '@elv/data/testing';
import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createProfileScopedCatalog } from './profile-scoped-catalog';

describe('per-profile source visibility filtering (Wave P7)', () => {
  it('forwards renameSource and setSourceExcludedProfiles and hides excluded sources from browse/search/user-state/resolveStream while keeping listSources unfiltered', async () => {
    const handle = testDb();
    await openCatalog(handle.db);
    let urlToggle = 0;
    const base = createCatalogService({
      db: handle.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        async get(url) {
          urlToggle += 1;
          const isSourceA = url.includes('source-a');
          const m3u = isSourceA
            ? [
                '#EXTM3U',
                '#EXTINF:-1 group-title="News A",Channel A',
                'http://127.0.0.1/a-live.ts',
                '#EXTINF:-1 group-title="Movies A",Movie A (2024)',
                'http://127.0.0.1/a-movie.mp4',
              ].join('\n')
            : [
                '#EXTM3U',
                '#EXTINF:-1 group-title="Cartoons B",Channel B',
                'http://127.0.0.1/b-live.ts',
                '#EXTINF:-1 group-title="Family B",Movie B (2024)',
                'http://127.0.0.1/b-movie.mp4',
              ].join('\n');
          const bytes = new TextEncoder().encode(m3u);
          return ok({
            status: 200,
            headers: {},
            body: {
              async *[Symbol.asyncIterator]() {
                yield bytes;
              },
            },
          });
        },
      },
      clock: () => 20_000 + urlToggle,
    });

    const addA = await base.addSourceFromLink({
      name: 'Source A',
      url: 'http://127.0.0.1/source-a.m3u',
    });
    const addB = await base.addSourceFromLink({
      name: 'Source B',
      url: 'http://127.0.0.1/source-b.m3u',
    });
    expect(addA.ok && addB.ok).toBe(true);
    if (!addA.ok || !addB.ok) return;
    await base.importSource(addA.value.id);
    await base.importSource(addB.value.id);

    const kids = await base.createProfile?.({ name: 'Kids', isKids: true, avatarToken: 'emerald' });
    expect(kids?.ok).toBe(true);
    if (!kids?.ok) return;
    const kidsId = kids.value.id;

    let scope: {
      profileId: string;
      parentalUnlocked: boolean;
      excludedSourceIds?: ReadonlySet<string>;
    } = { profileId: 'default', parentalUnlocked: false, excludedSourceIds: new Set() };
    const scoped = createProfileScopedCatalog(base, () => scope);

    // Rename Source A and exclude it from Kids profile through scoped catalog
    const renamed = await scoped.renameSource?.(addA.value.id, 'Adult News Feed');
    expect(renamed?.ok).toBe(true);
    const updatedExcl = await scoped.setSourceExcludedProfiles?.(addA.value.id, [kidsId]);
    expect(updatedExcl?.ok).toBe(true);

    // Settings -> Sources (listSources) ALWAYS returns ALL sources regardless of active profile
    const sourcesBefore = await scoped.listSources();
    expect(sourcesBefore.map((s) => s.name).sort()).toEqual(['Adult News Feed', 'Source B']);
    expect(sourcesBefore.find((s) => s.id === addA.value.id)?.excludedProfileIds).toEqual([kidsId]);

    // Capture a Channel A key while on Adult profile and favorite/watch it under Kids to verify filtering
    const catsA = await scoped.categories(addA.value.id, 'live');
    const itemsA = await scoped.items(catsA[0]?.id ?? '', 0, 10);
    const channelA = itemsA[0];
    expect(channelA?.name).toBe('Channel A');
    if (!channelA) return;

    // Switch to Kids profile (excludedSourceIds intentionally omitted to verify fallback lookup from listSources)
    scope = { profileId: kidsId, parentalUnlocked: false };

    await base.setFavorite?.(
      {
        sourceId: addA.value.id,
        itemKey: channelA.key,
        kind: 'live',
        title: channelA.name,
        profileId: kidsId,
      },
      true,
    );
    await base.saveProgress?.({
      sourceId: addA.value.id,
      itemKey: channelA.key,
      kind: 'live',
      title: channelA.name,
      positionMs: 1_000,
      durationMs: 10_000,
      watched: false,
      profileId: kidsId,
    });

    // listSources stays unfiltered so adult/settings can manage all sources
    expect((await scoped.listSources()).map((s) => s.id).sort()).toEqual(
      [addA.value.id, addB.value.id].sort(),
    );

    // Browse, search, favorites, continue watching, and stream resolution all hide Source A on Kids
    expect(await scoped.categories(addA.value.id, 'live')).toEqual([]);
    expect(await scoped.items(catsA[0]?.id ?? '', 0, 10)).toEqual([]);
    expect((await scoped.allSourcesItems?.('live', 0, 20))?.map((i) => i.name)).toEqual([
      'Channel B',
    ]);
    expect((await scoped.search?.('Channel'))?.live.map((i) => i.name)).toEqual(['Channel B']);
    expect(await scoped.listFavoriteKeys?.()).toEqual([]);
    expect(await scoped.listFavorites?.(20)).toEqual([]);
    expect(await scoped.listContinueWatching?.(20)).toEqual([]);

    const blockedStream = await scoped.resolveStream(channelA.key);
    expect(blockedStream.ok).toBe(false);

    // Source B remains fully visible and playable on Kids
    const catsB = await scoped.categories(addB.value.id, 'live');
    expect(catsB.map((c) => c.name)).toEqual(['Cartoons B']);
    const itemsB = await scoped.items(catsB[0]?.id ?? '', 0, 10);
    expect(itemsB.map((i) => i.name)).toEqual(['Channel B']);
    const okStream = await scoped.resolveStream(itemsB[0]?.key ?? '');
    expect(okStream.ok).toBe(true);

    // Switching back to Adult (default) profile restores Source A completely
    scope = { profileId: 'default', parentalUnlocked: false };
    expect((await scoped.allSourcesItems?.('live', 0, 20))?.map((i) => i.name).sort()).toEqual([
      'Channel A',
      'Channel B',
    ]);
    expect((await scoped.resolveStream(channelA.key)).ok).toBe(true);

    await scoped.close();
    handle.close();
  });

  it('over-fetches before filtering excluded sources so hidden rows never starve allowed rows in user-state lists', async () => {
    const excludedRows = [
      { sourceId: 'src-hidden', itemKey: 'm:src-hidden:movie:1', key: 'm:src-hidden:movie:1' },
      { sourceId: 'src-hidden', itemKey: 'm:src-hidden:movie:2', key: 'm:src-hidden:movie:2' },
      { sourceId: 'src-hidden', itemKey: 'm:src-hidden:movie:3', key: 'm:src-hidden:movie:3' },
    ];
    const allowedRows = [
      { sourceId: 'src-ok', itemKey: 'm:src-ok:movie:1', key: 'm:src-ok:movie:1' },
      { sourceId: 'src-ok', itemKey: 'm:src-ok:movie:2', key: 'm:src-ok:movie:2' },
      { sourceId: 'src-ok', itemKey: 'm:src-ok:movie:3', key: 'm:src-ok:movie:3' },
    ];
    const allRows = [...excludedRows, ...allowedRows];
    const sliceByLimit = (limit?: number) => allRows.slice(0, limit ?? 50);

    const listContinueWatching = vi.fn(async (limit?: number) => sliceByLimit(limit));
    const listWatched = vi.fn(async (limit?: number) => sliceByLimit(limit));
    const listFavorites = vi.fn(async (limit?: number) => sliceByLimit(limit));
    const listMyListNewEpisodes = vi.fn(async (limit?: number) => sliceByLimit(limit));
    const listRecentChannels = vi.fn(async (limit?: number) => sliceByLimit(limit));

    const base = {
      addSource: vi.fn(),
      addSourceFromLink: vi.fn(),
      removeSource: vi.fn(),
      importSource: vi.fn(),
      listSources: vi.fn(async () => [
        { id: 'src-hidden', excludedProfileIds: ['kids'] },
        { id: 'src-ok', excludedProfileIds: [] },
      ]),
      categories: vi.fn(async () => []),
      items: vi.fn(async () => []),
      seasons: vi.fn(async () => ok([])),
      episodes: vi.fn(async () => []),
      resolveStream: vi.fn(),
      listContinueWatching,
      listWatched,
      listFavorites,
      listMyListNewEpisodes,
      listRecentChannels,
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const scoped = createProfileScopedCatalog(base, () => ({
      profileId: 'kids',
      parentalUnlocked: false,
      excludedSourceIds: new Set(['src-hidden']),
    }));

    const cw = await scoped.listContinueWatching?.(2);
    const watched = await scoped.listWatched?.(2);
    const favs = await scoped.listFavorites?.(2);
    const eps = await scoped.listMyListNewEpisodes?.(2);
    const recents = await scoped.listRecentChannels?.(2);

    for (const result of [cw, watched, favs, eps, recents]) {
      expect(result?.map((r) => r.sourceId)).toEqual(['src-ok', 'src-ok']);
      expect(result).toHaveLength(2);
    }
    expect(listContinueWatching.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(200);
    expect(listWatched.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(200);
    expect(listFavorites.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(200);
    expect(listMyListNewEpisodes.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(200);
    expect(listRecentChannels.mock.calls[0]?.[0]).toBeGreaterThanOrEqual(200);
  });

  it('excludes hidden sources in cross-source alphabetIndex and prevents excluded sources from shadowing channelByNumber', async () => {
    const alphabetIndex = vi.fn(async (input: { sourceId?: string }) => {
      if (input.sourceId === 'src-a') {
        return [
          { letter: 'A', offset: 0, count: 4 },
          { letter: 'B', offset: 4, count: 2 },
        ];
      }
      if (input.sourceId === 'src-b') {
        return [
          { letter: 'A', offset: 0, count: 1 },
          { letter: 'C', offset: 1, count: 3 },
        ];
      }
      if (input.sourceId === 'src-c') {
        return [{ letter: 'B', offset: 0, count: 2 }];
      }
      // Cross-source unfiltered call includes excluded src-a!
      return [
        { letter: 'A', offset: 0, count: 5 },
        { letter: 'B', offset: 5, count: 4 },
        { letter: 'C', offset: 9, count: 3 },
      ];
    });

    const channelByNumber = vi.fn(async (num: number, sourceId?: string) => {
      if (num !== 5) return null;
      if (sourceId === undefined || sourceId === 'src-a') {
        return {
          id: 1,
          key: 'm:src-a:live:5',
          kind: 'live' as const,
          sourceId: 'src-a',
          providerId: '5',
          name: 'Excluded Ch 5',
          logo: null,
          rating: null,
          year: null,
          num: 5,
        };
      }
      if (sourceId === 'src-b') {
        return {
          id: 2,
          key: 'm:src-b:live:5',
          kind: 'live' as const,
          sourceId: 'src-b',
          providerId: '5',
          name: 'Allowed Ch 5',
          logo: null,
          rating: null,
          year: null,
          num: 5,
        };
      }
      return null;
    });

    const base = {
      addSource: vi.fn(),
      addSourceFromLink: vi.fn(),
      removeSource: vi.fn(),
      importSource: vi.fn(),
      listSources: vi.fn(async () => [
        { id: 'src-a', excludedProfileIds: ['kids'] },
        { id: 'src-b', excludedProfileIds: [] },
        { id: 'src-c', excludedProfileIds: [] },
      ]),
      categories: vi.fn(async () => []),
      items: vi.fn(async () => []),
      seasons: vi.fn(async () => ok([])),
      episodes: vi.fn(async () => []),
      resolveStream: vi.fn(),
      alphabetIndex,
      channelByNumber,
      close: vi.fn(async () => undefined),
    } as unknown as CatalogService;

    const scoped = createProfileScopedCatalog(base, () => ({
      profileId: 'kids',
      parentalUnlocked: false,
      excludedSourceIds: new Set(['src-a']),
    }));

    // Cross-source alphabetIndex merges ONLY allowed sources (src-b + src-c) with exact cumulative offsets
    const buckets = await scoped.alphabetIndex?.({ kind: 'live' });
    expect(buckets).toEqual([
      { letter: 'A', offset: 0, count: 1 },
      { letter: 'B', offset: 1, count: 2 },
      { letter: 'C', offset: 3, count: 3 },
    ]);

    // channelByNumber without sourceId falls through to allowed src-b instead of being shadowed by excluded src-a
    const ch = await scoped.channelByNumber?.(5);
    expect(ch?.sourceId).toBe('src-b');
    expect(ch?.name).toBe('Allowed Ch 5');
  });
});

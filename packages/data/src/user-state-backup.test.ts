import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import {
  type FavoriteRow,
  getWatchProgress,
  listFavorites,
  saveWatchProgress,
  toggleFavorite,
  type WatchProgressRow,
} from './user-state';
import {
  DEFAULT_USER_DATA_MAX_BYTES,
  decodeUserDataSnapshot,
  encodeUserDataSnapshot,
  ICLOUD_USER_DATA_MAX_BYTES,
  reconcileUserData,
  sanitizeBackupLogo,
  saveUserDataSnapshot,
  type UserDataProfileEntry,
  type UserDataStore,
} from './user-state-backup';

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function memoryUserDataStore(
  maxBytes?: number,
): UserDataStore & { value: string | undefined; writes: number } {
  const store = {
    value: undefined as string | undefined,
    writes: 0,
    ...(maxBytes === undefined ? {} : { maxBytes }),
    read(): string | undefined {
      return store.value;
    },
    write(next: string): void {
      store.writes += 1;
      store.value = next;
    },
  };
  return store;
}

function makeFavorite(overrides: Partial<FavoriteRow> = {}): FavoriteRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey: 'm:src-1:1',
    kind: 'movie',
    title: 'Midnight Signal',
    logo: 'https://cdn.example.invalid/posters/1.jpg',
    year: 2024,
    rating: 8.2,
    addedAt: 10_000,
    ...overrides,
  };
}

function makeProgress(overrides: Partial<WatchProgressRow> = {}): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: 'src-1',
    itemKey: 'm:src-1:1',
    kind: 'movie',
    title: 'Midnight Signal',
    subtitle: null,
    logo: 'https://cdn.example.invalid/posters/1.jpg',
    seriesKey: null,
    season: null,
    episode: null,
    positionMs: 120_000,
    durationMs: 3_600_000,
    watched: false,
    updatedAt: 20_000,
    ...overrides,
  };
}

async function setupDb() {
  const handle = testDb();
  await openCatalog(handle.db);
  return handle;
}

describe('user-state-backup constants and credential hygiene (#79)', () => {
  it('exposes measured tvOS NSUserDefaults and iCloud KVS ceilings', () => {
    expect(DEFAULT_USER_DATA_MAX_BYTES).toBe(393_216);
    expect(ICLOUD_USER_DATA_MAX_BYTES).toBe(921_600);
  });

  it('keeps clean http(s) logo URLs and drops non-http(s), userinfo, template, and auth-param URLs', () => {
    expect(sanitizeBackupLogo('https://cdn.example.invalid/art/p1.png?w=300&fmt=webp')).toBe(
      'https://cdn.example.invalid/art/p1.png?w=300&fmt=webp',
    );
    expect(sanitizeBackupLogo('http://img.example.invalid/ch.jpg')).toBe(
      'http://img.example.invalid/ch.jpg',
    );

    const unsafeLogos: readonly (string | null | undefined)[] = [
      null,
      undefined,
      '',
      '   ',
      'file:///var/mobile/poster.png',
      'javascript:alert(1)',
      'data:image/png;base64,AAAA',
      'ftp://files.example.invalid/a.png',
      '{{v:1}}/poster.png',
      'https://alice:secretval@cdn.example.invalid/a.png',
      'https://alice@cdn.example.invalid/a.png',
      'https://cdn.example.invalid/a.png?username=alice',
      'https://cdn.example.invalid/a.png?PASSWORD=demo',
      'https://cdn.example.invalid/a.png?token=abc',
      'https://cdn.example.invalid/a.png?auth=xyz',
      'https://cdn.example.invalid/a.png?key=123',
      'https://cdn.example.invalid/a.png?pass=123',
      'https://cdn.example.invalid/a.png?pwd=123',
      'https://cdn.example.invalid/a.png?w=200&Token=abc',
      'https://cdn.example.invalid/a.png\nX-Injected: 1',
      'not a url',
    ];
    for (const logo of unsafeLogos) {
      expect(sanitizeBackupLogo(logo), `expected null for ${String(logo)}`).toBeNull();
    }
  });
});

describe('encodeUserDataSnapshot and decodeUserDataSnapshot (#79)', () => {
  it('round-trips valid favorites, watch progress, and forward-compatible profiles while stripping unsafe logos', () => {
    const profiles: UserDataProfileEntry[] = [
      { id: 'default', name: 'Living Room', avatar: 'cinema', isKids: false, createdAt: 1_000 },
      {
        id: 'kids',
        name: 'Kids',
        avatar: 'https://alice:demo@cdn.example.invalid/a.png',
        isKids: true,
        createdAt: 2_000,
      },
    ];
    const favorites = [
      makeFavorite({
        itemKey: 'm:src-1:unsafe',
        logo: 'https://cdn.example.invalid/img.png?token=should-drop',
        addedAt: 5_000,
      }),
      makeFavorite({
        itemKey: 'l:src-1:ch1',
        kind: 'live',
        title: 'News HD',
        logo: 'https://cdn.example.invalid/ch1.png',
        year: null,
        rating: null,
        addedAt: 9_000,
      }),
    ];
    const progress = [
      makeProgress({
        itemKey: 'e:src-1:101',
        kind: 'episode',
        title: 'Pilot',
        subtitle: 'S1 E1',
        logo: 'https://demo:val@cdn.example.invalid/ep.png',
        seriesKey: 's:src-1:10',
        season: 1,
        episode: 1,
        positionMs: 420_000,
        durationMs: 2_700_000,
        watched: false,
        updatedAt: 50_000,
      }),
    ];

    const encoded = encodeUserDataSnapshot({ v: 1, favorites, progress, profiles });
    expect(encoded).not.toContain('should-drop');
    expect(encoded).not.toContain('alice:demo');
    expect(encoded).not.toContain('demo:val');

    const decoded = decodeUserDataSnapshot(encoded);
    expect(decoded.profiles).toEqual([
      { id: 'default', name: 'Living Room', avatar: 'cinema', isKids: false, createdAt: 1_000 },
      { id: 'kids', name: 'Kids', avatar: null, isKids: true, createdAt: 2_000 },
    ]);
    // Ordered newest addedAt DESC
    expect(decoded.favorites.map((f) => f.itemKey)).toEqual(['l:src-1:ch1', 'm:src-1:unsafe']);
    expect(decoded.favorites[1]?.logo).toBeNull();
    expect(decoded.progress).toHaveLength(1);
    expect(decoded.progress[0]?.logo).toBeNull();
    expect(decoded.progress[0]?.seriesKey).toBe('s:src-1:10');
  });

  it('deterministically evicts oldest watched progress -> oldest unwatched progress -> oldest favorites to fit maxBytes', () => {
    const profiles: UserDataProfileEntry[] = [{ id: 'default', name: 'Main', createdAt: 1_000 }];
    const favorites = Array.from({ length: 12 }, (_, idx) =>
      makeFavorite({
        itemKey: `m:src-1:fav-${idx}`,
        title: `Favorite Movie ${idx} ${'x'.repeat(30)}`,
        addedAt: 1_000 + idx * 100,
      }),
    );
    const progress = [
      // 6 watched rows (older & newer)
      ...Array.from({ length: 6 }, (_, idx) =>
        makeProgress({
          itemKey: `m:src-1:done-${idx}`,
          title: `Completed Film ${idx} ${'y'.repeat(30)}`,
          watched: true,
          updatedAt: 50_000 + idx * 100,
        }),
      ),
      // 6 unwatched in-progress rows (even with lower updatedAt than watched!)
      ...Array.from({ length: 6 }, (_, idx) =>
        makeProgress({
          itemKey: `m:src-1:active-${idx}`,
          title: `Active Film ${idx} ${'z'.repeat(30)}`,
          watched: false,
          updatedAt: 10_000 + idx * 100,
        }),
      ),
    ];

    // Budget enough for profiles + all favorites + some progress (must keep active before watched)
    const midBudget = 3_600;
    const midEncoded = encodeUserDataSnapshot({ v: 1, favorites, progress, profiles }, midBudget);
    expect(utf8Bytes(midEncoded)).toBeLessThanOrEqual(midBudget);
    const midDecoded = decodeUserDataSnapshot(midEncoded);
    expect(midDecoded.profiles).toHaveLength(1);
    expect(midDecoded.favorites).toHaveLength(favorites.length);
    // Every kept unwatched item precedes any watched item; newest active is preserved first
    expect(midDecoded.progress.length).toBeGreaterThan(0);
    expect(midDecoded.progress[0]?.itemKey).toBe('m:src-1:active-5');
    expect(midDecoded.progress.every((p) => !p.watched)).toBe(true);

    // Tighter budget drops all progress and keeps only newest favorites + profiles
    const tightBudget = 1_200;
    const tightEncoded = encodeUserDataSnapshot(
      { v: 1, favorites, progress, profiles },
      tightBudget,
    );
    expect(utf8Bytes(tightEncoded)).toBeLessThanOrEqual(tightBudget);
    const tightDecoded = decodeUserDataSnapshot(tightEncoded);
    expect(tightDecoded.profiles).toHaveLength(1);
    expect(tightDecoded.progress).toHaveLength(0);
    expect(tightDecoded.favorites.length).toBeGreaterThan(0);
    expect(tightDecoded.favorites.length).toBeLessThan(favorites.length);
    expect(tightDecoded.favorites[0]?.itemKey).toBe('m:src-1:fav-11');
  });

  it('skips oversized individual rows without starving normal rows, returns empty string for tiny budgets, and rejects unsafe avatar schemes (#79)', () => {
    expect(encodeUserDataSnapshot({ v: 1, favorites: [], progress: [] }, 0)).toBe('');
    expect(encodeUserDataSnapshot({ v: 1, favorites: [], progress: [] }, 34)).toBe('');
    expect(encodeUserDataSnapshot({ v: 1, favorites: [], progress: [] }, 35)).toBe('');
    expect(encodeUserDataSnapshot({ v: 1, favorites: [], progress: [] }, 36)).toBe(
      '{"v":1,"favorites":[],"progress":[]}',
    );

    // Oversized newest favorite + oversized newest progress row must be skipped while smaller rows survive
    const hugeFavorite = makeFavorite({
      itemKey: 'm:src-1:huge-fav',
      title: `Huge ${'A'.repeat(2_000)}`,
      addedAt: 99_999,
    });
    const normalFavorite = makeFavorite({
      itemKey: 'm:src-1:normal-fav',
      title: 'Normal Movie',
      addedAt: 10_000,
    });
    const hugeProgress = makeProgress({
      itemKey: 'm:src-1:huge-prog',
      title: `Huge ${'B'.repeat(2_000)}`,
      updatedAt: 99_999,
    });
    const normalProgress = makeProgress({
      itemKey: 'm:src-1:normal-prog',
      title: 'Normal Episode',
      updatedAt: 10_000,
    });
    const profiles: UserDataProfileEntry[] = [
      { id: 'p1', name: 'JS Avatar', avatar: 'javascript:alert(1)', createdAt: 100 },
      { id: 'p2', name: 'Data Avatar', avatar: 'data:text/html,<script>', createdAt: 200 },
      { id: 'p3', name: 'Template Avatar', avatar: '{{v:1}}', createdAt: 300 },
      { id: 'p4', name: 'Safe Avatar', avatar: 'cinema-icon', createdAt: 400 },
    ];

    const budget = 1_500;
    const encoded = encodeUserDataSnapshot(
      {
        v: 1,
        favorites: [hugeFavorite, normalFavorite],
        progress: [hugeProgress, normalProgress],
        profiles,
      },
      budget,
    );
    expect(utf8Bytes(encoded)).toBeLessThanOrEqual(budget);
    const decoded = decodeUserDataSnapshot(encoded);
    expect(decoded.favorites.map((f) => f.itemKey)).toEqual(['m:src-1:normal-fav']);
    expect(decoded.progress.map((p) => p.itemKey)).toEqual(['m:src-1:normal-prog']);
    expect(decoded.profiles.map((p) => p.avatar)).toEqual([null, null, null, 'cinema-icon']);
  });

  it('handles corrupt JSON, foreign versions, and invalid row entries safely', () => {
    expect(decodeUserDataSnapshot(undefined)).toEqual({
      favorites: [],
      progress: [],
      profiles: [],
    });
    expect(decodeUserDataSnapshot('')).toEqual({ favorites: [], progress: [], profiles: [] });
    expect(decodeUserDataSnapshot('{not-json')).toEqual({
      favorites: [],
      progress: [],
      profiles: [],
    });
    expect(decodeUserDataSnapshot('null')).toEqual({ favorites: [], progress: [], profiles: [] });
    expect(decodeUserDataSnapshot(JSON.stringify({ v: 99, favorites: [], progress: [] }))).toEqual({
      favorites: [],
      progress: [],
      profiles: [],
    });

    const mixed = JSON.stringify({
      v: 1,
      favorites: [
        { sourceId: 'bad id!', itemKey: 'm:1', kind: 'movie', title: 'X', addedAt: 10 },
        { sourceId: 'src-1', itemKey: '', kind: 'movie', title: 'X', addedAt: 10 },
        { sourceId: 'src-1', itemKey: 'm:src-1:badkind', kind: 'podcast', title: 'X', addedAt: 10 },
        {
          sourceId: 'src-1',
          itemKey: 'm:src-1:nan',
          kind: 'movie',
          title: 'X',
          addedAt: Number.NaN,
        },
        {
          profileId: '  ',
          sourceId: 'src-1',
          itemKey: 'm:src-1:good',
          kind: 'movie',
          title: 'Good Movie',
          logo: 'https://cdn.example.invalid/ok.png?password=leak',
          year: 2023.8,
          rating: 7.5,
          addedAt: 12345.6,
        },
      ],
      progress: [
        {
          sourceId: 'bad/id',
          itemKey: 'm:1',
          kind: 'movie',
          title: 'X',
          positionMs: 1,
          durationMs: 2,
          watched: false,
          updatedAt: 1,
        },
        {
          sourceId: 'src-1',
          itemKey: 'm:src-1:p1',
          kind: 'movie',
          title: 'Clamped',
          positionMs: -50,
          durationMs: 999.7,
          watched: false,
          updatedAt: 5000,
        },
      ],
      profiles: [
        { id: '', name: 'No ID', createdAt: 1 },
        { id: 'p1', name: 'Guest', isKids: false, createdAt: 3000 },
      ],
    });
    const decoded = decodeUserDataSnapshot(mixed);
    expect(decoded.favorites).toEqual([
      {
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'm:src-1:good',
        kind: 'movie',
        title: 'Good Movie',
        logo: null,
        year: 2023,
        rating: 7.5,
        addedAt: 12346,
      },
    ]);
    expect(decoded.progress).toEqual([
      {
        profileId: 'default',
        sourceId: 'src-1',
        itemKey: 'm:src-1:p1',
        kind: 'movie',
        title: 'Clamped',
        subtitle: null,
        logo: null,
        seriesKey: null,
        season: null,
        episode: null,
        positionMs: 0,
        durationMs: 1000,
        watched: false,
        updatedAt: 5000,
      },
    ]);
    expect(decoded.profiles).toEqual([
      { id: 'p1', name: 'Guest', avatar: null, isKids: false, createdAt: 3000 },
    ]);
  });
});

describe('saveUserDataSnapshot, reconcileUserData, and CatalogService mirroring (#79)', () => {
  it('restores favorites and watch progress cleanly after a simulated Library/Caches catalog.db purge', async () => {
    const store = memoryUserDataStore();
    const first = await setupDb();

    await toggleFavorite(
      first.db,
      {
        sourceId: 'src-1',
        itemKey: 'l:src-1:news',
        kind: 'live',
        title: 'World News',
        logo: 'https://cdn.example.invalid/news.png',
      },
      () => 1_000,
    );
    await saveWatchProgress(
      first.db,
      {
        sourceId: 'src-1',
        itemKey: 'm:src-1:42',
        kind: 'movie',
        title: 'Orbital Drift',
        logo: 'https://cdn.example.invalid/drift.jpg',
        positionMs: 600_000,
        durationMs: 5_400_000,
      },
      () => 2_000,
    );

    // Populated DB refreshes snapshot and restores 0 rows
    const refreshResult = await reconcileUserData(first.db, store);
    expect(refreshResult).toEqual({ favoritesRestored: 0, progressRestored: 0 });
    expect(store.value).toBeDefined();

    // Simulate tvOS Library/Caches purge: brand-new empty SQLite database
    const purged = await setupDb();
    const restored = await reconcileUserData(purged.db, store);
    expect(restored).toEqual({ favoritesRestored: 1, progressRestored: 1 });

    const favs = await listFavorites(purged.db);
    expect(favs).toHaveLength(1);
    expect(favs[0]?.itemKey).toBe('l:src-1:news');
    expect(favs[0]?.title).toBe('World News');

    const prog = await getWatchProgress(purged.db, 'm:src-1:42');
    expect(prog?.positionMs).toBe(600_000);
    expect(prog?.durationMs).toBe(5_400_000);
    expect(prog?.watched).toBe(false);
  });

  it('ignores store read/write failures gracefully without throwing', async () => {
    const { db } = await setupDb();
    const brokenStore: UserDataStore = {
      read() {
        throw new Error('kv read error');
      },
      write() {
        throw new Error('kv write error');
      },
    };
    await expect(saveUserDataSnapshot(db, brokenStore)).resolves.toBeUndefined();
    await expect(reconcileUserData(db, brokenStore)).resolves.toEqual({
      favoritesRestored: 0,
      progressRestored: 0,
    });
  });

  it('mirrors a <= 384 KiB local fallback snapshot when primary iCloud budget is 900 KiB (#79)', async () => {
    const { db } = await setupDb();
    // Insert enough rows to exceed 384 KiB while fitting well under 900 KiB (~440 KiB)
    const pad = 'X'.repeat(800);
    await db.transaction(async (tx) => {
      for (let i = 0; i < 450; i += 1) {
        await tx.run(
          'INSERT INTO favorites (profile_id, source_id, item_key, kind, title, logo, year, rating, added_at) VALUES (?, ?, ?, ?, ?, NULL, 2024, 8.0, ?)',
          ['default', 'src-1', `m:src-1:big-${i}`, 'movie', `Film ${i} ${pad}`, 10_000 + i],
        );
      }
    });

    let primaryVal = '';
    let localVal = '';
    const store: UserDataStore = {
      maxBytes: ICLOUD_USER_DATA_MAX_BYTES,
      read: () => primaryVal || undefined,
      write(v) {
        primaryVal = v;
      },
      writeLocalFallback(v) {
        localVal = v;
      },
    };

    await saveUserDataSnapshot(db, store);
    expect(utf8Bytes(primaryVal)).toBeGreaterThan(DEFAULT_USER_DATA_MAX_BYTES);
    expect(utf8Bytes(primaryVal)).toBeLessThanOrEqual(ICLOUD_USER_DATA_MAX_BYTES);
    expect(utf8Bytes(localVal)).toBeGreaterThan(0);
    expect(utf8Bytes(localVal)).toBeLessThanOrEqual(DEFAULT_USER_DATA_MAX_BYTES);
    expect(decodeUserDataSnapshot(primaryVal).favorites.length).toBe(450);
    expect(decodeUserDataSnapshot(localVal).favorites.length).toBeLessThan(450);
    expect(decodeUserDataSnapshot(localVal).favorites[0]?.itemKey).toBe('m:src-1:big-449');
  });

  it('mirrors user-state mutations from CatalogService (saveProgress, setWatched, clearProgress, toggleFavorite, setFavorite, removeSource)', async () => {
    const { db } = await setupDb();
    const store = memoryUserDataStore();
    let now = 10_000;
    const service = createCatalogService({
      db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        get: vi.fn(async () =>
          ok({
            status: 200,
            headers: {},
            finalUrl: 'https://example.invalid',
            body: (async function* () {})(),
          }),
        ),
      },
      clock: () => (now += 100),
      newId: () => 'src-1',
      userData: store,
    });

    await service.addSource({
      kind: 'm3u',
      name: 'Demo',
      playlistUrl: 'https://example.invalid/list.m3u',
    });

    await service.toggleFavorite?.({
      sourceId: 'src-1',
      itemKey: 'm:src-1:fav1',
      kind: 'movie',
      title: 'Starlight',
    });
    expect(decodeUserDataSnapshot(store.value).favorites.map((f) => f.itemKey)).toEqual([
      'm:src-1:fav1',
    ]);

    await service.setFavorite?.(
      {
        sourceId: 'src-1',
        itemKey: 'm:src-1:fav2',
        kind: 'movie',
        title: 'Daybreak',
      },
      true,
    );
    expect(decodeUserDataSnapshot(store.value).favorites).toHaveLength(2);

    await service.saveProgress?.({
      sourceId: 'src-1',
      itemKey: 'm:src-1:fav1',
      kind: 'movie',
      title: 'Starlight',
      positionMs: 45_000,
      durationMs: 1_200_000,
    });
    expect(decodeUserDataSnapshot(store.value).progress).toHaveLength(1);
    expect(decodeUserDataSnapshot(store.value).progress[0]?.watched).toBe(false);

    await service.setWatched?.('m:src-1:fav1', true);
    expect(decodeUserDataSnapshot(store.value).progress[0]?.watched).toBe(true);

    await service.clearProgress?.('m:src-1:fav1');
    expect(decodeUserDataSnapshot(store.value).progress).toHaveLength(0);

    // Re-add progress so removeSource proves both tables are pruned from backup too
    await service.saveProgress?.({
      sourceId: 'src-1',
      itemKey: 'm:src-1:fav2',
      kind: 'movie',
      title: 'Daybreak',
      positionMs: 60_000,
      durationMs: 1_000_000,
    });
    expect(decodeUserDataSnapshot(store.value).progress).toHaveLength(1);

    await service.removeSource('src-1');
    expect(decodeUserDataSnapshot(store.value)).toEqual({
      favorites: [],
      progress: [],
      profiles: [
        { id: 'default', name: 'Default', avatar: 'crimson', isKids: false, createdAt: 0 },
      ],
    });
  });
});

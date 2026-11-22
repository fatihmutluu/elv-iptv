import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { MIGRATIONS } from './schema';
import { addM3uSource, removeSource, TABLES_BY_SOURCE } from './sources';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import {
  clearTrackPreference,
  getTrackPreference,
  saveTrackPreference,
} from './track-preferences-repo';
import {
  decodeUserDataSnapshot,
  encodeUserDataSnapshot,
  reconcileUserData,
  type UserDataStore,
} from './user-state-backup';

async function setupDb() {
  const handle = testDb();
  const opened = await openCatalog(handle.db);
  expect(opened.ok).toBe(true);
  return handle;
}

function memoryUserDataStore(): UserDataStore & { value: string | undefined } {
  const store = {
    value: undefined as string | undefined,
    read: () => store.value,
    write: (next: string) => {
      store.value = next;
    },
  };
  return store;
}

describe('MIGRATION_V9 & track_preferences repo (#208)', () => {
  it('upgrades a v8 database to v9 with track_preferences table and source index', async () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(9);
    expect(TABLES_BY_SOURCE).toContain('track_preferences');

    const { db } = testDb();
    for (let i = 0; i < 8; i += 1) {
      await db.exec(MIGRATIONS[i] ?? '');
    }
    await db.exec('PRAGMA user_version = 8');

    const res = await openCatalog(db);
    expect(res.ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
    const indexes = await db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_track_preferences_source'",
    );
    expect(indexes).toHaveLength(1);
  });

  it('inserts, merges partial UPSERT updates cleanly, clears explicit nulls, and isolates profiles', async () => {
    const { db } = await setupDb();
    expect(await getTrackPreference(db, 'm:src-1:100')).toBeNull();

    await saveTrackPreference(
      db,
      {
        scopeKey: 'm:src-1:100',
        sourceId: 'src-1',
        audioLang: 'tr',
        audioLabel: 'Turkish 5.1',
        audioDelayMs: 150,
        resizeMode: 'fill',
      },
      () => 1_000,
    );

    expect(await getTrackPreference(db, 'm:src-1:100')).toEqual({
      profileId: 'default',
      scopeKey: 'm:src-1:100',
      sourceId: 'src-1',
      audioLang: 'tr',
      audioLabel: 'Turkish 5.1',
      subLang: null,
      subLabel: null,
      subDisabled: false,
      audioDelayMs: 150,
      subDelayMs: 0,
      resizeMode: 'fill',
      updatedAt: 1_000,
    });

    // Partial update touches only subtitle fields and preserves audio/delay/resizeMode
    await saveTrackPreference(
      db,
      {
        scopeKey: 'm:src-1:100',
        sourceId: 'src-1',
        subLang: 'en',
        subLabel: 'English SDH',
        subDelayMs: -250,
      },
      () => 2_000,
    );

    expect(await getTrackPreference(db, 'm:src-1:100')).toEqual({
      profileId: 'default',
      scopeKey: 'm:src-1:100',
      sourceId: 'src-1',
      audioLang: 'tr',
      audioLabel: 'Turkish 5.1',
      subLang: 'en',
      subLabel: 'English SDH',
      subDisabled: false,
      audioDelayMs: 150,
      subDelayMs: -250,
      resizeMode: 'fill',
      updatedAt: 2_000,
    });

    // Explicit null clears fields while omitted fields remain intact
    await saveTrackPreference(
      db,
      {
        scopeKey: 'm:src-1:100',
        sourceId: 'src-1',
        audioLang: null,
        subDisabled: true,
        resizeMode: null,
      },
      () => 3_000,
    );
    expect(await getTrackPreference(db, 'm:src-1:100')).toEqual({
      profileId: 'default',
      scopeKey: 'm:src-1:100',
      sourceId: 'src-1',
      audioLang: null,
      audioLabel: 'Turkish 5.1',
      subLang: 'en',
      subLabel: 'English SDH',
      subDisabled: true,
      audioDelayMs: 150,
      subDelayMs: -250,
      resizeMode: null,
      updatedAt: 3_000,
    });

    // Profile isolation
    await saveTrackPreference(
      db,
      {
        profileId: 'kids',
        scopeKey: 'm:src-1:100',
        sourceId: 'src-1',
        audioLang: 'en',
      },
      () => 4_000,
    );
    expect((await getTrackPreference(db, 'm:src-1:100', 'kids'))?.audioLang).toBe('en');
    expect((await getTrackPreference(db, 'm:src-1:100', 'default'))?.audioLang).toBeNull();

    // Clear removes only targeted profile/scope
    await clearTrackPreference(db, 'm:src-1:100', 'default');
    expect(await getTrackPreference(db, 'm:src-1:100', 'default')).toBeNull();
    expect((await getTrackPreference(db, 'm:src-1:100', 'kids'))?.audioLang).toBe('en');
  });

  it('never stores URLs, credentials, or template strings in track labels', async () => {
    const { db } = await setupDb();
    await saveTrackPreference(
      db,
      {
        scopeKey: 'm:src-1:200',
        sourceId: 'src-1',
        audioLang: 'https://secret:pass@host/track',
        audioLabel: 'https://user:pass@cdn.example/a.m3u8',
        subLabel: '{{v:0}} secret',
      },
      () => 5_000,
    );
    const saved = await getTrackPreference(db, 'm:src-1:200');
    expect(saved?.audioLang).toBeNull();
    expect(saved?.audioLabel).toBeNull();
    expect(saved?.subLabel).toBeNull();
  });

  it('purges track_preferences rows when a source is removed', async () => {
    const { db } = await setupDb();
    const secrets = memorySecrets();
    const added = await addM3uSource(
      { name: 'Test', playlistUrl: 'https://example.invalid/p.m3u' },
      { db, secrets, clock: () => 100, newId: () => 'src-del' },
    );
    expect(added.ok).toBe(true);

    await saveTrackPreference(
      db,
      { scopeKey: 'm:src-del:1', sourceId: 'src-del', audioLang: 'tr' },
      () => 1_000,
    );
    await saveTrackPreference(
      db,
      { scopeKey: 'm:src-keep:1', sourceId: 'src-keep', audioLang: 'en' },
      () => 1_000,
    );

    const removed = await removeSource('src-del', { db, secrets });
    expect(removed.ok).toBe(true);
    expect(await getTrackPreference(db, 'm:src-del:1')).toBeNull();
    expect((await getTrackPreference(db, 'm:src-keep:1'))?.audioLang).toBe('en');
  });

  it('backs up and restores track_preferences through user-state-backup and wires onto CatalogService', async () => {
    const store = memoryUserDataStore();
    const first = await setupDb();
    const catalog = createCatalogService({
      db: first.db,
      secrets: memorySecrets(),
      scheduler: countingScheduler(),
      http: {
        get: async () => {
          throw new Error('unused');
        },
      },
      clock: () => 9_000,
      userData: store,
    });

    await catalog.saveTrackPreference?.({
      scopeKey: 's:src-1:42',
      sourceId: 'src-1',
      audioLang: 'ja',
      subLang: 'tr',
      subDelayMs: 300,
      resizeMode: 'stretch',
    });
    expect(await catalog.getTrackPreference?.('s:src-1:42')).toMatchObject({
      audioLang: 'ja',
      subLang: 'tr',
      subDelayMs: 300,
      resizeMode: 'stretch',
    });
    expect(store.value).toBeDefined();

    // Verify encode/decode round-trip
    const decoded = decodeUserDataSnapshot(store.value);
    expect(decoded.trackPreferences).toHaveLength(1);
    const reEncoded = encodeUserDataSnapshot({
      favorites: [],
      progress: [],
      trackPreferences: decoded.trackPreferences ?? [],
    });
    expect(decodeUserDataSnapshot(reEncoded).trackPreferences).toEqual(decoded.trackPreferences);

    // Simulate fresh empty DB after purge and reconcile
    const purged = await setupDb();
    const restored = await reconcileUserData(purged.db, store);
    expect(restored.trackPreferencesRestored).toBe(1);
    expect(await getTrackPreference(purged.db, 's:src-1:42')).toMatchObject({
      audioLang: 'ja',
      subLang: 'tr',
      subDelayMs: 300,
      resizeMode: 'stretch',
    });

    await catalog.clearTrackPreference?.('s:src-1:42');
    expect(await catalog.getTrackPreference?.('s:src-1:42')).toBeNull();
    await catalog.close();
  });
});

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { createSyncSqlDriver, openCatalog } from './index';
import { createProfile, listProfiles } from './profiles-repo';
import { addM3uSource, updateSourceSettings } from './sources';
import {
  applyWatchedEpisodeBitfield,
  listAllWatchProgress,
  listCollectionRawItemKeys,
  listContinueWatchingDismissals,
  listSourceRecords,
  setContinueWatchingDismissal,
} from './sync-state-repo';
import { saveWatchProgress, setItemWatched } from './user-state';
import { addItemToCollection, createCollection } from './vod-collections-repo';

function makeMemorySecrets() {
  const data = new Map<string, string>();
  return {
    get: async (k: string) => data.get(k),
    set: async (k: string, v: string) => {
      data.set(k, v);
    },
    delete: async (k: string) => {
      data.delete(k);
    },
  };
}

async function openTestDb() {
  const raw = new Database(':memory:');
  const db = createSyncSqlDriver(raw);
  const opened = await openCatalog(db, () => 1_000);
  if (!opened.ok) throw new Error(`openCatalog failed: ${opened.error.code}`);
  return { db, raw };
}

describe('sync-state-repo (Wave P9 VaultSnapshot v2 helpers)', () => {
  it('supports explicit profile id in createProfile for cross-device sync parity', async () => {
    const { db, raw } = await openTestDb();
    try {
      const created = await createProfile(
        db,
        { id: 'kids_sync_1', name: 'Kids', avatarToken: 'teal', isKids: true },
        () => 5_000,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.value.id).toBe('kids_sync_1');
      expect(created.value.isKids).toBe(true);

      const all = await listProfiles(db);
      expect(all.some((p) => p.id === 'kids_sync_1' && p.name === 'Kids')).toBe(true);

      const invalid = await createProfile(db, { id: 'bad id/..', name: 'Bad' }, () => 5_000);
      expect(invalid.ok).toBe(false);
    } finally {
      raw.close();
    }
  });

  it('lists all watch progress (both in-progress and completed movies/episodes) per profile without Next-Up synthesis', async () => {
    const { db, raw } = await openTestDb();
    try {
      await saveWatchProgress(
        db,
        {
          profileId: 'default',
          sourceId: 's1',
          itemKey: 'x:s1:movie:1',
          kind: 'movie',
          title: 'Dune',
          positionMs: 120_000,
          durationMs: 7_200_000,
        },
        () => 1_000,
      );
      await saveWatchProgress(
        db,
        {
          profileId: 'default',
          sourceId: 's1',
          itemKey: 'x:s1:episode:101',
          kind: 'episode',
          title: 'Ep 1',
          seriesKey: 'x:s1:series:10',
          season: 1,
          episode: 1,
          positionMs: 2_700_000,
          durationMs: 2_700_000,
          watched: true,
        },
        () => 2_000,
      );
      await saveWatchProgress(
        db,
        {
          profileId: 'kids',
          sourceId: 's1',
          itemKey: 'x:s1:movie:2',
          kind: 'movie',
          title: 'Frozen',
          positionMs: 300_000,
          durationMs: 5_400_000,
        },
        () => 3_000,
      );

      const defRows = await listAllWatchProgress(db, 'default');
      expect(defRows.map((r) => [r.itemKey, r.watched, r.episode])).toEqual([
        ['x:s1:episode:101', true, 1],
        ['x:s1:movie:1', false, null],
      ]);

      const kidsRows = await listAllWatchProgress(db, 'kids');
      expect(kidsRows.map((r) => r.itemKey)).toEqual(['x:s1:movie:2']);
    } finally {
      raw.close();
    }
  });

  it('lists, upserts (LWW), and deletes continueWatchingDismissals per profile', async () => {
    const { db, raw } = await openTestDb();
    try {
      expect(
        await setContinueWatchingDismissal(
          db,
          { profileId: 'default', seriesKey: 'x:s1:series:1', sourceId: 's1', dismissedAt: 500 },
          false,
        ),
      ).toEqual({ ok: true, value: undefined });

      // Stale dismissal does not overwrite newer dismissedAt
      await setContinueWatchingDismissal(
        db,
        { profileId: 'default', seriesKey: 'x:s1:series:1', sourceId: 's1', dismissedAt: 300 },
        false,
      );
      expect(await listContinueWatchingDismissals(db, 'default')).toEqual([
        { profileId: 'default', seriesKey: 'x:s1:series:1', sourceId: 's1', dismissedAt: 500 },
      ]);

      // Newer timestamp wins
      await setContinueWatchingDismissal(
        db,
        { profileId: 'default', seriesKey: 'x:s1:series:1', sourceId: 's1', dismissedAt: 900 },
        false,
      );
      expect(await listContinueWatchingDismissals(db, 'default')).toEqual([
        { profileId: 'default', seriesKey: 'x:s1:series:1', sourceId: 's1', dismissedAt: 900 },
      ]);

      // Deletion removes dismissal
      await setContinueWatchingDismissal(
        db,
        { profileId: 'default', seriesKey: 'x:s1:series:1', sourceId: 's1', dismissedAt: 1000 },
        true,
      );
      expect(await listContinueWatchingDismissals(db, 'default')).toEqual([]);
    } finally {
      raw.close();
    }
  });

  it('lists raw collection item keys even before catalog rows are imported, lists full source records, and applies watched episode bitfields', async () => {
    const { db, raw } = await openTestDb();
    const secrets = makeMemorySecrets();
    try {
      const col = await createCollection(db, { id: 'vc-1', name: 'Sci-Fi', profileId: 'kids' }, 10);
      expect(col.ok).toBe(true);
      await addItemToCollection(db, 'vc-1', 'x:s1:movie:1', 'movie', 'kids', 20);
      await addItemToCollection(db, 'vc-1', 'x:s1:series:2', 'series', 'kids', 30);
      expect(await listCollectionRawItemKeys(db, 'vc-1', 'kids')).toEqual([
        'x:s1:movie:1',
        'x:s1:series:2',
      ]);

      const added = await addM3uSource(
        {
          name: 'Living Room',
          playlistUrl: 'https://provider.example/list.m3u',
          transport: { userAgent: 'ELV/1', allowLegacyTls: true },
        },
        { db, secrets, clock: () => 100, newId: () => 's1' },
      );
      expect(added.ok).toBe(true);
      await updateSourceSettings(db, 's1', {
        epgShiftMs: 3_600_000,
        xmltvTimezone: 'Europe/Istanbul',
        excludedProfileIds: ['kids'],
        transport: { userAgent: 'ELV/1', allowLegacyTls: true },
      });
      const records = await listSourceRecords(db);
      expect(records).toHaveLength(1);
      expect(records[0]?.settings.epgShiftMs).toBe(3_600_000);
      expect(records[0]?.settings.excludedProfileIds).toEqual(['kids']);
      expect(records[0]?.settings.transport?.userAgent).toBe('ELV/1');

      // Seed series + episodes for bitfield apply
      await db.run(
        `INSERT INTO series (source_id, key, provider_id, name, name_fold, run_id)
         VALUES ('s1', 'x:s1:series:10', '10', 'Show', 'show', 1)`,
      );
      await db.run(
        `INSERT INTO episodes (source_id, key, provider_id, series_key, season, episode, title, run_id)
         VALUES ('s1', 'x:s1:episode:101', '101', 'x:s1:series:10', 1, 1, 'Pilot', 1),
                ('s1', 'x:s1:episode:102', '102', 'x:s1:series:10', 1, 2, 'Two', 1),
                ('s1', 'x:s1:episode:103', '103', 'x:s1:series:10', 1, 3, 'Three', 1)`,
      );

      const applied = await applyWatchedEpisodeBitfield(db, {
        profileId: 'default',
        seriesKey: 'x:s1:series:10',
        season: 1,
        episodeIndices: [1, 3],
        updatedAt: 5_000,
      });
      expect(applied).toEqual({ ok: true, value: 2 });

      const progress = await listAllWatchProgress(db, 'default');
      expect(progress.map((r) => [r.itemKey, r.watched]).sort()).toEqual([
        ['x:s1:episode:101', true],
        ['x:s1:episode:103', true],
      ]);

      // Verify CatalogService exposes the new sync helpers cleanly
      const service = createCatalogService({
        db,
        secrets,
        scheduler: { yieldNow: async () => undefined },
        http: { fetch: async () => new Response() } as never,
        clock: () => 9_000,
      });
      expect((await service.listAllWatchProgress?.('default'))?.length).toBe(2);
      expect(await service.listSourceRecords?.()).toHaveLength(1);
      expect(await service.listCollectionRawItemKeys?.('vc-1', 'kids')).toEqual([
        'x:s1:movie:1',
        'x:s1:series:2',
      ]);
      await setItemWatched(db, 'x:s1:episode:102', true, () => 6_000, 'default');
      expect((await service.listAllWatchProgress?.('default'))?.length).toBe(3);
    } finally {
      raw.close();
    }
  });
});

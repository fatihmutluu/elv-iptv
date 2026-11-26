import type { DownloadMediaKind, HttpClient, SecretStore } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { createCatalogService } from './catalog';
import {
  deleteDownload,
  deleteDownloadsBySource,
  getDownload,
  listDownloads,
  setDownloadStatus,
  updateDownloadProgress,
  upsertDownload,
} from './downloads-repo';
import { openCatalog, SCHEMA_VERSION } from './migrate';
import { EXPECTED_TABLE_COLUMNS, MIGRATIONS } from './schema';
import { createPlaytimeResolverCache } from './stream-resolver';
import { testDb } from './test-db';

function makeMemorySecrets(): SecretStore & { getSpy: ReturnType<typeof vi.fn> } {
  const store = new Map<string, string>();
  const getSpy = vi.fn(async (key: string) => store.get(key));
  return {
    getSpy,
    get: getSpy,
    set: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  };
}

const noopHttp: HttpClient = {
  get: async () => {
    throw new Error('network should not be called');
  },
};

describe('schema v21 & downloads-repo', () => {
  it('upgrades a v20 database to v21 with downloads table, indexes, and movie/episode CHECK constraint', async () => {
    const { db } = testDb();
    for (let i = 0; i < 20; i += 1) await db.exec(MIGRATIONS[i] ?? '');
    await db.exec('PRAGMA user_version = 20');

    expect(SCHEMA_VERSION).toBe(21);
    expect((await openCatalog(db)).ok).toBe(true);
    expect(await db.all('PRAGMA user_version')).toEqual([{ user_version: 21 }]);
    expect(EXPECTED_TABLE_COLUMNS.downloads?.length).toBeGreaterThan(0);

    await expect(
      db.run(
        `INSERT INTO downloads (id, profile_id, source_id, item_key, kind, title, local_file_name)
         VALUES ('d-bad', 'default', 's1', 'x:s1:live:1', 'live', 'Bad Channel', 'bad.mp4')`,
      ),
    ).rejects.toThrow();
  });

  it('supports CRUD, progress updates, status transitions, profile isolation, and source cleanup', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    let now = 1_000;
    const clock = () => {
      now += 100;
      return now;
    };

    const badKind = await upsertDownload(
      db,
      {
        id: 'dl-bad',
        sourceId: 's1',
        itemKey: 'x:s1:live:1',
        kind: 'live' as unknown as DownloadMediaKind,
        title: 'Live Not Allowed',
        localFileName: 'bad.mp4',
      },
      clock,
    );
    expect(badKind).toMatchObject({
      ok: false,
      error: { category: 'source-format', code: 'invalid-download-kind' },
    });

    const badFile = await upsertDownload(
      db,
      {
        id: 'dl-bad-file',
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
        kind: 'movie',
        title: 'Bad Path',
        localFileName: '../escape.mp4',
      },
      clock,
    );
    expect(badFile).toMatchObject({
      ok: false,
      error: { category: 'source-format', code: 'invalid-download-filename' },
    });

    const createdMovie = await upsertDownload(
      db,
      {
        id: 'dl-m1',
        sourceId: 's1',
        itemKey: 'x:s1:movie:1',
        kind: 'movie',
        title: 'Solaris',
        poster: 'https://img.example.test/solaris.jpg',
        localFileName: 'dl-m1.mp4',
        totalBytes: 2_000_000,
      },
      clock,
    );
    expect(createdMovie.ok).toBe(true);
    if (createdMovie.ok) {
      expect(createdMovie.value.status).toBe('queued');
      expect(createdMovie.value.bytesDownloaded).toBe(0);
      expect(createdMovie.value.profileId).toBe('default');
    }

    const createdEp = await upsertDownload(
      db,
      {
        id: 'dl-e1',
        profileId: 'kids',
        sourceId: 's2',
        itemKey: 'x:s2:ep:1',
        kind: 'episode',
        title: 'Pilot',
        seriesTitle: 'Starlight',
        season: 1,
        episodeNum: 1,
        localFileName: 'dl-e1.mkv',
        status: 'downloading',
        bytesDownloaded: 500,
        totalBytes: 1_000,
      },
      clock,
    );
    expect(createdEp.ok).toBe(true);

    const progressed = await updateDownloadProgress(
      db,
      'x:s1:movie:1',
      { bytesDownloaded: 1_000_000, status: 'downloading' },
      'default',
      clock,
    );
    expect(progressed.ok).toBe(true);
    if (progressed.ok) {
      expect(progressed.value.bytesDownloaded).toBe(1_000_000);
      expect(progressed.value.status).toBe('downloading');
    }

    const paused = await setDownloadStatus(
      db,
      'x:s1:movie:1',
      'paused',
      { pausedForPlayback: true },
      clock,
    );
    expect(paused.ok).toBe(true);
    if (paused.ok) {
      expect(paused.value.status).toBe('paused');
      expect(paused.value.pausedForPlayback).toBe(true);
    }

    const completed = await setDownloadStatus(
      db,
      'x:s1:movie:1',
      'completed',
      {
        localUri: 'file:///downloads/dl-m1.mp4',
        bytesDownloaded: 2_000_000,
        pausedForPlayback: false,
      },
      clock,
    );
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.value.status).toBe('completed');
      expect(completed.value.localUri).toBe('file:///downloads/dl-m1.mp4');
      expect(completed.value.completedAt).toBe(now);
      expect(completed.value.pausedForPlayback).toBe(false);
    }

    expect(await listDownloads(db, { profileId: 'default' })).toHaveLength(1);
    expect(await listDownloads(db, { profileId: 'default', status: 'completed' })).toHaveLength(1);
    expect(await listDownloads(db, { profileId: 'default', status: ['queued', 'paused'] })).toEqual(
      [],
    );
    expect(await listDownloads(db, { profileId: 'kids', kind: 'episode' })).toHaveLength(1);
    expect(await getDownload(db, 'x:s1:movie:1', 'kids')).toBeNull();

    expect((await deleteDownload(db, 'x:s1:movie:1', 'default')).ok).toBe(true);
    expect(await getDownload(db, 'x:s1:movie:1', 'default')).toBeNull();

    expect(await deleteDownloadsBySource(db, 's2')).toBe(1);
    expect(await listDownloads(db, { profileId: 'kids' })).toEqual([]);
  });

  it('resolves managed local offline downloads without touching credentials while still rejecting arbitrary file:// templates', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = makeMemorySecrets();

    await db.run(
      "INSERT INTO sources (id, kind, name, created_at, settings_json) VALUES ('s1', 'm3u', 'Main', 100, '{}')",
    );
    await db.run(
      `INSERT INTO movies (source_id, key, name, name_fold, url_template, run_id)
       VALUES ('s1', 'm:s1:movie:evil', 'Evil', 'evil', 'file:///etc/passwd', 1)`,
    );

    const resolveLocalDownload = vi.fn(async (itemKey: string, profileId?: string) => {
      if (itemKey === 'm:s1:movie:offline' && profileId === 'p1') {
        return 'file:///app/downloads/dl-1.mp4';
      }
      return null;
    });

    const cache = createPlaytimeResolverCache({
      db,
      secrets,
      http: noopHttp,
      resolveLocalDownload,
    });

    const offlineRes = await cache.resolveStream('m:s1:movie:offline', { profileId: 'p1' });
    expect(offlineRes).toEqual({
      ok: true,
      value: {
        url: 'file:///app/downloads/dl-1.mp4',
        headers: {},
        channelKey: 'm:s1:movie:offline',
        isLocalOffline: true,
      },
    });
    expect(secrets.getSpy).not.toHaveBeenCalled();

    const evilRes = await cache.resolveStream('m:s1:movie:evil');
    expect(evilRes).toMatchObject({
      ok: false,
      error: { category: 'playback', code: 'unsupported-scheme' },
    });
  });

  it('exposes optional downloads ops and resolveLocalDownload through CatalogService', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = makeMemorySecrets();
    const service = createCatalogService({
      db,
      secrets,
      scheduler: { yieldNow: async () => undefined },
      http: noopHttp,
      clock: () => 5_000,
      resolveLocalDownload: async (itemKey, profileId) => {
        const dl = await getDownload(db, itemKey, profileId);
        return dl?.status === 'completed' ? dl.localUri : null;
      },
    });

    const upserted = await service.upsertDownload?.({
      id: 'dl-svc-1',
      sourceId: 's1',
      itemKey: 'x:s1:movie:9',
      kind: 'movie',
      title: 'Arrival',
      localFileName: 'dl-svc-1.mp4',
      localUri: 'file:///app/downloads/dl-svc-1.mp4',
      status: 'completed',
      bytesDownloaded: 100,
      totalBytes: 100,
    });
    expect(upserted?.ok).toBe(true);
    expect(await service.listDownloads?.()).toHaveLength(1);
    expect((await service.getDownload?.('x:s1:movie:9'))?.title).toBe('Arrival');

    const stream = await service.resolveStream('x:s1:movie:9');
    expect(stream).toEqual({
      ok: true,
      value: {
        url: 'file:///app/downloads/dl-svc-1.mp4',
        headers: {},
        channelKey: 'x:s1:movie:9',
        isLocalOffline: true,
      },
    });

    expect((await service.deleteDownload?.('x:s1:movie:9'))?.ok).toBe(true);
    expect(await service.listDownloads?.()).toEqual([]);
    await service.close();
  });
});

import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { openCatalog } from './migrate';
import {
  MAX_SOURCE_NAME_LENGTH,
  renameSource,
  setSourceExcludedProfiles,
} from './source-mutations';
import {
  addM3uSource,
  addStalkerSource,
  addXtreamSource,
  getSource,
  normalizeActiveConnections,
  normalizeMaxConnections,
  removeSecrets,
  removeSource,
  secretKey,
  TABLES_BY_SOURCE,
  updateSourceSettings,
} from './sources';
import { countingScheduler, memorySecrets, testDb } from './test-db';
import { createCoalescedCatalog } from './write-coalescer';

const PW = ['hunt', 'er2'].join('');
const USER = 'bobuser';
const TOKEN = ['tok', 'en9876'].join('');

async function setup() {
  const t = testDb();
  await openCatalog(t.db);
  const secrets = memorySecrets();
  let n = 0;
  const deps = {
    db: t.db,
    secrets,
    clock: () => 1234,
    newId: () => {
      n += 1;
      return `src${n}`;
    },
  };
  return { ...t, secrets, deps };
}

async function rowText(db: ReturnType<typeof testDb>['db']): Promise<string> {
  return JSON.stringify(await db.all('SELECT * FROM sources'));
}

const failing = (s: { secrets: ReturnType<typeof memorySecrets> }) => ({
  ...s.secrets,
  set: async () => Promise.reject(new Error('locked')),
});

describe('addXtreamSource', () => {
  it('keeps server, username and password only in the secret store', async () => {
    const s = await setup();
    const r = await addXtreamSource(
      {
        name: 'Main',
        server: 'https://panel.example:8080',
        username: USER,
        password: PW,
        transport: { userAgent: 'UA' },
      },
      s.deps,
    );
    expect(r.ok).toBe(true);
    const text = await rowText(s.db);
    for (const secret of [USER, PW, 'panel.example']) expect(text).not.toContain(secret);
    expect(JSON.parse(s.secrets.dump()[secretKey('src1', 'xtream')] as string)).toEqual({
      server: 'https://panel.example:8080',
      username: USER,
      password: PW,
    });
    expect(await getSource(s.db, 'src1')).toEqual({
      id: 'src1',
      kind: 'xtream',
      name: 'Main',
      createdAt: 1234,
      settings: { transport: { userAgent: 'UA' } },
    });
  });

  it('rejects empty fields', async () => {
    const s = await setup();
    const r = await addXtreamSource(
      { name: 'x', server: '', username: USER, password: PW },
      s.deps,
    );
    expect(r).toEqual({ ok: false, error: { category: 'source-format', code: 'invalid-source' } });
    expect((await s.db.all('SELECT * FROM sources')).length).toBe(0);
  });

  it('reports a failing secret store and leaves nothing behind', async () => {
    const s = await setup();
    const r = await addXtreamSource(
      { name: 'x', server: 'https://p.example', username: USER, password: PW },
      { ...s.deps, secrets: failing(s) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ category: 'storage', code: 'secret-store-failed' });
    expect((await s.db.all('SELECT * FROM sources')).length).toBe(0);
  });

  it('removes its secrets when the row cannot be written', async () => {
    const s = await setup();
    await s.db.exec('DROP TABLE sources');
    const r = await addXtreamSource(
      { name: 'x', server: 'https://p.example', username: USER, password: PW },
      s.deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ category: 'storage', code: 'source-write-failed' });
    expect(s.secrets.dump()).toEqual({});
  });
});

describe('addM3uSource', () => {
  it('stores the playlist URL and the guide URL as secrets only', async () => {
    const s = await setup();
    const playlist = `https://h.example/get.php?username=${USER}&token=${TOKEN}`;
    const r = await addM3uSource(
      {
        name: 'List',
        playlistUrl: playlist,
        guideUrl: `https://h.example/epg.xml?token=${TOKEN}`,
        vodPlaylist: true,
      },
      s.deps,
    );
    expect(r.ok).toBe(true);
    const text = await rowText(s.db);
    for (const secret of [USER, TOKEN, 'get.php']) expect(text).not.toContain(secret);
    expect(s.secrets.dump()[secretKey('src1', 'playlist')]).toBe(playlist);
    const vars = JSON.parse(s.secrets.dump()[secretKey('src1', 'urlvars')] as string);
    expect(vars).toEqual({ 'g:url': `https://h.example/epg.xml?token=${TOKEN}` });
    const source = await getSource(s.db, 'src1');
    expect(source?.settings.vodPlaylist).toBe(true);
    expect(source?.settings.guideUrl).toBe('{{g:url}}');
  });

  it('rejects an empty playlist URL and survives a failing secret store', async () => {
    const s = await setup();
    expect((await addM3uSource({ name: 'x', playlistUrl: ' ' }, s.deps)).ok).toBe(false);
    const r = await addM3uSource(
      { name: 'x', playlistUrl: 'https://h.example/a.m3u' },
      { ...s.deps, secrets: failing(s) },
    );
    expect(r.ok).toBe(false);
  });

  it('removes its secrets when the row cannot be written', async () => {
    const s = await setup();
    await s.db.exec('DROP TABLE sources');
    const r = await addM3uSource({ name: 'x', playlistUrl: 'https://h.example/a.m3u' }, s.deps);
    expect(r.ok).toBe(false);
    expect(s.secrets.dump()).toEqual({});
  });
});

describe('getSource and updateSourceSettings', () => {
  it('round-trips settings and returns undefined for unknown ids', async () => {
    const s = await setup();
    await addM3uSource({ name: 'List', playlistUrl: 'https://h.example/a.m3u' }, s.deps);
    const settings = {
      segmentRules: [{ host: 'h.example', position: 0, name: 'v0' }],
      guideWindow: { daysBack: 2, daysForward: 3 },
      transport: { xtreamFormat: 'm3u8' as const },
    };
    await updateSourceSettings(s.db, 'src1', settings);
    expect((await getSource(s.db, 'src1'))?.settings).toEqual(settings);
    expect(await getSource(s.db, 'nope')).toBeUndefined();
  });
});

const SOURCE_TEST_TABLES: Record<string, string> = {
  import_runs: "(id, source_id, kind, started_at, status) VALUES (?, ?, 'catalog', 1, 'ok')",
  categories:
    "(source_id, kind, provider_id, name, name_fold, position, run_id) VALUES (?, 'live', 'c', 'n', 'n', 0, 1)",
  categories_next:
    "(source_id, kind, provider_id, name, name_fold, position, run_id) VALUES (?, 'live', 'c', 'n', 'n', 0, 1)",
  live: "(source_id, key, name, name_fold, run_id) VALUES (?, 'k', 'n', 'n', 1)",
  live_next: "(source_id, key, name, name_fold, run_id) VALUES (?, 'k', 'n', 'n', 1)",
  movies: "(source_id, key, name, name_fold, run_id) VALUES (?, 'k', 'n', 'n', 1)",
  movies_next: "(source_id, key, name, name_fold, run_id) VALUES (?, 'k', 'n', 'n', 1)",
  series: "(source_id, key, name, name_fold, run_id) VALUES (?, 'k', 'n', 'n', 1)",
  series_next: "(source_id, key, name, name_fold, run_id) VALUES (?, 'k', 'n', 'n', 1)",
  episodes: "(source_id, key, series_key, run_id) VALUES (?, 'k', 's', 1)",
  episodes_next: "(source_id, key, series_key, run_id) VALUES (?, 'k', 's', 1)",
  placements:
    "(source_id, kind, item_key, category_id, position, run_id) VALUES (?, 'live', 'k', 'c', 0, 1)",
  placements_next:
    "(source_id, kind, item_key, category_id, position, run_id) VALUES (?, 'live', 'k', 'c', 0, 1)",
  guide_channels: "(source_id, guide_id, name, name_fold, run_id) VALUES (?, 'g', 'n', 'n', 1)",
  channel_guide: "(source_id, channel_key, guide_id) VALUES (?, 'k', 'g')",
  programmes: "(source_id, guide_id, start, stop, title, run_id) VALUES (?, 'g', 1, 2, 't', 1)",
  programmes_fts:
    "(source_id, guide_id, start, stop, title_fold, description_fold) VALUES (?, 'g', 1, 2, 't', '')",
  programmes_next:
    "(source_id, guide_id, start, stop, title, run_id) VALUES (?, 'g', 1, 2, 't', 1)",
  watch_progress:
    "(profile_id, source_id, item_key, kind, title, position_ms, duration_ms, watched, updated_at) VALUES ('default', ?, ?, 'movie', 't', 20000, 60000, 0, 1)",
  favorites:
    "(profile_id, source_id, item_key, kind, title, added_at) VALUES ('default', ?, ?, 'movie', 't', 1)",
  track_preferences:
    "(profile_id, scope_key, source_id, audio_lang, updated_at) VALUES ('default', ?, ?, 'tr', 1)",
  recent_channels: "(profile_id, source_id, item_key, watched_at) VALUES ('default', ?, ?, 1)",
  parental_locks:
    "(profile_id, source_id, target_kind, item_kind, target_key, created_at) VALUES ('default', ?, 'category', 'live', 'c', 1)",
  channel_overrides:
    "(profile_id, item_key, source_id, custom_name, is_hidden, sort_order, updated_at) VALUES ('default', ?, ?, 'Custom', 0, 1, 1)",
  custom_group_items:
    "(group_id, item_key, source_id, position, added_at) VALUES ('grp1', ?, ?, 0, 1)",
  guide_sources:
    "(id, source_id, priority, name, url_template, epg_shift_ms, enabled) VALUES (?, ?, 0, 'Primary', '{{g:gs1}}', 0, 1)",
  channel_guide_overrides:
    "(source_id, channel_key, guide_source_id, guide_id, epg_shift_ms, is_manual, updated_at) VALUES (?, 'k', 'gs1', 'g', 0, 1, 1)",
  programme_reminders:
    "(profile_id, source_id, channel_key, channel_name, programme_title, programme_start, programme_stop, lead_time_ms, fired, created_at) VALUES ('default', ?, ?, 'Ch', 'Show', 1000, 2000, 300000, 0, 1)",
  failover_group_members: "(group_id, source_id, channel_key, position) VALUES ('fg1', ?, ?, 0)",
  vod_enrichment:
    "(item_key, source_id, clean_title, fetched_at, expires_at) VALUES (?, ?, 'Title', 1, 9999)",
  vod_collection_items:
    "(collection_id, item_key, source_id, kind, position, added_at) VALUES ('vc1', ?, ?, 'movie', 0, 1)",
  item_drm_meta: "(source_id, item_key, scheme) VALUES (?, 'k', 'clearkey')",
  downloads:
    "(id, profile_id, source_id, item_key, kind, title, local_file_name) VALUES ('dl1', 'default', ?, ?, 'movie', 'Film', 'dl1.mp4')",
  my_list_series_baselines:
    "(profile_id, series_key, source_id, baseline_at, last_checked_at, known_keys_json) VALUES ('default', ?, ?, 1, 1, '[]')",
  my_list_new_episodes:
    "(profile_id, episode_key, series_key, source_id, series_title, episode_title, detected_at, dismissed) VALUES ('default', ?, 's1', ?, 'Show', 'Ep 1', 1, 0)",
  continue_watching_dismissals:
    "(profile_id, series_key, source_id, dismissed_at) VALUES ('default', ?, ?, 1)",
  ratings:
    "(profile_id, source_id, item_key, kind, value, title, updated_at) VALUES ('default', ?, ?, 'movie', 'like', 'Film', 1)",
};

const SOURCE_ID_FIRST_TABLES = new Set([
  'watch_progress',
  'favorites',
  'recent_channels',
  'programme_reminders',
  'failover_group_members',
  'downloads',
  'ratings',
]);

const KEY_FIRST_TABLES = new Set([
  'track_preferences',
  'channel_overrides',
  'custom_group_items',
  'guide_sources',
  'vod_enrichment',
  'vod_collection_items',
  'my_list_series_baselines',
  'my_list_new_episodes',
  'continue_watching_dismissals',
]);

async function seedSourceTables(
  db: ReturnType<typeof testDb>['db'],
  includeProgrammesNext: boolean,
): Promise<string[]> {
  let runId = 1;
  const entries = Object.entries(SOURCE_TEST_TABLES).filter(
    ([table]) => includeProgrammesNext || table !== 'programmes_next',
  );
  for (const id of ['src1', 'src2']) {
    for (const [table, rest] of entries) {
      if (table === 'import_runs') {
        await db.run(`INSERT INTO import_runs ${rest}`, [runId, id]);
        runId += 1;
      } else if (SOURCE_ID_FIRST_TABLES.has(table)) {
        await db.run(`INSERT INTO ${table} ${rest}`, [id, `k:${id}`]);
      } else if (KEY_FIRST_TABLES.has(table)) {
        await db.run(`INSERT INTO ${table} ${rest}`, [`k:${id}`, id]);
      } else {
        await db.run(`INSERT INTO ${table} ${rest}`, [id]);
      }
    }
  }
  return entries.map(([table]) => table);
}

describe('removeSource', () => {
  it('deletes the row, every catalog row of the source and all secrets', async () => {
    const s = await setup();
    await addXtreamSource(
      { name: 'A', server: 'https://p.example', username: USER, password: PW },
      s.deps,
    );
    await addM3uSource({ name: 'B', playlistUrl: 'https://h.example/a.m3u' }, s.deps);
    const seededTables = await seedSourceTables(s.db, false);
    await removeSource('src1', s.deps);
    expect(await getSource(s.db, 'src1')).toBeUndefined();
    for (const table of seededTables) {
      const rows = await s.db.all<{ source_id: string }>(`SELECT source_id FROM ${table}`);
      expect(rows.map((r) => r.source_id)).toEqual(['src2']);
    }
    const keys = Object.keys(s.secrets.dump());
    expect(keys.filter((k) => k.startsWith('source.src1.'))).toEqual([]);
    expect(keys.filter((k) => k.startsWith('source.src2.')).length).toBeGreaterThan(0);
    expect(await getSource(s.db, 'src2')).toBeDefined();
  });

  it('marks deleting = 1 before chunked purge, keeps user state and secrets until final commit, and recovers via openCatalog on crash (#138)', async () => {
    const s = await setup();
    await addXtreamSource(
      { name: 'A', server: 'https://p.example', username: USER, password: PW },
      s.deps,
    );
    await addM3uSource({ name: 'B', playlistUrl: 'https://h.example/a.m3u' }, s.deps);
    await seedSourceTables(s.db, true);
    const secretsBefore = { ...s.secrets.dump() };
    const failingDb = {
      ...s.db,
      transaction: <T>(fn: (tx: typeof s.db) => Promise<T>) =>
        s.db.transaction((tx) =>
          fn({
            ...tx,
            run: async (sql, params) => {
              if (sql.includes('DELETE FROM placements')) {
                throw new Error('SQLITE_IOERR: disk I/O error');
              }
              return tx.run(sql, params);
            },
          }),
        ),
    };

    await expect(removeSource('src1', { db: failingDb, secrets: s.secrets })).rejects.toThrow(
      'SQLITE_IOERR',
    );

    // src1 is hidden immediately via deleting = 1 while user state, sources row, secrets, and src2 stay intact.
    expect(await getSource(s.db, 'src1')).toBeUndefined();
    expect(
      await s.db.all<{ id: string; deleting: number }>(
        'SELECT id, deleting FROM sources ORDER BY id',
      ),
    ).toEqual([
      { id: 'src1', deleting: 1 },
      { id: 'src2', deleting: 0 },
    ]);
    for (const table of ['watch_progress', 'favorites']) {
      const rows = await s.db.all<{ source_id: string }>(
        `SELECT source_id FROM ${table} ORDER BY source_id`,
      );
      expect(rows.map((r) => r.source_id)).toEqual(['src1', 'src2']);
    }
    expect(s.secrets.dump()).toEqual(secretsBefore);

    // Reopening the catalog resumes and finishes purging src1 cleanly without touching src2.
    expect((await openCatalog(s.db)).ok).toBe(true);
    expect(await s.db.all('SELECT id FROM sources ORDER BY id')).toEqual([{ id: 'src2' }]);
    for (const table of TABLES_BY_SOURCE) {
      if (table.endsWith('_next')) {
        expect(await s.db.all(`SELECT source_id FROM ${table}`)).toEqual([]);
      } else {
        const rows = await s.db.all<{ source_id: string }>(`SELECT source_id FROM ${table}`);
        expect(rows.map((r) => r.source_id)).toEqual(['src2']);
      }
    }
  });

  it('deletes large rowid and WITHOUT ROWID tables in bounded chunks and yields between chunks (#138)', async () => {
    const s = await setup();
    await addM3uSource({ name: 'Big', playlistUrl: 'https://h.example/a.m3u' }, s.deps);
    await s.db.batch(
      'INSERT INTO live (source_id, key, name, name_fold, run_id) VALUES (?, ?, ?, ?, 1)',
      Array.from({ length: 12 }, (_, i) => ['src1', `k${i}`, `Ch ${i}`, `ch ${i}`]),
    );
    await s.db.batch(
      "INSERT INTO placements (source_id, kind, item_key, category_id, position, run_id) VALUES (?, 'live', ?, 'News', ?, 1)",
      Array.from({ length: 12 }, (_, i) => ['src1', `k${i}`, i]),
    );

    const liveDeletes: string[] = [];
    const placementDeletes: string[] = [];
    let yields = 0;
    const trackedDb = {
      ...s.db,
      transaction: <T>(fn: (tx: typeof s.db) => Promise<T>) =>
        s.db.transaction((tx) =>
          fn({
            ...tx,
            run: async (sql, params) => {
              if (sql.startsWith('DELETE FROM live ')) liveDeletes.push(sql);
              if (sql.startsWith('DELETE FROM placements ')) placementDeletes.push(sql);
              return tx.run(sql, params);
            },
          }),
        ),
    };
    const res = await removeSource(
      'src1',
      {
        db: trackedDb,
        secrets: s.secrets,
        scheduler: {
          yieldNow: async () => {
            yields += 1;
          },
        },
      },
      { chunkSize: 5 },
    );
    expect(res.ok).toBe(true);
    expect(liveDeletes).toHaveLength(3);
    expect(placementDeletes).toHaveLength(3);
    expect(yields).toBeGreaterThanOrEqual(4);
    expect(await s.db.all('SELECT * FROM live')).toEqual([]);
    expect(await s.db.all('SELECT * FROM placements')).toEqual([]);
  });
});

describe('guide URLs', () => {
  const ACCT = ['acct', 'token', '0123456789'].join('');
  const OTHER = ['acct', 'token', '9876543210'].join('');

  it.each([
    ['the playlist token', ACCT],
    ['another token', OTHER],
  ])('stores a same-host guide URL with %s whole as a secret', async (_label, token) => {
    const s = await setup();
    const playlist = `https://h.example/${ACCT}/list.m3u?username=${USER}`;
    const guide = `https://h.example/${token}/epg.xml?ref=${USER}-x`;
    const r = await addM3uSource({ name: 'L', playlistUrl: playlist, guideUrl: guide }, s.deps);
    expect(r.ok).toBe(true);
    const text = await rowText(s.db);
    for (const secret of [ACCT, OTHER, USER]) expect(text).not.toContain(secret);
    expect((await getSource(s.db, 'src1'))?.settings.guideUrl).toBe('{{g:url}}');
    const vars = JSON.parse(s.secrets.dump()[secretKey('src1', 'urlvars')] as string);
    expect(vars).toEqual({ 'g:url': guide });
  });

  it('stores an Xtream guide override whole as a secret', async () => {
    const s = await setup();
    const guide = `https://p.example/${OTHER}/xmltv.php`;
    const r = await addXtreamSource(
      { name: 'X', server: 'https://p.example', username: USER, password: PW, guideUrl: guide },
      s.deps,
    );
    expect(r.ok && r.value.settings.guideUrl).toBe('{{g:url}}');
    expect(await rowText(s.db)).not.toContain(OTHER);
    expect(JSON.parse(s.secrets.dump()[secretKey('src1', 'urlvars')] as string)).toEqual({
      'g:url': guide,
    });
  });

  it('keeps a guide URL on another host out of settings_json', async () => {
    const s = await setup();
    const guide = `https://epg.example/${ACCT}/epg.xml`;
    await addM3uSource(
      { name: 'L', playlistUrl: 'https://h.example/a.m3u', guideUrl: guide },
      s.deps,
    );
    expect(await rowText(s.db)).not.toContain(ACCT);
    expect((await getSource(s.db, 'src1'))?.settings.guideUrl).toBe('{{g:url}}');
    const vars = JSON.parse(s.secrets.dump()[secretKey('src1', 'urlvars')] as string);
    expect(vars['g:url']).toBe(guide);
  });

  it('keeps unparsable URLs and literal braces as they are', async () => {
    const s = await setup();
    await addM3uSource({ name: 'L', playlistUrl: 'not a url', guideUrl: 'also not' }, s.deps);
    expect((await getSource(s.db, 'src1'))?.settings.guideUrl).toBe('{{g:url}}');
    const guide = 'https://h.example/{{x}}/e.xml';
    await addM3uSource(
      { name: 'L', playlistUrl: 'https://h.example/a.m3u', guideUrl: guide },
      s.deps,
    );
    const vars = JSON.parse(s.secrets.dump()[secretKey('src2', 'urlvars')] as string);
    expect(vars['g:url']).toBe(guide);
  });
});

describe('secret keys', () => {
  const EXPO_KEY = /^[A-Za-z0-9._-]+$/;

  it('uses only characters every platform secret store accepts', () => {
    expect(secretKey('9f1c-a_b', 'urlvars')).toBe('source.9f1c-a_b.urlvars');
    for (const part of ['xtream', 'playlist', 'urlvars'] as const) {
      expect(secretKey('src1', part)).toMatch(EXPO_KEY);
    }
  });

  it('refuses a source id outside that character set', async () => {
    const s = await setup();
    const deps = { ...s.deps, newId: () => 'bad id/1' };
    const m3u = await addM3uSource({ name: 'L', playlistUrl: 'https://h.example/a.m3u' }, deps);
    expect(m3u).toEqual({ ok: false, error: { category: 'storage', code: 'invalid-source-id' } });
    const xt = await addXtreamSource(
      { name: 'X', server: 'https://p.example', username: USER, password: PW },
      deps,
    );
    expect(xt.ok).toBe(false);
    expect(s.secrets.dump()).toEqual({});
    expect(await s.db.all('SELECT * FROM sources')).toEqual([]);
  });
});

describe('table coverage and secret removal', () => {
  it('lists every table that has a source_id column', async () => {
    const s = await setup();
    const rows = await s.db.all<{ name: string }>(
      "SELECT m.name AS name FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table' AND c.name = 'source_id'",
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...TABLES_BY_SOURCE].sort());
  });

  it('reports failed secret deletions after the rows are gone and allows a retry', async () => {
    const s = await setup();
    await addM3uSource({ name: 'B', playlistUrl: 'https://h.example/a.m3u' }, s.deps);
    const flaky = {
      ...s.secrets,
      delete: async (key: string) =>
        key.endsWith('playlist') ? Promise.reject(new Error('locked')) : s.secrets.delete(key),
    };
    const r = await removeSource('src1', { db: s.db, secrets: flaky });
    expect(r).toEqual({ ok: false, error: { category: 'storage', code: 'secret-delete-failed' } });
    expect(await getSource(s.db, 'src1')).toBeUndefined();
    expect(Object.keys(s.secrets.dump())).toEqual([secretKey('src1', 'playlist')]);
    expect((await removeSecrets('src1', s.secrets)).ok).toBe(true);
    expect(s.secrets.dump()).toEqual({});
  });

  it('removes all sharded urlvars keys along with manifest, xtream, and playlist secrets (#430)', async () => {
    const s = await setup();
    await addM3uSource({ name: 'Sharded', playlistUrl: 'https://h.example/a.m3u' }, s.deps);
    const rootKey = secretKey('src1', 'urlvars');
    await s.secrets.set(rootKey, JSON.stringify({ __chunks: 3 }));
    await s.secrets.set(`${rootKey}.0`, JSON.stringify({ a: '1' }));
    await s.secrets.set(`${rootKey}.1`, JSON.stringify({ b: '2' }));
    await s.secrets.set(`${rootKey}.2`, JSON.stringify({ c: '3' }));

    expect((await removeSecrets('src1', s.secrets)).ok).toBe(true);
    expect(s.secrets.dump()).toEqual({});
  });
});

describe('connection limit normalization (#87)', () => {
  it('coerces 0, empty, negative, non-numeric, and missing maxConnections values to 1', () => {
    expect(normalizeMaxConnections(undefined)).toBe(1);
    expect(normalizeMaxConnections(null)).toBe(1);
    expect(normalizeMaxConnections('')).toBe(1);
    expect(normalizeMaxConnections('   ')).toBe(1);
    expect(normalizeMaxConnections(0)).toBe(1);
    expect(normalizeMaxConnections('0')).toBe(1);
    expect(normalizeMaxConnections(-3)).toBe(1);
    expect(normalizeMaxConnections('-2')).toBe(1);
    expect(normalizeMaxConnections('unlimited')).toBe(1);
    expect(normalizeMaxConnections('3abc')).toBe(1);
    expect(normalizeMaxConnections(Number.NaN)).toBe(1);
    expect(normalizeMaxConnections(Number.POSITIVE_INFINITY)).toBe(1);
    expect(normalizeMaxConnections(1)).toBe(1);
    expect(normalizeMaxConnections('1')).toBe(1);
    expect(normalizeMaxConnections(3)).toBe(3);
    expect(normalizeMaxConnections(' 4 ')).toBe(4);
    expect(normalizeMaxConnections(2.9)).toBe(2);
  });

  it('normalizes optional provider activeConnections without inventing counts when absent', () => {
    expect(normalizeActiveConnections(undefined)).toBeUndefined();
    expect(normalizeActiveConnections(null)).toBeUndefined();
    expect(normalizeActiveConnections('')).toBeUndefined();
    expect(normalizeActiveConnections('abc')).toBeUndefined();
    expect(normalizeActiveConnections(-1)).toBeUndefined();
    expect(normalizeActiveConnections(Number.NaN)).toBeUndefined();
    expect(normalizeActiveConnections(0)).toBe(0);
    expect(normalizeActiveConnections('0')).toBe(0);
    expect(normalizeActiveConnections(2)).toBe(2);
    expect(normalizeActiveConnections(' 3 ')).toBe(3);
  });
});

describe('renameSource and setSourceExcludedProfiles (Wave P7)', () => {
  it('trims, validates <=80 chars, and persists renamed source without touching settings', async () => {
    const s = await setup();
    const added = await addXtreamSource(
      {
        name: 'Original',
        server: 'https://panel.example',
        username: USER,
        password: PW,
        transport: { userAgent: 'UA-Keep' },
      },
      s.deps,
    );
    expect(added.ok).toBe(true);
    expect(MAX_SOURCE_NAME_LENGTH).toBe(80);

    expect(await renameSource(s.db, 'src1', '   ')).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'invalid-source-name' },
    });
    expect(await renameSource(s.db, 'src1', 'a'.repeat(81))).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'invalid-source-name' },
    });
    expect(await renameSource(s.db, 'missing', 'Valid')).toEqual({
      ok: false,
      error: { category: 'storage', code: 'source-not-found' },
    });

    const renamed = await renameSource(s.db, 'src1', '  Living Room TV  ');
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.value.name).toBe('Living Room TV');
      expect(renamed.value.settings).toEqual({ transport: { userAgent: 'UA-Keep' } });
    }
    expect((await getSource(s.db, 'src1'))?.name).toBe('Living Room TV');
  });

  it('validates, deduplicates, sorts excludedProfileIds without clobbering existing settings, and wires through CatalogService & write-coalescer', async () => {
    const s = await setup();
    const catalog = createCoalescedCatalog(
      createCatalogService({
        db: s.db,
        secrets: s.secrets,
        scheduler: countingScheduler(),
        http: {
          get: async () => {
            throw new Error('unused');
          },
        },
        clock: () => 5000,
        newId: () => 'src_p7',
      }),
    );

    const added = await catalog.addSource({
      kind: 'm3u',
      name: 'Family List',
      playlistUrl: 'https://h.example/list.m3u',
      guideUrl: 'https://h.example/epg.xml',
      transport: { allowLegacyTls: true },
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.excludedProfileIds).toEqual([]);

    expect(await setSourceExcludedProfiles(s.db, 'src_p7', ['bad/id'])).toEqual({
      ok: false,
      error: { category: 'source-format', code: 'invalid-profile-id' },
    });
    expect(await setSourceExcludedProfiles(s.db, 'missing', ['p_kids'])).toEqual({
      ok: false,
      error: { category: 'storage', code: 'source-not-found' },
    });

    const excluded = await catalog.setSourceExcludedProfiles?.('src_p7', [
      'p_kids',
      'p_guest',
      'p_kids',
    ]);
    expect(excluded?.ok).toBe(true);
    if (excluded?.ok) {
      expect(excluded.value.excludedProfileIds).toEqual(['p_guest', 'p_kids']);
      expect(excluded.value.allowLegacyTls).toBe(true);
    }

    const stored = await getSource(s.db, 'src_p7');
    expect(stored?.settings.guideUrl).toBe('{{g:url}}');
    expect(stored?.settings.transport?.allowLegacyTls).toBe(true);
    expect(stored?.settings.excludedProfileIds).toEqual(['p_guest', 'p_kids']);

    const renamed = await catalog.renameSource?.('src_p7', 'Kids Filtered');
    expect(renamed?.ok).toBe(true);
    if (renamed?.ok) {
      expect(renamed.value.name).toBe('Kids Filtered');
      expect(renamed.value.excludedProfileIds).toEqual(['p_guest', 'p_kids']);
    }

    const cleared = await catalog.setSourceExcludedProfiles?.('src_p7', []);
    expect(cleared?.ok).toBe(true);
    if (cleared?.ok) {
      expect(cleared.value.excludedProfileIds).toEqual([]);
    }

    const listed = await catalog.listSources();
    expect(listed[0]?.name).toBe('Kids Filtered');
    expect(listed[0]?.excludedProfileIds).toEqual([]);

    await catalog.close();
  });
});

describe('cross-device explicit source id preservation (Wave P9)', () => {
  it('preserves explicit id across Xtream, M3U, Stalker, and CatalogService.addSource and rejects invalid/duplicate ids', async () => {
    const s = await setup();
    const xt = await addXtreamSource(
      { id: 'sync_xt.1-a', name: 'X', server: 'https://p.example', username: USER, password: PW },
      s.deps,
    );
    const m3 = await addM3uSource(
      { id: 'sync_m3u.2-b', name: 'M', playlistUrl: 'https://h.example/list.m3u' },
      s.deps,
    );
    const st = await addStalkerSource(
      {
        id: 'sync_st.3-c',
        name: 'S',
        portalUrl: 'https://st.example/c/',
        mac: '00:1A:79:11:22:33',
      },
      s.deps,
    );
    expect(xt.ok && xt.value.id).toBe('sync_xt.1-a');
    expect(m3.ok && m3.value.id).toBe('sync_m3u.2-b');
    expect(st.ok && st.value.id).toBe('sync_st.3-c');
    expect(s.secrets.dump()[secretKey('sync_xt.1-a', 'xtream')]).toBeDefined();
    expect(s.secrets.dump()[secretKey('sync_m3u.2-b', 'playlist')]).toBeDefined();
    expect(s.secrets.dump()[secretKey('sync_st.3-c', 'stalker')]).toBeDefined();
    for (const badId of ['', '   ', 'bad/id', 'bad:id', 'a'.repeat(129)]) {
      expect(
        await addM3uSource(
          { id: badId, name: 'Bad', playlistUrl: 'https://h.example/a.m3u' },
          s.deps,
        ),
      ).toEqual({ ok: false, error: { category: 'storage', code: 'invalid-source-id' } });
    }
    const dup = await addM3uSource(
      { id: 'sync_m3u.2-b', name: 'Dup', playlistUrl: 'https://h.example/b.m3u' },
      s.deps,
    );
    expect(dup).toEqual({ ok: false, error: { category: 'storage', code: 'source-write-failed' } });
    const catalog = createCatalogService({
      db: s.db,
      secrets: s.secrets,
      scheduler: countingScheduler(),
      http: { get: async () => Promise.reject(new Error('unused')) },
      clock: () => 9_000,
    });
    const viaCatalog = await catalog.addSource({
      kind: 'm3u',
      id: 'catalog_sync_4',
      name: 'Synced',
      playlistUrl: 'https://h.example/sync.m3u',
    });
    expect(viaCatalog.ok && viaCatalog.value.id).toBe('catalog_sync_4');
    await catalog.close();
  });
});

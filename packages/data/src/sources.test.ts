import { describe, expect, it } from 'vitest';
import { openCatalog } from './migrate';
import {
  addM3uSource,
  addXtreamSource,
  getSource,
  removeSecrets,
  removeSource,
  secretKey,
  TABLES_BY_SOURCE,
  updateSourceSettings,
} from './sources';
import { memorySecrets, testDb } from './test-db';

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

describe('removeSource', () => {
  it('deletes the row, every catalog row of the source and all secrets', async () => {
    const s = await setup();
    await addXtreamSource(
      { name: 'A', server: 'https://p.example', username: USER, password: PW },
      s.deps,
    );
    await addM3uSource({ name: 'B', playlistUrl: 'https://h.example/a.m3u' }, s.deps);
    const tables: Record<string, string> = {
      import_runs: "(id, source_id, kind, started_at, status) VALUES (?, ?, 'catalog', 1, 'ok')",
      categories:
        "(source_id, kind, provider_id, name, name_fold, position, run_id) VALUES (?, 'live', 'c', 'n', 'n', 0, 1)",
      live: "(source_id, key, name, name_fold, run_id) VALUES (?, 'k', 'n', 'n', 1)",
      movies: "(source_id, key, name, name_fold, run_id) VALUES (?, 'k', 'n', 'n', 1)",
      series: "(source_id, key, name, name_fold, run_id) VALUES (?, 'k', 'n', 'n', 1)",
      episodes: "(source_id, key, series_key, run_id) VALUES (?, 'k', 's', 1)",
      placements:
        "(source_id, kind, item_key, category_id, position, run_id) VALUES (?, 'live', 'k', 'c', 0, 1)",
      guide_channels: "(source_id, guide_id, name, name_fold, run_id) VALUES (?, 'g', 'n', 'n', 1)",
      channel_guide: "(source_id, channel_key, guide_id) VALUES (?, 'k', 'g')",
      programmes: "(source_id, guide_id, start, stop, title, run_id) VALUES (?, 'g', 1, 2, 't', 1)",
    };
    let runId = 1;
    for (const id of ['src1', 'src2']) {
      for (const [table, rest] of Object.entries(tables)) {
        if (table === 'import_runs') {
          await s.db.run(`INSERT INTO import_runs ${rest}`, [runId, id]);
          runId += 1;
        } else {
          await s.db.run(`INSERT INTO ${table} ${rest}`, [id]);
        }
      }
    }
    await removeSource('src1', s.deps);
    expect(await getSource(s.db, 'src1')).toBeUndefined();
    for (const table of Object.keys(tables)) {
      const rows = await s.db.all<{ source_id: string }>(`SELECT source_id FROM ${table}`);
      expect(rows.map((r) => r.source_id)).toEqual(['src2']);
    }
    const keys = Object.keys(s.secrets.dump());
    expect(keys.filter((k) => k.startsWith('source.src1.'))).toEqual([]);
    expect(keys.filter((k) => k.startsWith('source.src2.')).length).toBeGreaterThan(0);
    expect(await getSource(s.db, 'src2')).toBeDefined();
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
});

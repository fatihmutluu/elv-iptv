import type { HttpClient, SecretStore, SqlDriver } from '@elv/domain';
import { ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { loadDrmSpecs } from './drm-secret-store';
import { importCatalog } from './import-xtream';
import { openCatalog } from './migrate';
import { addM3uSource, secretKey } from './sources';
import { testDb } from './test-db';

const CLEARKEY_KID = ['0123456789abcdef', '0123456789abcdef'].join('');
const CLEARKEY_KEY = ['fedcba9876543210', 'fedcba9876543210'].join('');
const JWK_KID = 'ClearKeyJwkKidToken123';
const JWK_KEY = 'ClearKeyJwkKeyToken456';
const WV_LICENSE_URL = 'https://drm-license.example.test/widevine/v1?tenant=secret-tenant-99';
const WV_AUTH_TOKEN = 'Bearer super-secret-widevine-token-xyz';
const PR_LICENSE_URL = 'https://drm-license.example.test/playready/rights';

function drmPlaylist(): string {
  const jwk = JSON.stringify({
    keys: [{ kty: 'oct', kid: JWK_KID, k: JWK_KEY }],
  });
  return [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="ck.live" group-title="DRM Live",ClearKey Live',
    '#KODIPROP:inputstream.adaptive.license_type=org.w3.clearkey',
    `#KODIPROP:inputstream.adaptive.license_key=${CLEARKEY_KID}:${CLEARKEY_KEY}`,
    'https://cdn.example.test/live/ck.mpd#https://backup.example.test/live/ck.mpd',
    '#EXTINF:-1 tvg-id="wv.movie" group-title="DRM Films",Widevine Film',
    '#KODIPROP:inputstream.adaptive.license_type=com.widevine.alpha',
    `#KODIPROP:inputstream.adaptive.license_key=${WV_LICENSE_URL}|Authorization=${encodeURIComponent(WV_AUTH_TOKEN)}&X-Tenant=elv-drm|R{SSM}|`,
    'https://cdn.example.test/movie/wv-film.mp4',
    '#EXTINF:-1 tvg-id="ck.jwk" group-title="DRM Live",ClearKey JWK Live',
    '#KODIPROP:inputstream.adaptive.license_type=clearkey',
    `#KODIPROP:inputstream.adaptive.license_key=${jwk}`,
    'https://cdn.example.test/live/ck-jwk.mpd',
    '#EXTINF:-1 tvg-id="pr.live" group-title="DRM Live",PlayReady Live',
    '#KODIPROP:inputstream.adaptive.license_type=com.microsoft.playready',
    `#KODIPROP:inputstream.adaptive.license_key=${PR_LICENSE_URL}`,
    'https://cdn.example.test/live/pr.mpd',
    '#EXTINF:-1 tvg-id="plain.live" group-title="Open Live",Plain Open Channel',
    'https://cdn.example.test/live/plain.m3u8',
    '',
  ].join('\n');
}

function plainPlaylist(): string {
  return [
    '#EXTM3U',
    '#EXTINF:-1 tvg-id="plain.live" group-title="Open Live",Plain Open Channel',
    'https://cdn.example.test/live/plain.m3u8',
    '',
  ].join('\n');
}

function makeMemorySecrets() {
  const data = new Map<string, string>();
  const gets: string[] = [];
  const store: SecretStore & { data: Map<string, string>; gets: string[] } = {
    data,
    gets,
    async get(key) {
      gets.push(key);
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
  return store;
}

function makeHttp(getBody: () => string): HttpClient {
  const utf8 = new TextEncoder();
  return {
    async get(url) {
      const bytes = utf8.encode(getBody());
      return ok({
        status: 200,
        headers: {},
        finalUrl: url,
        body: (async function* () {
          yield bytes;
        })(),
      });
    },
  };
}

async function dumpEntireSqliteDatabase(db: SqlDriver): Promise<string> {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const chunks: string[] = [];
  for (const { name } of tables) {
    // Skip FTS5 shadow/content tables that only mirror base tables or throw on direct select
    if (name.includes('_fts_')) continue;
    const rows = await db.all<Record<string, unknown>>(`SELECT * FROM "${name}"`);
    chunks.push(`${name}:${JSON.stringify(rows)}`);
  }
  return chunks.join('\n');
}

describe('M3U DRM import, zero-secret SQLite invariant & play-time resolution (#272)', () => {
  it('persists ZERO DRM secrets in SQLite, resolves StreamRequest.drm at play time, and omits drm on plain streams', async () => {
    const { db } = testDb();
    const secrets = makeMemorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    let currentBody = drmPlaylist();
    const service = createCatalogService({
      db,
      secrets,
      http: makeHttp(() => currentBody),
      scheduler: { yieldNow: async () => undefined },
      clock: () => 1_700_000_000_000,
      newId: () => 'drm1',
    });

    const added = await service.addSource({
      kind: 'm3u',
      name: 'DRM Provider',
      playlistUrl: 'https://provider.example.test/drm.m3u',
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    const imported = await service.importSource(added.value.id);
    expect(imported.ok).toBe(true);

    // 1. Dump EVERY SQLite table and prove ZERO DRM secrets exist anywhere in SQLite
    const sqliteDump = await dumpEntireSqliteDatabase(db);
    for (const secretValue of [
      CLEARKEY_KID,
      CLEARKEY_KEY,
      JWK_KID,
      JWK_KEY,
      WV_LICENSE_URL,
      'drm-license.example.test',
      WV_AUTH_TOKEN,
      'super-secret-widevine-token-xyz',
      'elv-drm',
      PR_LICENSE_URL,
    ]) {
      expect(sqliteDump).not.toContain(secretValue);
    }

    // 2. Verify item_drm_meta contains ONLY (source_id, item_key, scheme) for DRM items
    const metaRows = await db.all<{ source_id: string; item_key: string; scheme: string }>(
      'SELECT source_id, item_key, scheme FROM item_drm_meta ORDER BY item_key',
    );
    expect(metaRows).toHaveLength(4);
    expect(metaRows.map((r) => r.scheme).sort()).toEqual([
      'clearkey',
      'clearkey',
      'playready',
      'widevine',
    ]);

    const liveRows = await db.all<{ key: string; name: string }>('SELECT key, name FROM live');
    const movieRows = await db.all<{ key: string; name: string }>('SELECT key, name FROM movies');
    const ckLiveKey = liveRows.find((r) => r.name === 'ClearKey Live')?.key ?? '';
    const ckJwkKey = liveRows.find((r) => r.name === 'ClearKey JWK Live')?.key ?? '';
    const prLiveKey = liveRows.find((r) => r.name === 'PlayReady Live')?.key ?? '';
    const plainLiveKey = liveRows.find((r) => r.name === 'Plain Open Channel')?.key ?? '';
    const wvMovieKey = movieRows.find((r) => r.name === 'Widevine Film')?.key ?? '';

    // 3. Resolving non-DRM stream MUST omit `drm` and MUST NOT hit `source.drm1.drm_specs`
    secrets.gets.length = 0;
    const plainStream = await service.resolveStream(plainLiveKey);
    expect(plainStream.ok).toBe(true);
    if (!plainStream.ok) return;
    expect('drm' in plainStream.value).toBe(false);
    expect(secrets.gets).not.toContain(secretKey('drm1', 'drm_specs'));

    // 4. Resolve ClearKey (with backup alternate), JWK ClearKey, Widevine, and PlayReady streams
    const ckStream = await service.resolveStream(ckLiveKey);
    expect(ckStream.ok).toBe(true);
    if (!ckStream.ok) return;
    expect(ckStream.value.drm).toEqual({
      scheme: 'clearkey',
      clearKeys: [{ kid: CLEARKEY_KID, key: CLEARKEY_KEY }],
    });
    expect(ckStream.value.alternates?.[0]?.drm).toEqual({
      scheme: 'clearkey',
      clearKeys: [{ kid: CLEARKEY_KID, key: CLEARKEY_KEY }],
    });

    const wvStream = await service.resolveStream(wvMovieKey);
    expect(wvStream.ok).toBe(true);
    if (!wvStream.ok) return;
    expect(wvStream.value.drm).toEqual({
      scheme: 'widevine',
      licenseUrl: WV_LICENSE_URL,
      licenseHeaders: {
        Authorization: WV_AUTH_TOKEN,
        'X-Tenant': 'elv-drm',
      },
    });

    const jwkStream = await service.resolveStream(ckJwkKey);
    expect(jwkStream.ok).toBe(true);
    if (!jwkStream.ok) return;
    expect(jwkStream.value.drm).toEqual({
      scheme: 'clearkey',
      clearKeys: [{ kid: JWK_KID, key: JWK_KEY }],
    });

    const prStream = await service.resolveStream(prLiveKey);
    expect(prStream.ok).toBe(true);
    if (!prStream.ok) return;
    expect(prStream.value.drm).toEqual({
      scheme: 'playready',
      licenseUrl: PR_LICENSE_URL,
    });

    // Playtime cache avoided redundant SecretStore reads across all 4 DRM resolutions
    const drmGets = secrets.gets.filter((k) => k === secretKey('drm1', 'drm_specs'));
    expect(drmGets).toHaveLength(1);

    // 5. Re-importing a playlist with ZERO DRM items deletes stale drm_specs and item_drm_meta
    currentBody = plainPlaylist();
    const reimported = await service.importSource(added.value.id);
    expect(reimported.ok).toBe(true);
    expect(await db.all('SELECT * FROM item_drm_meta')).toEqual([]);
    expect(secrets.data.has(secretKey('drm1', 'drm_specs'))).toBe(false);

    // 6. Re-import DRM again then removeSource verifies full cleanup
    currentBody = drmPlaylist();
    expect((await service.importSource(added.value.id)).ok).toBe(true);
    expect(secrets.data.has(secretKey('drm1', 'drm_specs'))).toBe(true);
    expect((await db.all('SELECT * FROM item_drm_meta')).length).toBe(4);

    const removed = await service.removeSource(added.value.id);
    expect(removed.ok).toBe(true);
    expect(await db.all('SELECT * FROM item_drm_meta')).toEqual([]);
    expect(Array.from(secrets.data.keys())).toEqual([]);

    await service.close();
  });

  it('rolls back staged drm_specs cleanly when SQLite commit fails on first import and on re-import', async () => {
    const { db } = testDb();
    const secrets = makeMemorySecrets();
    expect((await openCatalog(db)).ok).toBe(true);

    const added = await addM3uSource(
      { name: 'Rollback M3U', playlistUrl: 'https://provider.example.test/rb.m3u' },
      { db, secrets, clock: () => 1_700_000_000_000, newId: () => 'rb1' },
    );
    expect(added.ok).toBe(true);

    let failCommit = true;
    const flakyDb: SqlDriver = {
      ...db,
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            ...tx,
            batch: async (sql, rows) => {
              if (failCommit && sql.includes('item_drm_meta')) {
                throw new Error('simulated sqlite commit failure');
              }
              return tx.batch(sql, rows);
            },
          }),
        ),
    };

    const deps = {
      db: flakyDb,
      secrets,
      http: makeHttp(() => drmPlaylist()),
      scheduler: { yieldNow: async () => undefined },
      clock: () => 1_700_000_000_000,
    };

    // First import fails during commit -> zero orphaned drm_specs and zero item_drm_meta rows
    const first = await importCatalog('rb1', deps);
    expect(first.ok).toBe(false);
    expect(await db.all('SELECT * FROM item_drm_meta')).toEqual([]);
    expect(secrets.data.has(secretKey('rb1', 'drm_specs'))).toBe(false);

    // Succeed once so valid DRM specs are stored
    failCommit = false;
    const second = await importCatalog('rb1', deps);
    expect(second.ok).toBe(true);
    const savedBefore = await loadDrmSpecs(secrets, 'rb1');
    expect(Object.keys(savedBefore)).toHaveLength(4);

    // Next re-import with modified Widevine URL fails during commit -> previous drm_specs restored!
    failCommit = true;
    const updatedDeps = {
      ...deps,
      http: makeHttp(() =>
        drmPlaylist().replace(WV_LICENSE_URL, 'https://new-lic.example.test/wv'),
      ),
    };
    const third = await importCatalog('rb1', updatedDeps);
    expect(third.ok).toBe(false);
    expect(await loadDrmSpecs(secrets, 'rb1')).toEqual(savedBefore);
  });
});

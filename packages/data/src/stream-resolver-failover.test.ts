import { elvError, err, type HttpClient, type HttpRequestOptions, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createCatalogService } from './catalog';
import { discoverSourceCategories } from './discover-categories';
import { createFailoverGroup } from './failover-groups-repo';
import { importGuide } from './import-guide';
import { extinf } from './import-test-helpers';
import { importCatalog, openClient } from './import-xtream';
import { openCatalog } from './migrate';
import {
  addLocalM3uSource,
  addM3uSource,
  addXtreamSource,
  getSource,
  secretKey,
  updateSourceSettings,
} from './sources';
import { createPlaytimeResolverCache } from './stream-resolver';
import { memorySecrets, testDb } from './test-db';

const encode = (text: string): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    yield new TextEncoder().encode(text);
  },
});

const noopScheduler = { yieldNow: async () => undefined };

describe('multi-source failover, split Xtream mirrors & network transport (#157, #317, #172)', () => {
  it('resolves 3-member multi-source failover alternates in position order with distinct per-source metadata', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();
    let seq = 0;
    const addDeps = { db, secrets, clock: () => 1_000, newId: () => `src${++seq}` };

    const s1 = await addM3uSource(
      {
        name: 'Provider 1',
        playlistUrl: 'http://p1.example/list.m3u',
        transport: {
          userAgent: 'Agent-1',
          dnsFamily: 'ipv4',
          hostOverride: '198.51.100.10',
          allowLegacyTls: true,
        },
      },
      addDeps,
    );
    const s2 = await addM3uSource(
      {
        name: 'Provider 2',
        playlistUrl: 'http://p2.example/list.m3u',
        transport: {
          userAgent: 'Agent-2',
          dnsFamily: 'ipv6',
          hostOverride: '[2001:db8::2]',
        },
      },
      addDeps,
    );
    const s3 = await addM3uSource(
      {
        name: 'Provider 3',
        playlistUrl: 'http://p3.example/list.m3u',
        transport: {
          userAgent: 'Agent-3',
          dnsFamily: 'system',
        },
      },
      addDeps,
    );
    expect(s1.ok && s2.ok && s3.ok).toBe(true);
    if (!s1.ok || !s2.ok || !s3.ok) return;

    await updateSourceSettings(db, s1.value.id, {
      ...s1.value.settings,
      accountMeta: { maxConnections: 1 },
    });
    await updateSourceSettings(db, s2.value.id, {
      ...s2.value.settings,
      accountMeta: { maxConnections: 3 },
    });
    await updateSourceSettings(db, s3.value.id, {
      ...s3.value.settings,
      accountMeta: { maxConnections: 5 },
    });

    const http: HttpClient = {
      async get(url) {
        if (url.includes('p1.example')) {
          return ok({
            status: 200,
            headers: {},
            body: encode(`#EXTM3U\n${extinf('News HD', 'http://p1.example/live/news.ts')}`),
          });
        }
        if (url.includes('p2.example')) {
          return ok({
            status: 200,
            headers: {},
            body: encode(`#EXTM3U\n${extinf('News FHD', 'http://p2.example/live/news.ts')}`),
          });
        }
        if (url.includes('p3.example')) {
          return ok({
            status: 200,
            headers: {},
            body: encode(`#EXTM3U\n${extinf('News 4K', 'http://p3.example/live/news.ts')}`),
          });
        }
        return err(elvError('network', 'http-404'));
      },
    };
    const importDeps = { db, secrets, http, scheduler: noopScheduler, clock: () => 2_000 };
    expect((await importCatalog(s1.value.id, importDeps)).ok).toBe(true);
    expect((await importCatalog(s2.value.id, importDeps)).ok).toBe(true);
    expect((await importCatalog(s3.value.id, importDeps)).ok).toBe(true);

    const k1 = (
      await db.all<{ key: string }>('SELECT key FROM live WHERE source_id = ?', [s1.value.id])
    )[0]?.key;
    const k2 = (
      await db.all<{ key: string }>('SELECT key FROM live WHERE source_id = ?', [s2.value.id])
    )[0]?.key;
    const k3 = (
      await db.all<{ key: string }>('SELECT key FROM live WHERE source_id = ?', [s3.value.id])
    )[0]?.key;
    expect(k1 && k2 && k3).toBeTruthy();
    if (!k1 || !k2 || !k3) return;

    // Group priority order: src1 -> src3 -> src2
    const grp = await createFailoverGroup(db, {
      id: 'fg-news',
      name: 'News',
      channelKeys: [k1, k3, k2],
      nowMs: 3_000,
    });
    expect(grp.ok).toBe(true);

    const cache = createPlaytimeResolverCache({ db, secrets, http });
    const resolved = await cache.resolveStream(k1);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.value.url).toBe('http://p1.example/live/news.ts');
    expect(resolved.value.sourceId).toBe(s1.value.id);
    expect(resolved.value.channelKey).toBe(k1);
    expect(resolved.value.maxConnections).toBe(1);
    expect(resolved.value.allowLegacyTls).toBe(true);
    expect(resolved.value.dnsFamily).toBe('ipv4');
    expect(resolved.value.hostOverride).toBe('198.51.100.10');
    expect(resolved.value.headers['user-agent']).toBe('Agent-1');

    // Alternates follow failover group position order: k3 first, then k2
    expect(resolved.value.alternates).toHaveLength(2);
    const [alt1, alt2] = resolved.value.alternates ?? [];
    expect(alt1?.url).toBe('http://p3.example/live/news.ts');
    expect(alt1?.sourceId).toBe(s3.value.id);
    expect(alt1?.channelKey).toBe(k3);
    expect(alt1?.maxConnections).toBe(5);
    expect(alt1?.dnsFamily).toBe('system');
    expect(alt1?.hostOverride).toBeUndefined();
    expect(alt1?.headers['user-agent']).toBe('Agent-3');

    expect(alt2?.url).toBe('http://p2.example/live/news.ts');
    expect(alt2?.sourceId).toBe(s2.value.id);
    expect(alt2?.channelKey).toBe(k2);
    expect(alt2?.maxConnections).toBe(3);
    expect(alt2?.dnsFamily).toBe('ipv6');
    expect(alt2?.hostOverride).toBe('2001:db8::2');
    expect(alt2?.headers['user-agent']).toBe('Agent-2');
    expect(alt2?.accountKey).not.toBe(resolved.value.accountKey);

    // Missing secret on one sibling member is cleanly skipped without failing primary resolve
    await secrets.delete(secretKey(s3.value.id, 'urlvars'));
    cache.evict(s3.value.id);
    await db.run(
      "UPDATE live SET url_template = 'http://p3.example/{{missing}}/1.ts' WHERE key = ?",
      [k3],
    );
    const partial = await cache.resolveStream(k1);
    expect(partial.ok).toBe(true);
    if (!partial.ok) return;
    expect(partial.value.alternates?.map((a) => a.channelKey)).toEqual([k2]);
  });

  it('stores Xtream backupServers strictly in SecretStore, resolves mirror alternates, switches stream mirror independently of API, and recovers after cooldown', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();
    let now = 10_000;
    const clock = () => now;

    const added = await addXtreamSource(
      {
        name: 'Xtream Mirrors',
        server: 'http://primary.xt.example',
        backupServers: ['http://backup1.xt.example', 'http://backup2.xt.example'],
        username: 'u1',
        password: 'p1',
        transport: { dnsFamily: 'ipv4', hostOverride: '203.0.113.5' },
      },
      { db, secrets, clock, newId: () => 'xt1' },
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;

    // Zero backup URLs or credentials in SQLite!
    const rawRows = await db.all<{ settings_json: string }>(
      'SELECT settings_json FROM sources WHERE id = ?',
      ['xt1'],
    );
    const settingsJson = rawRows[0]?.settings_json ?? '';
    expect(settingsJson).not.toContain('primary.xt.example');
    expect(settingsJson).not.toContain('backup1.xt.example');
    expect(settingsJson).not.toContain('backup2.xt.example');
    expect(settingsJson).not.toContain('u1');
    expect(settingsJson).not.toContain('p1');

    // Insert a live Xtream channel
    await db.run(
      `INSERT INTO live (source_id, key, provider_id, name, name_fold, run_id)
       VALUES ('xt1', 'x:xt1:live:42', '42', 'Mirror News', 'mirror news', 1)`,
    );

    const http: HttpClient = { get: async () => err(elvError('network', 'not-used')) };
    const svc = createCatalogService({
      db,
      secrets,
      scheduler: noopScheduler,
      http,
      clock,
    });

    // Primary first + 2 backup mirrors as alternates
    const r1 = await svc.resolveStream('x:xt1:live:42');
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    expect(r1.value.url).toBe('http://primary.xt.example/live/u1/p1/42.ts');
    expect(r1.value.dnsFamily).toBe('ipv4');
    expect(r1.value.hostOverride).toBe('203.0.113.5');
    expect(r1.value.alternates?.map((a) => a.url)).toEqual([
      'http://backup1.xt.example/live/u1/p1/42.ts',
      'http://backup2.xt.example/live/u1/p1/42.ts',
    ]);
    expect(r1.value.alternates?.[0]?.dnsFamily).toBe('ipv4');
    expect(r1.value.alternates?.[0]?.hostOverride).toBe('203.0.113.5');

    // Report stream failure on primary -> stream switches to backup1 while API stays on primary
    svc.reportStreamOutcome?.('xt1', 'http://primary.xt.example/live/u1/p1/42.ts', false);
    const r2 = await svc.resolveStream('x:xt1:live:42');
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    expect(r2.value.url).toBe('http://backup1.xt.example/live/u1/p1/42.ts');

    // API client opened from secret still targets primary API server (independent slots!)
    const sourceRecord = await getSource(db, 'xt1');
    expect(sourceRecord).toBeDefined();
    if (sourceRecord) {
      const apiClient = await openClient(sourceRecord, {
        db,
        secrets,
        http,
        scheduler: noopScheduler,
        clock,
      });
      expect(apiClient.ok).toBe(true);
      if (apiClient.ok) {
        expect(apiClient.value.activeApiServer()).toBe('http://primary.xt.example');
      }
    }

    // Advance fake clock past default 5-minute primaryCooldownMs (300_000 ms)
    now += 300_001;
    const r3 = await svc.resolveStream('x:xt1:live:42');
    expect(r3.ok).toBe(true);
    if (!r3.ok) return;
    expect(r3.value.url).toBe('http://primary.xt.example/live/u1/p1/42.ts');

    // Confirming stream success on primary promotes primary and clears cooldown
    svc.reportStreamOutcome?.('xt1', 'http://primary.xt.example/live/u1/p1/42.ts', true);
    now += 1_000;
    const r4 = await svc.resolveStream('x:xt1:live:42');
    expect(r4.ok).toBe(true);
    if (!r4.ok) return;
    expect(r4.value.url).toBe('http://primary.xt.example/live/u1/p1/42.ts');

    await svc.close();
  });

  it('rejects invalid hostOverride on add/update and forwards valid dnsFamily & hostOverride on HTTP fetches', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();
    let seq = 0;
    const addDeps = { db, secrets, clock: () => 1_000, newId: () => `net${++seq}` };

    // Reject hostname / scheme / port as hostOverride
    const badXt = await addXtreamSource(
      {
        name: 'Bad Xtream',
        server: 'http://xt.example',
        username: 'u',
        password: 'p',
        transport: { hostOverride: 'not-an-ip.example' },
      },
      addDeps,
    );
    expect(badXt.ok).toBe(false);
    if (!badXt.ok) expect(badXt.error.code).toBe('invalid-host-override');

    const badM3u = await addM3uSource(
      {
        name: 'Bad M3U',
        playlistUrl: 'http://m3u.example/list.m3u',
        transport: { hostOverride: '127.0.0.1:8080' },
      },
      addDeps,
    );
    expect(badM3u.ok).toBe(false);
    if (!badM3u.ok) expect(badM3u.error.code).toBe('invalid-host-override');

    const badLocal = await addLocalM3uSource(
      {
        name: 'Bad Local',
        bytes: new TextEncoder().encode('#EXTM3U\n'),
        transport: { hostOverride: 'https://1.2.3.4' },
      },
      {
        ...addDeps,
        localPlaylistStore: {
          write: async () => undefined,
          openRead: async () => undefined,
          remove: async () => undefined,
        },
      },
    );
    expect(badLocal.ok).toBe(false);
    if (!badLocal.ok) expect(badLocal.error.code).toBe('invalid-host-override');

    // Valid source + reject invalid hostOverride on updateSourceSettings
    const valid = await addM3uSource(
      {
        name: 'Good M3U',
        playlistUrl: 'http://good.example/list.m3u',
        guideUrl: 'http://good.example/epg.xml',
        transport: { dnsFamily: 'ipv4', hostOverride: '198.51.100.77' },
      },
      addDeps,
    );
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;

    const badUpdate = await updateSourceSettings(db, valid.value.id, {
      ...valid.value.settings,
      transport: { dnsFamily: 'ipv6', hostOverride: 'evil.example' },
    });
    expect(badUpdate.ok).toBe(false);
    if (!badUpdate.ok) expect(badUpdate.error.code).toBe('invalid-host-override');

    // Existing valid settings remain untouched after rejected update
    const afterBad = await getSource(db, valid.value.id);
    expect(afterBad?.settings.transport).toEqual({
      dnsFamily: 'ipv4',
      hostOverride: '198.51.100.77',
    });

    // Verify dnsFamily & hostOverride are forwarded on M3U import, guide import, and category discovery
    const capturedOpts: Array<{ url: string; options: HttpRequestOptions | undefined }> = [];
    const http: HttpClient = {
      async get(url, options) {
        capturedOpts.push({ url, options });
        if (url.includes('epg.xml')) {
          return ok({
            status: 200,
            headers: {},
            body: encode('<tv><channel id="c1"><display-name>Ch 1</display-name></channel></tv>'),
          });
        }
        return ok({
          status: 200,
          headers: {},
          body: encode(`#EXTM3U\n${extinf('Ch 1', 'http://good.example/1.ts', 'tvg-id="c1"')}`),
        });
      },
    };
    const importDeps = { db, secrets, http, scheduler: noopScheduler, clock: () => 2_000 };

    expect((await discoverSourceCategories(valid.value.id, importDeps)).ok).toBe(true);
    expect((await importCatalog(valid.value.id, importDeps)).ok).toBe(true);
    expect((await importGuide(valid.value.id, importDeps)).ok).toBe(true);

    expect(capturedOpts.length).toBeGreaterThanOrEqual(3);
    for (const call of capturedOpts) {
      expect(call.options?.dnsFamily).toBe('ipv4');
      expect(call.options?.hostOverride).toBe('198.51.100.77');
    }

    // Verify CatalogService.listSources surfaces dnsFamily & hostOverride on SourceRow
    const svc = createCatalogService({
      db,
      secrets,
      scheduler: noopScheduler,
      http,
      clock: () => 3_000,
    });
    const listed = await svc.listSources();
    expect(listed[0]?.dnsFamily).toBe('ipv4');
    expect(listed[0]?.hostOverride).toBe('198.51.100.77');

    // Verify CatalogService.updateSourceSettings rejects invalid hostOverride cleanly
    const svcBad = await svc.updateSourceSettings?.(valid.value.id, {
      transport: { hostOverride: 'bad-host' },
    });
    expect(svcBad && !svcBad.ok).toBe(true);

    // Clearing hostOverride via empty string and resetting dnsFamily to system works cleanly
    const svcClear = await svc.updateSourceSettings?.(valid.value.id, {
      transport: { dnsFamily: 'system', hostOverride: '  ' },
    });
    expect(svcClear?.ok).toBe(true);
    const afterClear = await svc.listSources();
    expect(afterClear[0]?.dnsFamily).toBe('system');
    expect(afterClear[0]?.hostOverride).toBeUndefined();
    await svc.close();
  });

  it('updates Xtream backupServers strictly in SecretStore via updateXtreamBackupServers (#317)', async () => {
    const { db } = testDb();
    expect((await openCatalog(db)).ok).toBe(true);
    const secrets = memorySecrets();
    const added = await addXtreamSource(
      {
        name: 'Xt',
        server: 'http://main.xt.example',
        username: 'u',
        password: 'p',
      },
      { db, secrets, clock: () => 1_000, newId: () => 'xt2' },
    );
    expect(added.ok).toBe(true);

    const { updateXtreamBackupServers } = await import('./sources');
    expect(
      (
        await updateXtreamBackupServers('xt2', [' http://m1.xt.example ', 'http://m1.xt.example'], {
          secrets,
        })
      ).ok,
    ).toBe(true);
    const stored = JSON.parse((await secrets.get(secretKey('xt2', 'xtream'))) ?? '{}') as {
      backupServers?: string[];
    };
    expect(stored.backupServers).toEqual(['http://m1.xt.example']);

    // Missing secret returns storage/secret-missing
    const missing = await updateXtreamBackupServers('nope', ['http://m2.xt.example'], { secrets });
    expect(missing.ok).toBe(false);
  });
});

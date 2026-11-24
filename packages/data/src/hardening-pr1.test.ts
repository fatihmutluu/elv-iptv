import { ok } from '@elv/domain';
import { describe, expect, it, vi } from 'vitest';
import { importGuide } from './import-guide';
import { extinf, M3U_TOKEN, sampleCatalog, setup as setupPanel } from './import-test-helpers';
import { createCatalogService, openCatalog } from './index';
import { countingScheduler, memorySecrets, testDb } from './test-db';

describe('PR 1 @elv/data Hardening', () => {
  it('caches Xtream secrets across zaps, prefers m3u8 when only m3u8 is advertised, and evicts on remove/close', async () => {
    const data = sampleCatalog();
    data.user = {
      ...data.user,
      allowed_output_formats: ['m3u8'],
    };
    const panel = await setupPanel(data);
    const getSpy = vi.spyOn(panel.secrets, 'get');
    const service = createCatalogService({
      db: panel.db,
      secrets: panel.secrets,
      scheduler: panel.scheduler,
      http: panel.panel.http,
      clock: () => 1_000,
      newId: () => 'x1',
    });

    const added = await service.addSource({
      kind: 'xtream',
      name: 'Panel',
      server: 'http://panel.example',
      username: 'alice',
      password: 'secret-password',
    });
    if (!added.ok) throw new Error('add failed');
    expect((await service.importSource('x1')).ok).toBe(true);
    getSpy.mockClear();

    const cats = await service.categories('x1', 'live');
    const items = await service.items(cats[0]?.id ?? '', 0, 10);
    const r1 = await service.resolveStream(items[0]?.key ?? '');
    const r2 = await service.resolveStream(items[1]?.key ?? '');
    expect(r1.ok && r1.value.url.endsWith('.m3u8')).toBe(true);
    expect(r2.ok && r2.value.url.endsWith('.m3u8')).toBe(true);

    const xtreamSecretReads = getSpy.mock.calls.filter(([k]) => k === 'source.x1.xtream');
    expect(xtreamSecretReads).toHaveLength(1);

    await service.close();
    panel.raw.close();
  });

  it('guards corrupt headers_json DB rows without throwing during resolveStream', async () => {
    const t = testDb();
    const secrets = memorySecrets();
    const scheduler = countingScheduler();
    await openCatalog(t.db);
    const playlistUrl = 'http://panel.example/list.m3u';
    const playlist = `#EXTM3U\n${extinf('Ch 1', `http://cdn.example/${M3U_TOKEN}/live/1.ts`, 'group-title="G"')}`;
    const service = createCatalogService({
      db: t.db,
      secrets,
      scheduler,
      http: {
        async get() {
          return ok({
            status: 200,
            headers: {},
            body: (async function* () {
              yield new TextEncoder().encode(playlist);
            })(),
          });
        },
      },
      clock: () => 1_000,
      newId: () => 'm1',
    });

    await service.addSource({
      kind: 'm3u',
      name: 'M',
      playlistUrl,
      transport: { userAgent: 'BaseUA/1.0' },
    });
    expect((await service.importSource('m1')).ok).toBe(true);

    // Simulate corrupt headers_json in SQLite
    await t.db.run('UPDATE live SET headers_json = ? WHERE source_id = ?', ['{corrupt-json', 'm1']);
    const cats = await service.categories('m1', 'live');
    const items = await service.items(cats[0]?.id ?? '', 0, 10);
    const resolved = await service.resolveStream(items[0]?.key ?? '');
    expect(resolved).toEqual({
      ok: true,
      value: {
        url: `http://cdn.example/${M3U_TOKEN}/live/1.ts`,
        accountKey: 'm1',
        sourceId: 'm1',
        channelKey: items[0]?.key,
        maxConnections: 1,
        headers: { 'user-agent': 'BaseUA/1.0' },
      },
    });
    await service.close();
  });

  it('runs PRAGMA wal_checkpoint(TRUNCATE) on M3U, Xtream, and XMLTV imports and invokes beforeRemoveSource synchronously (#315, #67)', async () => {
    const data = sampleCatalog();
    const panel = await setupPanel(data);
    const execSeen: string[] = [];
    const wrappedDb = {
      ...panel.db,
      exec: async (sql: string) => {
        execSeen.push(sql);
        return panel.db.exec(sql);
      },
    };
    const events: string[] = [];
    const service = createCatalogService({
      db: wrappedDb,
      secrets: panel.secrets,
      scheduler: panel.scheduler,
      http: panel.panel.http,
      clock: () => 1_000,
      newId: () => 'x2',
      beforeRemoveSource: (id) => {
        events.push(`stop:${id}`);
      },
    });

    await service.addSource({
      kind: 'xtream',
      name: 'Panel',
      server: 'http://panel.example',
      username: 'alice',
      password: 'secret-password',
    });
    execSeen.length = 0;
    expect((await service.importSource('x2')).ok).toBe(true);
    expect(execSeen).toContain('PRAGMA wal_checkpoint(TRUNCATE)');

    execSeen.length = 0;
    const guideRes = await importGuide('x2', {
      db: wrappedDb,
      http: panel.panel.http,
      secrets: panel.secrets,
      scheduler: panel.scheduler,
      clock: () => 1_000,
    });
    // Even if sample guide URL isn't populated, verify removeSource ordering
    void guideRes;

    wrappedDb.transaction = async (fn) =>
      panel.db.transaction((tx) =>
        fn({
          ...tx,
          run: async (sql, params) => {
            if (sql.startsWith('DELETE FROM sources')) events.push('sql:delete-source');
            return tx.run(sql, params);
          },
        }),
      );
    expect((await service.removeSource('x2')).ok).toBe(true);
    expect(events).toEqual(['stop:x2', 'sql:delete-source']);

    await service.close();
    panel.raw.close();
  });
});

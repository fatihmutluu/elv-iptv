import { describe, expect, it } from 'vitest';
import { extinf, setupM3u } from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { VarBook } from './m3u-templating';
import { buildFtsQuery, escapeLikePattern, querySearch } from './search';
import { secretKey } from './sources';
import { createPlaytimeResolverCache } from './stream-resolver';
import { memorySecrets } from './test-db';
import { readUrlVars } from './urlvars-store';

describe('packages/data security fuzz & hardening', () => {
  it('blocks prototype pollution from hostile #EXTHTTP / headers_json keys during resolveStream', async () => {
    const e = await setupM3u(
      '#EXTM3U\n' +
        '#EXTINF:-1 group-title="Live",News 1\n' +
        '#EXTHTTP:{"__proto__":"polluted","constructor":"ctor","prototype":"proto","X-Custom":"ok"}\n' +
        'http://sim.test/live/demo/pass/1001.ts\n',
    );
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    const row = (await e.db.all<{ key: string }>('SELECT key FROM live LIMIT 1'))[0];
    expect(row).toBeDefined();

    // Also inject raw JSON directly into headers_json to test defense-in-depth at play time
    await e.db.run('UPDATE live SET headers_json = ? WHERE key = ?', [
      '{"other":{"__proto__":"evil","constructor":"evil","prototype":"evil","X-Safe":"val"}}',
      row?.key ?? '',
    ]);

    const cache = createPlaytimeResolverCache({
      db: e.db,
      secrets: e.secrets,
      http: e.deps.http,
    });
    const res = await cache.resolveStream(row?.key ?? '');
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(Object.getPrototypeOf(res.value.headers)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(res.value.headers, '__proto__')).toBe(false);
    expect(Object.hasOwn(res.value.headers, 'constructor')).toBe(false);
    expect(Object.hasOwn(res.value.headers, 'prototype')).toBe(false);
    expect(res.value.headers['x-safe']).toBe('val');
  });

  it('uses null-prototype maps and ignores prototype-polluting keys in urlvars-store (single and sharded)', async () => {
    const secrets = memorySecrets();
    const rootKey = secretKey('s1', 'urlvars');

    // Single-chunk hostile payload
    await secrets.set(
      rootKey,
      '{"__proto__":{"polluted":true},"constructor":"bad","prototype":"bad","v0":"tok1","num":123}',
    );
    const single = await readUrlVars({ secrets }, 's1');
    expect(Object.getPrototypeOf(single)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.hasOwn(single, '__proto__')).toBe(false);
    expect(Object.hasOwn(single, 'constructor')).toBe(false);
    expect(Object.hasOwn(single, 'prototype')).toBe(false);
    expect(Object.hasOwn(single, 'num')).toBe(false);
    expect(single.v0).toBe('tok1');

    // Multi-chunk hostile payload
    await secrets.set(rootKey, JSON.stringify({ __chunks: 2 }));
    await secrets.set(
      `${rootKey}.0`,
      '{"__proto__":"evil","constructor":"evil","prototype":"evil","a":"1"}',
    );
    await secrets.set(`${rootKey}.1`, '{"__proto__":{"pwn":1},"b":"2"}');
    const sharded = await readUrlVars({ secrets }, 's1');
    expect(Object.getPrototypeOf(sharded)).toBeNull();
    expect(({} as Record<string, unknown>).pwn).toBeUndefined();
    expect(Object.hasOwn(sharded, '__proto__')).toBe(false);
    expect(Object.hasOwn(sharded, 'constructor')).toBe(false);
    expect(Object.hasOwn(sharded, 'prototype')).toBe(false);
    expect(sharded.a).toBe('1');
    expect(sharded.b).toBe('2');
  });

  it('uses null-prototype maps and strips prototype keys in VarBook', () => {
    const hostileSeed = JSON.parse(
      '{"__proto__":"bad","constructor":"bad","prototype":"bad","v0":"ok"}',
    ) as Record<string, string>;
    const book = new VarBook(hostileSeed);
    expect(Object.getPrototypeOf(book.vars)).toBeNull();
    expect(Object.hasOwn(book.vars, '__proto__')).toBe(false);
    expect(Object.hasOwn(book.vars, 'constructor')).toBe(false);
    expect(Object.hasOwn(book.vars, 'prototype')).toBe(false);
    expect(book.vars.v0).toBe('ok');

    const hostileVars = JSON.parse(
      '{"__proto__":"bad2","constructor":"bad2","prototype":"bad2","v1":"ok2"}',
    ) as Record<string, string>;
    const tpl = book.absorb({ template: 'http://sim.test/{{v1}}/1.ts', vars: hostileVars });
    expect(tpl).toBe('http://sim.test/{{v1}}/1.ts');
    expect(Object.hasOwn(book.vars, '__proto__')).toBe(false);
    expect(Object.hasOwn(book.vars, 'constructor')).toBe(false);
    expect(Object.hasOwn(book.vars, 'prototype')).toBe(false);
    expect(book.vars.v1).toBe('ok2');
  });

  it('rejects dangerous non-playback URL schemes at play time in resolveStream and filters them from alternates', async () => {
    const e = await setupM3u(`#EXTM3U\n${extinf('Ch 1', 'http://sim.test/live/demo/pass/1.ts')}`);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    const row = (await e.db.all<{ key: string }>('SELECT key FROM live LIMIT 1'))[0];
    const itemKey = row?.key ?? '';

    const cache = createPlaytimeResolverCache({
      db: e.db,
      secrets: e.secrets,
      http: e.deps.http,
    });

    const disallowed = [
      'file:///etc/passwd',
      'file://localhost/C:/Windows/win.ini',
      'javascript:alert(1)',
      'javascript://sim.test/%0aalert(1)',
      'data:text/html,<script>alert(1)</script>',
      'blob:https://sim.test/uuid',
      'content://com.example/secret',
      'about:blank',
      'ftp://sim.test/stream.ts',
      'http://sim.test/bad\r\nurl',
      '\r\nhttp://sim.test/live/1.ts\r\n',
      '\thttp://sim.test/live/1.ts',
      'http:///path',
      'https:///path',
    ];

    for (const badUrl of disallowed) {
      await e.db.run('UPDATE live SET url_template = ? WHERE key = ?', [badUrl, itemKey]);
      const res = await cache.resolveStream(itemKey);
      expect(res.ok, `expected ${badUrl} to be rejected`).toBe(false);
      if (!res.ok) {
        expect(res.error.category).toBe('playback');
        expect(res.error.code).toBe('unsupported-scheme');
      }
    }

    // Leading/trailing plain ASCII spaces are trimmed on returned URL (no control chars)
    await e.db.run('UPDATE live SET url_template = ? WHERE key = ?', [
      '  http://sim.test/live/demo/pass/1.ts  ',
      itemKey,
    ]);
    const trimmedRes = await cache.resolveStream(itemKey);
    expect(trimmedRes.ok).toBe(true);
    if (trimmedRes.ok) {
      expect(trimmedRes.value.url).toBe('http://sim.test/live/demo/pass/1.ts');
    }

    // Valid primary with mixed hostile + valid alternates filters out hostile alternates only
    await e.db.run('UPDATE live SET url_template = ?, backup_urls_json = ? WHERE key = ?', [
      'http://sim.test/live/demo/pass/1.ts',
      JSON.stringify([
        'file:///etc/passwd',
        'javascript:alert(1)',
        'data:text/plain,hi',
        'https://backup.example/live/1.m3u8',
        'udp://@239.1.1.1:1234',
      ]),
      itemKey,
    ]);
    const valid = await cache.resolveStream(itemKey);
    expect(valid.ok).toBe(true);
    if (valid.ok) {
      expect(valid.value.alternates?.map((a) => a.url)).toEqual([
        'https://backup.example/live/1.m3u8',
        'udp://239.1.1.1:1234',
      ]);
    }
  });

  it('neutralizes FTS5 syntax and LIKE wildcard/SQL injection payloads in querySearch', async () => {
    const e = await setupM3u(
      '#EXTM3U\n' +
        extinf('Sports HD', 'http://sim.test/live/demo/pass/1.ts', 'group-title="Sports"') +
        extinf('News 24', 'http://sim.test/live/demo/pass/2.ts', 'group-title="News"') +
        extinf('100% Pure_Class\\Mix', 'http://sim.test/live/demo/pass/3.ts', 'group-title="Misc"'),
    );
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);

    const hostilePayloads = [
      '" OR 1=1 --',
      "' OR '1'='1",
      'NEAR/0',
      'sports NEAR/0 news',
      '*',
      '^',
      'name:sports OR 1=1',
      'NOT sports',
      '((( )))',
      '%',
      '_',
      '\\',
      '%\\%__\\\\',
      'sports\0news',
      'sports\r\nDROP TABLE live;--',
      'a b c d e f g h i j k l m n',
    ];

    for (const payload of hostilePayloads) {
      // Must never throw SQLite FTS5 syntax or SQL errors
      const fts = buildFtsQuery(payload);
      if (fts !== null) {
        expect(fts).not.toContain('\0');
      }
      const res = await querySearch(e.db, payload);
      expect(Array.isArray(res.live)).toBe(true);
      expect(Array.isArray(res.movies)).toBe(true);
      expect(Array.isArray(res.series)).toBe(true);
    }

    // LIKE wildcard characters must be escaped and must NOT match unrelated rows
    expect(escapeLikePattern('100%_\\')).toBe('100\\%\\_\\\\');
    const pct = await querySearch(e.db, '%');
    expect(pct.live).toEqual([]);
    const underscore = await querySearch(e.db, '_');
    expect(underscore.live).toEqual([]);
    const orInjection = await querySearch(e.db, '" OR 1=1 --');
    expect(orInjection.live).toEqual([]);
  });
});

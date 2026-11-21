import { describe, expect, it } from 'vitest';
import { extinf, M3U_PASS, M3U_TOKEN, M3U_USER, setupM3u } from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { secretKey } from './sources';
import {
  createPlaytimeResolverCache,
  createStreamResolver,
  normalizeMulticastUrl,
  readUrlVars,
} from './stream-resolver';
import { memorySecrets } from './test-db';

const entry = (id: number) =>
  `http://cdn.example:8080/${M3U_TOKEN}/s/${id}.ts?username=${M3U_USER}&password=${M3U_PASS}`;
const logo = (id: number) => `http://cdn.example:8080/${M3U_TOKEN}/logo/${id}.png`;

describe('createStreamResolver', () => {
  it('rebuilds entry URLs and logos of an imported source in memory', async () => {
    let body = '#EXTM3U\n';
    for (let i = 0; i < 5; i += 1) body += extinf(`Ch ${i}`, entry(i), `tvg-logo="${logo(i)}"`);
    const e = await setupM3u(body);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    const rows = await e.db.all<{ name: string; url_template: string; logo: string }>(
      'SELECT name, url_template, logo FROM live ORDER BY id',
    );
    let reads = 0;
    const secrets = {
      ...e.secrets,
      get: (key: string) => {
        reads += 1;
        return e.secrets.get(key);
      },
    };
    const resolver = await createStreamResolver(e.sourceId, { secrets });
    rows.forEach((row, i) => {
      expect(row.url_template).not.toContain(M3U_TOKEN);
      expect(resolver.resolve(row.url_template)).toBe(entry(i));
      expect(resolver.resolve(row.logo)).toBe(logo(i));
    });
    expect(reads).toBe(1);
  });

  it('returns undefined for a template with a missing value and unescapes braces', async () => {
    const secrets = memorySecrets();
    await secrets.set(secretKey('s1', 'urlvars'), JSON.stringify({ v0: 'abc' }));
    const resolver = await createStreamResolver('s1', { secrets });
    expect(resolver.resolve('https://h.example/{{v0}}/{{(}}x')).toBe('https://h.example/abc/{{x');
    expect(resolver.resolve('https://h.example/{{v1}}/s')).toBeUndefined();
    expect(resolver.resolve('https://h.example/plain')).toBe('https://h.example/plain');
  });
});

describe('readUrlVars', () => {
  it('yields an empty object for a missing, broken or non-object secret', async () => {
    const secrets = memorySecrets();
    expect(await readUrlVars({ secrets }, 's1')).toEqual({});
    await secrets.set(secretKey('s1', 'urlvars'), '{broken');
    expect(await readUrlVars({ secrets }, 's1')).toEqual({});
    await secrets.set(secretKey('s1', 'urlvars'), 'null');
    expect(await readUrlVars({ secrets }, 's1')).toEqual({});
    const failing = { ...secrets, get: () => Promise.reject(new Error('locked')) };
    expect(await readUrlVars({ secrets: failing }, 's1')).toEqual({});
  });
});

describe('normalizeMulticastUrl (#267)', () => {
  it('rewrites udp://@ and rtp://@ case-insensitively and leaves other URLs untouched', () => {
    expect(normalizeMulticastUrl('udp://@239.0.0.1:1234')).toBe('udp://239.0.0.1:1234');
    expect(normalizeMulticastUrl('rtp://@239.0.0.2:5004/live?x=1')).toBe(
      'rtp://239.0.0.2:5004/live?x=1',
    );
    expect(normalizeMulticastUrl('UDP://@239.0.0.3:2000')).toBe('UDP://239.0.0.3:2000');
    expect(normalizeMulticastUrl('RtP://@239.0.0.4:3000')).toBe('RtP://239.0.0.4:3000');
    expect(normalizeMulticastUrl('udp://239.0.0.1:1234')).toBe('udp://239.0.0.1:1234');
    expect(normalizeMulticastUrl('udp://@')).toBe('udp://@');
    expect(normalizeMulticastUrl('rtp://@/path')).toBe('rtp://@/path');
    expect(normalizeMulticastUrl('http://user@cdn.example/live/1.ts')).toBe(
      'http://user@cdn.example/live/1.ts',
    );
    expect(normalizeMulticastUrl('rtsp://@10.0.0.1:554/stream')).toBe(
      'rtsp://@10.0.0.1:554/stream',
    );
  });

  it('normalizes resolved multicast URLs in createStreamResolver and resolveStream', async () => {
    const playlist =
      '#EXTM3U\n' +
      extinf('Multicast UDP', 'udp://@239.10.0.1:1234', 'group-title="LAN"') +
      extinf('Multicast RTP', 'RTP://@239.10.0.2:5004/feed', 'group-title="LAN"');
    const e = await setupM3u(playlist);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);

    const rows = await e.db.all<{ key: string; url_template: string }>(
      'SELECT key, url_template FROM live ORDER BY id',
    );
    // Simulate legacy pre-normalized templates persisted in SQLite
    await e.db.run('UPDATE live SET url_template = ? WHERE key = ?', [
      'udp://@239.10.0.1:1234',
      rows[0]?.key ?? '',
    ]);
    await e.db.run('UPDATE live SET url_template = ? WHERE key = ?', [
      'RTP://@239.10.0.2:5004/feed',
      rows[1]?.key ?? '',
    ]);
    const resolver = await createStreamResolver(e.sourceId, { secrets: e.secrets });
    expect(resolver.resolve('udp://@239.10.0.1:1234')).toBe('udp://239.10.0.1:1234');
    expect(resolver.resolve('RTP://@239.10.0.2:5004/feed')).toBe('RTP://239.10.0.2:5004/feed');

    const cache = createPlaytimeResolverCache({
      db: e.db,
      secrets: e.secrets,
      http: e.deps.http,
    });
    const r0 = await cache.resolveStream(rows[0]?.key ?? '');
    const r1 = await cache.resolveStream(rows[1]?.key ?? '');
    expect(r0.ok && r0.value.url).toBe('udp://239.10.0.1:1234');
    expect(r1.ok && r1.value.url).toBe('RTP://239.10.0.2:5004/feed');
  });

  it('returns credentialFingerprint as accountKey when valid and falls back to sourceId otherwise (#265)', async () => {
    const e = await setupM3u(
      `#EXTM3U\n${extinf('Live 1', 'http://cdn.example/hls/ch1/index.m3u8')}`,
      {
        playlistUrl: 'http://cdn.example/plain.m3u',
      },
    );
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    const row = (await e.db.all<{ key: string }>('SELECT key FROM live LIMIT 1'))[0];
    const cache = createPlaytimeResolverCache({
      db: e.db,
      secrets: e.secrets,
      http: e.deps.http,
    });

    const withoutFp = await cache.resolveStream(row?.key ?? '');
    expect(withoutFp.ok && withoutFp.value.accountKey).toBe(e.sourceId);

    const validFp = `fp:${'b'.repeat(64)}`;
    await e.db.run('UPDATE sources SET settings_json = ? WHERE id = ?', [
      JSON.stringify({ credentialFingerprint: validFp }),
      e.sourceId,
    ]);
    const withFp = await cache.resolveStream(row?.key ?? '');
    expect(withFp.ok && withFp.value.accountKey).toBe(validFp);

    await e.db.run('UPDATE sources SET settings_json = ? WHERE id = ?', [
      JSON.stringify({ credentialFingerprint: 'fp:invalid' }),
      e.sourceId,
    ]);
    const withBadFp = await cache.resolveStream(row?.key ?? '');
    expect(withBadFp.ok && withBadFp.value.accountKey).toBe(e.sourceId);
  });
});

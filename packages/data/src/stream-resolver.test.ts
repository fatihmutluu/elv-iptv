import { describe, expect, it } from 'vitest';
import { extinf, M3U_PASS, M3U_TOKEN, M3U_USER, setupM3u } from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { secretKey } from './sources';
import { createStreamResolver, readUrlVars } from './stream-resolver';
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

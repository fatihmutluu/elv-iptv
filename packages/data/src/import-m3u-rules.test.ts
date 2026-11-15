import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { extinf, M3U_PASS, M3U_USER, playlistUrlFor, setupM3u } from './import-test-helpers';
import { importCatalog } from './import-xtream';
import { getSource } from './sources';
import { resolveTemplate, type UrlVars } from './templates';

type Env = Awaited<ReturnType<typeof setupM3u>>;

const TOKEN_A = ['acct', 'Tok', 'en', 'AAAA1111'].join('');
const TOKEN_B = ['acct', 'Tok', 'en', 'BBBB2222'].join('');

const entries = (host: string, token: string, from: number, n: number, group = 'G') =>
  Array.from({ length: n }, (_, i) =>
    extinf(
      `Ch ${from + i}`,
      `https://${host}/${token}/strm${(from + i).toString(36)}q`,
      `group-title="${group}"`,
    ),
  ).join('');

const vars = async (e: Env): Promise<UrlVars> =>
  JSON.parse((await e.secrets.get('source.s1.urlvars')) ?? '{}') as UrlVars;

async function rowsWith(e: Env, needle: string): Promise<number> {
  const r = await e.db.all<{ n: number }>(
    'SELECT COUNT(*) AS n FROM live WHERE instr(url_template, ?) > 0 OR instr(key, ?) > 0',
    [needle, needle],
  );
  return r[0]?.n ?? 0;
}

async function dump(e: Env): Promise<string> {
  const tables = await e.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const parts: string[] = [];
  for (const t of tables) {
    for (const row of await e.db.all<Record<string, unknown>>(`SELECT * FROM ${t.name}`)) {
      parts.push(...Object.values(row).map(String));
    }
  }
  return parts.join('\n');
}

describe('segment rules on every import', () => {
  it('templates the token after the provider moves to another host', async () => {
    const e = await setupM3u(`#EXTM3U\n${entries('cdn1.example', TOKEN_A, 0, 50)}`);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    e.state.body = `#EXTM3U\n${entries('cdn2.example', TOKEN_A, 0, 50)}`;
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    expect(await rowsWith(e, TOKEN_A)).toBe(0);
    expect((await getSource(e.db, e.sourceId))?.settings.segmentRules).toEqual([
      { host: 'cdn2.example', position: 0, name: 'v1' },
    ]);
  });

  it('templates a second account that starts after the first sample', async () => {
    const e = await setupM3u(
      `#EXTM3U\n${entries('cdn1.example', TOKEN_A, 0, 1200)}${entries('cdn1.example', TOKEN_B, 1200, 300)}`,
    );
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    expect(await rowsWith(e, TOKEN_A)).toBe(0);
    expect(await rowsWith(e, TOKEN_B)).toBe(0);
    const v = await vars(e);
    expect(Object.values(v)).toEqual(expect.arrayContaining([TOKEN_A, TOKEN_B]));
    const row = await e.db.all<{ url_template: string }>(
      "SELECT url_template FROM live WHERE name = 'Ch 1300'",
    );
    expect(resolveTemplate(row[0]?.url_template ?? '', v)).toContain(TOKEN_B);
  });

  it('judges a host first seen after the sample before writing its entries', async () => {
    const e = await setupM3u(
      `#EXTM3U\n${entries('cdn1.example', TOKEN_A, 0, 1000)}${entries('late.example', TOKEN_B, 1000, 120)}`,
    );
    expect((await importCatalog(e.sourceId, e.deps, { batchSize: 70 })).ok).toBe(true);
    expect(await rowsWith(e, TOKEN_B)).toBe(0);
    expect((await getSource(e.db, e.sourceId))?.settings.segmentRules).toEqual([
      { host: 'cdn1.example', position: 0, name: 'v0' },
      { host: 'late.example', position: 0, name: 'v1' },
    ]);
  });

  it('judges a host seen once in the sample again on its later entries', async () => {
    const body =
      '#EXTM3U\n' +
      entries('cdn1.example', TOKEN_A, 0, 999) +
      entries('rare.example', TOKEN_B, 999, 1) +
      entries('rare.example', TOKEN_B, 1000, 100);
    const e = await setupM3u(body);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    expect(await rowsWith(e, TOKEN_B)).toBe(0);
  });

  it('keeps playlist order in categories while entries are held back', async () => {
    let body = `#EXTM3U\n${entries('cdn1.example', TOKEN_A, 0, 1000, 'Mixed')}`;
    for (let i = 0; i < 80; i += 1) {
      const host = i % 2 === 0 ? 'late.example' : 'cdn1.example';
      body += entries(host, i % 2 === 0 ? TOKEN_B : TOKEN_A, 1000 + i, 1, 'Mixed');
    }
    const e = await setupM3u(body);
    expect((await importCatalog(e.sourceId, e.deps, { batchSize: 33 })).ok).toBe(true);
    const placed = await e.db.all<{ name: string }>(
      "SELECT l.name AS name FROM placements p JOIN live l ON l.key = p.item_key WHERE p.category_id = 'Mixed' ORDER BY p.position",
    );
    expect(placed.map((p) => p.name)).toEqual(Array.from({ length: 1080 }, (_, i) => `Ch ${i}`));
    expect(await rowsWith(e, TOKEN_B)).toBe(0);
  });
});

describe('bounded URL variables', () => {
  const urlvars = (e: Env) => e.secrets.dump()['source.s1.urlvars'] ?? '';

  it('keeps a plain three-segment playlist out of the secret store', async () => {
    const body = `#EXTM3U\n${Array.from({ length: 5000 }, (_, i) =>
      extinf(`Ch ${i}`, `http://tv.example/hls/channel-${i}/1.m3u8`, 'group-title="G"'),
    ).join('')}`;
    const e = await setupM3u(body, {}, 'http://lists.example/free.m3u');
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    expect(Object.keys(JSON.parse(urlvars(e))).length).toBeLessThanOrEqual(3);
    expect(urlvars(e).length).toBeLessThan(2048);
    const row = await e.db.all<{ url_template: string }>(
      "SELECT url_template FROM live WHERE name = 'Ch 7'",
    );
    expect(row[0]?.url_template).toBe('http://tv.example/hls/channel-7/1.m3u8');
  });

  it('stays small for a typical token panel and templates bare or single-host backup paths', async () => {
    const body =
      '#EXTM3U\n' +
      entries('cdn1.example', TOKEN_A, 0, 5000) +
      extinf('Bare', `http://bare.example:8080/${M3U_USER}/${M3U_PASS}/3`) +
      extinf('Backup', 'http://backup.example/u9/p9/4') +
      extinf('Plain', 'http://plain.example/hls/news/index.m3u8');
    const e = await setupM3u(body);
    expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
    expect(urlvars(e).length).toBeLessThan(2048);
    const row = await e.db.all<{ name: string; url_template: string }>(
      "SELECT name, url_template FROM live WHERE name IN ('Bare', 'Backup', 'Plain') ORDER BY name",
    );
    expect(row.find((r) => r.name === 'Bare')?.url_template).not.toContain(M3U_PASS);
    expect(row.find((r) => r.name === 'Backup')?.url_template).not.toContain('u9');
    expect(row.find((r) => r.name === 'Backup')?.url_template).not.toContain('p9');
    expect(row.find((r) => r.name === 'Plain')?.url_template).toBe(
      'http://plain.example/hls/news/index.m3u8',
    );
  });
});

type Shape = 'token' | 'xtream' | 'query' | 'bare';

interface Block {
  host: number;
  account: number;
  count: number;
}

interface Scenario {
  tokens: string[];
  user: string;
  pass: string;
  shortUser: string;
  shortPass: string;
  logoToken: string;
  refToken: string;
  playlistStyle: 'get.php' | 'alias-query' | 'userinfo' | 'plain';
  shapes: [Shape, Shape, Shape, Shape];
  later: Block[];
}

const enc = encodeURIComponent;

function playlistUrlOf(s: Scenario, user: string, pass: string): string {
  if (s.playlistStyle === 'get.php') return playlistUrlFor(enc(user), enc(pass));
  if (s.playlistStyle === 'alias-query') {
    return `https://list.example/m3u/download?user=${enc(user)}&pwd=${enc(pass)}`;
  }
  if (s.playlistStyle === 'userinfo') {
    return `https://${enc(user)}:${enc(pass)}@list.example/playlist.m3u`;
  }
  return 'https://list.example/custom-list.m3u';
}

function urlFor(
  s: Scenario,
  host: string,
  shape: Shape,
  token: string,
  id: number,
  pass: string,
  shortPass: string,
) {
  const port = id % 7 === 0 ? (shape === 'token' ? ':443' : ':80') : '';
  if (shape === 'token') return `https://${host}${port}/${token}/strm${id.toString(36)}q`;
  if (shape === 'xtream') return `http://${host}${port}/live/${enc(s.user)}/${enc(pass)}/${id}.ts`;
  if (shape === 'bare') return `http://${host}${port}/${s.shortUser}/${shortPass}/${id}.ts`;
  return `http://${host}${port}/play/${id}.m3u8?username=${enc(s.user)}&${['pass', 'word'].join('')}=${enc(pass)}&token=${token}`;
}

/** Builds a playlist covering mixed accounts, single-entry backup host, dedicated logo/referer hosts, and all #40 shapes. */
function playlist(
  s: Scenario,
  hosts: string[],
  tokens: string[],
  pass: string,
  shortPass: string,
  logoToken: string,
  refToken: string,
) {
  const urls = new Map<string, string>();
  let body = '#EXTM3U\n';
  let id = 0;
  const add = (h: number, account: number) => {
    const host = hosts[h] as string;
    const token = tokens[account] as string;
    const shape = s.shapes[h] as Shape;
    const url = urlFor(s, host, shape, token, id, pass, shortPass);
    const logo =
      id % 5 === 0
        ? `https://logos-dedicated.example/${logoToken}/logo${id}.png`
        : shape === 'token'
          ? `https://${host}/${token}/logo${id}.png`
          : `https://img.example/${id}.png`;
    urls.set(`Ch ${id}`, url);
    body += `#EXTINF:-1 tvg-logo="${logo}" group-title="G${h}",Ch ${id}\n`;
    if (id % 9 === 0) {
      body += `#EXTVLCOPT:http-referrer=https://ref-dedicated.example/${refToken}/embed\n`;
    }
    body += `${url}\n`;
    id += 1;
  };
  for (let i = 0; i < 600; i += 1) {
    const h = i % 3;
    const account = h === 0 ? i % 2 : h;
    add(h, account);
  }
  for (const b of s.later) {
    for (let i = 0; i < b.count; i += 1) add(b.host, b.account);
  }
  const singleBackup = `https://single-backup.example/${tokens[3] as string}/s${id}`;
  urls.set(`Ch ${id}`, singleBackup);
  body += extinf(`Ch ${id}`, singleBackup, 'group-title="Backup"');
  id += 1;
  const singleBare = `http://single-bare.example/${s.shortUser}/${shortPass}/${id}.ts`;
  urls.set(`Ch ${id}`, singleBare);
  body += extinf(`Ch ${id}`, singleBare, 'group-title="Backup"');
  return { body, urls };
}

async function expectClean(e: Env, secrets: string[], urls: Map<string, string>) {
  const text = await dump(e);
  for (const secret of secrets) expect(text).not.toContain(secret);
  const v = await vars(e);
  const rows = await e.db.all<{ name: string; url_template: string }>(
    'SELECT name, url_template FROM live',
  );
  expect(rows).toHaveLength(urls.size);
  for (const r of rows) expect(resolveTemplate(r.url_template, v)).toBe(urls.get(r.name));
}

describe('no secret reaches a template or key', () => {
  const shape = fc.constantFrom<Shape>('token', 'xtream', 'query', 'bare');
  const scenario: fc.Arbitrary<Scenario> = fc.record({
    tokens: fc
      .uniqueArray(fc.stringMatching(/^[a-z0-9]{10,14}$/), { minLength: 5, maxLength: 5 })
      .map((list) => list.map((t) => `T${t}`)),
    user: fc.stringMatching(/^[a-z0-9]{3,8}$/).map((u) => `U${u}`),
    pass: fc.stringMatching(/^[a-z0-9@/+ %]{4,10}$/).map((p) => `P${p}`),
    shortUser: fc.stringMatching(/^[a-z0-9]{3,5}$/).map((u) => `SU${u}`),
    shortPass: fc.stringMatching(/^[a-z0-9]{3,5}$/).map((p) => `SP${p}`),
    logoToken: fc.stringMatching(/^[a-z0-9]{10,12}$/).map((t) => `L${t}`),
    refToken: fc.stringMatching(/^[a-z0-9]{10,12}$/).map((t) => `R${t}`),
    playlistStyle: fc.constantFrom('get.php', 'alias-query', 'userinfo', 'plain'),
    shapes: fc.tuple(shape, shape, shape, shape),
    later: fc.array(
      fc.record({
        host: fc.integer({ min: 0, max: 3 }),
        account: fc.integer({ min: 0, max: 3 }),
        count: fc.integer({ min: 1, max: 60 }),
      }),
      { maxLength: 4 },
    ),
  });

  it('holds for mixed accounts, single-entry hosts, bare paths, logo/referer hosts and rotated credentials', async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const hosts = ['cdn1.example', 'cdn2.example', 'cdn3.example', 'cdn4.example'];
        const tokens = s.tokens.slice(0, 4);
        const first = playlist(s, hosts, tokens, s.pass, s.shortPass, s.logoToken, s.refToken);
        const e = await setupM3u(first.body, {}, playlistUrlOf(s, s.user, s.pass));
        expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
        const secrets = [
          ...tokens,
          s.user,
          s.pass,
          enc(s.user),
          enc(s.pass),
          s.shortUser,
          s.shortPass,
          s.logoToken,
          s.refToken,
        ];
        await expectClean(e, secrets, first.urls);

        const moved = ['cdn5.example', ...hosts.slice(1)];
        const rotated = [s.tokens[4] as string, ...tokens.slice(1)];
        const newPass = `${s.pass}9z`;
        const newShortPass = `${s.shortPass}9`;
        const newLogoToken = `${s.logoToken}9`;
        const newRefToken = `${s.refToken}9`;
        const second = playlist(
          s,
          moved,
          rotated,
          newPass,
          newShortPass,
          newLogoToken,
          newRefToken,
        );
        e.state.body = second.body;
        await e.secrets.set('source.s1.playlist', playlistUrlOf(s, s.user, newPass));
        expect((await importCatalog(e.sourceId, e.deps)).ok).toBe(true);
        await expectClean(
          e,
          [...secrets, ...rotated, newPass, enc(newPass), newShortPass, newLogoToken, newRefToken],
          second.urls,
        );
        e.close();
      }),
      { numRuns: 12 },
    );
  }, 120_000);
});

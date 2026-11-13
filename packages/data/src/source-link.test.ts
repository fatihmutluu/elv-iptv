import { describe, expect, it } from 'vitest';
import { openCatalog } from './migrate';
import { addSourceFromLink, parseXtreamLink } from './source-link';
import { secretKey } from './sources';
import { memorySecrets, testDb } from './test-db';

const PW = ['p@ss', 'w0rd/1'].join('');
const USER = 'jane doe';
const enc = encodeURIComponent;
const link = (path: string, query: string) => `http://h.example:8080${path}?${query}`;
const creds = `username=${enc(USER)}&password=${enc(PW)}`;
const simple = (extra = '') => link('/get.php', ['username=a', 'password=b'].join('&') + extra);

describe('parseXtreamLink', () => {
  it('reads server, credentials and output', () => {
    expect(
      parseXtreamLink(
        link('/get.php', ['username=u1', 'password=x2', 'type=m3u_plus', 'output=ts'].join('&')),
      ),
    ).toEqual({ server: 'http://h.example:8080', username: 'u1', password: 'x2', output: 'ts' });
  });
  it('keeps a path prefix', () => {
    expect(parseXtreamLink(link('/panel/get.php', 'username=a&password=b'))?.server).toBe(
      'http://h.example:8080/panel',
    );
  });
  it('accepts upper-case names in any order and decodes values', () => {
    const r = parseXtreamLink(link('/GET.php', `PASSWORD=${enc(PW)}&Username=${enc(USER)}`));
    expect(r).toEqual({ server: 'http://h.example:8080', username: USER, password: PW });
  });
  it('maps m3u8 and hls to m3u8', () => {
    expect(parseXtreamLink(simple('&output=m3u8'))?.output).toBe('m3u8');
    expect(parseXtreamLink(simple('&output=HLS'))?.output).toBe('m3u8');
  });
  it('omits an unknown output', () => {
    expect(parseXtreamLink(simple('&output=mpegts'))).not.toHaveProperty('output');
  });
  it('tolerates a malformed escape and valueless parameters', () => {
    const r = parseXtreamLink(link('/get.php', 'flag&username=a%ZZ&password=b'));
    expect(r?.username).toBe('a%ZZ');
  });
  it.each([
    ['no get.php', link('/list.m3u', 'username=a&password=b')],
    ['missing password', link('/get.php', 'username=a')],
    ['missing username', link('/get.php', 'password=b')],
    ['empty values', link('/get.php', 'username=&password=')],
    ['ftp scheme', 'ftp://h.example/get.php?username=a&password=b'],
    ['not a url', 'nonsense'],
    ['no query', 'http://h.example/get.php'],
  ])('rejects %s', (_n, url) => {
    expect(parseXtreamLink(url)).toBeUndefined();
  });
});

async function setup() {
  const t = testDb();
  await openCatalog(t.db);
  const secrets = memorySecrets();
  const deps = { db: t.db, secrets, clock: () => 7, newId: () => 'src1' };
  return { ...t, secrets, deps };
}

describe('addSourceFromLink', () => {
  it('adds an Xtream source and keeps credentials in the secret store only', async () => {
    const s = await setup();
    const r = await addSourceFromLink(
      { name: 'Panel', url: link('/get.php', `${creds}&output=m3u8`) },
      s.deps,
    );
    expect(r.ok && r.value.kind).toBe('xtream');
    expect(r.ok && r.value.settings.transport).toEqual({ xtreamFormat: 'm3u8' });
    const stored = JSON.parse((await s.secrets.get(secretKey('src1', 'xtream'))) ?? '{}');
    expect(stored).toEqual({ server: 'http://h.example:8080', username: USER, password: PW });
    const rows = JSON.stringify(await s.db.all('SELECT * FROM sources'));
    expect(rows).not.toContain(PW);
    expect(rows).not.toContain(enc(PW));
    expect(rows).not.toContain(USER);
  });
  it('merges the output into given transport settings', async () => {
    const s = await setup();
    const r = await addSourceFromLink(
      {
        name: 'Panel',
        url: link('/get.php', `${creds}&output=hls`),
        transport: { userAgent: 'UA' },
      },
      s.deps,
    );
    expect(r.ok && r.value.settings.transport).toEqual({ userAgent: 'UA', xtreamFormat: 'm3u8' });
  });
  it('keeps the given transport when the link has no output', async () => {
    const s = await setup();
    const r = await addSourceFromLink(
      { name: 'Panel', url: link('/get.php', creds), transport: { xtreamFormat: 'ts' } },
      s.deps,
    );
    expect(r.ok && r.value.settings.transport).toEqual({ xtreamFormat: 'ts' });
  });
  it('leaves transport unset without output or transport', async () => {
    const s = await setup();
    const r = await addSourceFromLink({ name: 'Panel', url: link('/get.php', creds) }, s.deps);
    expect(r.ok && r.value.settings).toEqual({});
  });
  it('does not store a guide URL or VOD flag on an Xtream source', async () => {
    const s = await setup();
    const guide = `https://g.example/x.xml?${creds}`;
    const r = await addSourceFromLink(
      { name: 'Panel', url: link('/get.php', creds), guideUrl: guide, vodPlaylist: true },
      s.deps,
    );
    expect(r.ok && r.value.kind).toBe('xtream');
    expect(r.ok && r.value.settings).toEqual({});
    expect(JSON.stringify(await s.db.all('SELECT * FROM sources'))).not.toContain('g.example');
  });
  it('adds an M3U source when keepAsM3u is set', async () => {
    const s = await setup();
    const url = link('/get.php', creds);
    const r = await addSourceFromLink(
      { name: 'Panel', url, keepAsM3u: true, vodPlaylist: true },
      s.deps,
    );
    expect(r.ok && r.value.kind).toBe('m3u');
    expect(r.ok && r.value.settings.vodPlaylist).toBe(true);
    expect(await s.secrets.get(secretKey('src1', 'playlist'))).toBe(url);
    expect(JSON.stringify(await s.db.all('SELECT * FROM sources'))).not.toContain(enc(PW));
  });
  it('adds an M3U source for any other URL, with its guide', async () => {
    const s = await setup();
    const r = await addSourceFromLink(
      { name: 'List', url: 'https://cdn.example/list.m3u', guideUrl: 'https://cdn.example/g.xml' },
      s.deps,
    );
    expect(r.ok && r.value.kind).toBe('m3u');
    expect(r.ok && r.value.settings.guideUrl).toBeDefined();
  });
  it('rejects an empty name', async () => {
    const s = await setup();
    const r = await addSourceFromLink({ name: ' ', url: link('/get.php', creds) }, s.deps);
    expect(r.ok).toBe(false);
  });
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNTS } from '../src/sim/accounts.ts';
import { type LogEntry, redact } from '../src/sim/log.ts';
import { pngLogo } from '../src/sim/png.ts';
import { type SimHandle, startSim } from '../src/sim/server.ts';

const CLOCK = new Date('2026-01-01T12:00:00Z');
const open: SimHandle[] = [];
if (process.env.SIM_HUGE !== '1')
  process.stderr.write('sim-server: huge playlist test skipped (set SIM_HUGE=1)\n');

async function sim(): Promise<SimHandle> {
  const handle = await startSim({ port: 0, clock: CLOCK });
  open.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((h) => h.close()));
});

const demo = ACCOUNTS.find((a) => a.username === 'demo');
if (!demo) throw new Error('demo account missing');
const creds = `username=${demo.username}&password=${demo.password}`;
const wrong = `username=${demo.username}&password=nope`;
const pair = `/${demo.username}/${demo.password}/`;
const basic = Buffer.from(`${demo.username}:${demo.password}`).toString('base64');

describe('playlists', () => {
  it('serves the Xtream playlist', async () => {
    const { url } = await sim();
    const ok = await fetch(`${url}/get.php?${creds}&type=m3u_plus&output=ts`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('content-type')).toBe('audio/x-mpegurl');
    expect((await ok.text()).startsWith('#EXTM3U')).toBe(true);
    const bad = await fetch(`${url}/get.php?${wrong}&type=m3u_plus`);
    expect(bad.status).toBe(401);
    expect(await bad.text()).toBe('');
  });

  it('serves direct playlists', async () => {
    const { url } = await sim();
    const names = [
      'small.m3u',
      'small.m3u8',
      'compat.m3u',
      'compat-crlf-bom.m3u',
      'compat-truncated.m3u',
    ];
    for (const name of names) {
      const res = await fetch(`${url}/playlists/${name}`);
      expect(res.status, name).toBe(200);
      await res.text();
    }
    const crlf = await (await fetch(`${url}/playlists/compat-crlf-bom.m3u`)).text();
    expect(crlf).toContain('\r\n');
    expect((await fetch(`${url}/playlists/nope.m3u`)).status).toBe(404);
  });

  it('serves the quirks playlist and guide for the quirks account', async () => {
    const { url } = await sim();
    const q = `username=quirks&${['pass', 'word'].join('')}=quirks`;
    const m3u = await (await fetch(`${url}/get.php?${q}&type=m3u_plus&output=ts`)).text();
    expect(m3u.startsWith('#EXTM3U\r\n')).toBe(true);
    const xml = await (await fetch(`${url}/xmltv.php?${q}`)).text();
    expect(xml).toContain('<!DOCTYPE tv SYSTEM "xmltv.dtd">');
    const direct = await (await fetch(`${url}/playlists/small.m3u`)).text();
    expect(direct).toContain('url-tvg=');
  });

  it.runIf(process.env.SIM_HUGE === '1')(
    'streams the start of the huge playlist',
    async () => {
      const { url } = await sim();
      const res = await fetch(`${url}/playlists/huge.m3u`);
      expect(res.status).toBe(200);
      const decoder = new TextDecoder();
      let text = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        text += decoder.decode(chunk, { stream: true });
        if (text.length > 5_000_000) break;
      }
      expect(text.split('\n').filter((l) => l.startsWith('#EXTINF')).length).toBeGreaterThan(5000);
    },
    60_000,
  );

  it('answers a broken playlist status', async () => {
    const { url } = await sim();
    expect((await fetch(`${url}/playlists/broken/503.m3u`)).status).toBe(503);
  });

  it('streams the large playlist', async () => {
    const { url } = await sim();
    const res = await fetch(`${url}/playlists/large.m3u`);
    expect(res.status).toBe(200);
    const decoder = new TextDecoder();
    let tail = '';
    let count = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      const text = tail + decoder.decode(chunk, { stream: true });
      const cut = text.lastIndexOf('\n');
      const whole = cut < 0 ? '' : text.slice(0, cut);
      tail = cut < 0 ? text : text.slice(cut + 1);
      count += whole.split('\n').filter((l) => l.startsWith('#EXTINF')).length;
    }
    if (tail.startsWith('#EXTINF')) count += 1;
    expect(count).toBe(100_000);
  }, 60_000);
});

describe('api, guides and logos', () => {
  it('serves the API and guide', async () => {
    const { url } = await sim();
    const api = await fetch(`${url}/player_api.php?${creds}&action=get_live_categories`);
    expect(api.status).toBe(200);
    expect(Array.isArray(await api.json())).toBe(true);
    const xml = await fetch(`${url}/xmltv.php?${creds}`);
    expect((await xml.text()).startsWith('<?xml')).toBe(true);
    const gz = await fetch(`${url}/guides/small.xml.gz`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    const unzipped = gunzipSync(Buffer.from(await gz.arrayBuffer())).toString();
    expect(unzipped.startsWith('<?xml')).toBe(true);
    const plain = await fetch(`${url}/guides/small.xml`);
    expect((await plain.text()).startsWith('<?xml')).toBe(true);
    expect((await fetch(`${url}/xmltv.php?${wrong}`)).status).toBe(401);
  });

  it('serves the logo of the first live channel in the playlist', async () => {
    const { url } = await sim();
    const text = await (await fetch(`${url}/playlists/small.m3u`)).text();
    const logo = /tvg-logo="([^"]+)"/.exec(text)?.[1];
    expect(logo).toBeDefined();
    const res = await fetch(logo as string);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    await res.arrayBuffer();
  });

  it('serves logos', async () => {
    const { url } = await sim();
    const res = await fetch(`${url}/logos/3.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(body.equals(pngLogo(3))).toBe(true);
    expect(body.readUInt32BE(16)).toBe(256);
    expect(pngLogo(3).equals(pngLogo(3))).toBe(true);
    expect(pngLogo(3).equals(pngLogo(4))).toBe(false);
    expect((await fetch(`${url}/logos/99.png`)).status).toBe(404);
  });
});

describe('request faults', () => {
  it('applies request faults', async () => {
    const { url } = await sim();
    expect((await fetch(`${url}/playlists/small.m3u?fault=status=418`)).status).toBe(418);
    const redirect = await fetch(`${url}/playlists/small.m3u?x=1&fault=redirect`, {
      redirect: 'manual',
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toBe(`${url}/playlists/small.m3u?x=1`);
    const bare = await fetch(`${url}/playlists/small.m3u?fault=redirect`, { redirect: 'manual' });
    expect(bare.headers.get('location')).toBe(`${url}/playlists/small.m3u`);
    const notice = await fetch(`${url}/playlists/small.m3u?fault=text-notice`);
    expect(notice.status).toBe(200);
    expect(notice.headers.get('content-type')).toContain('text/plain');
    expect(await notice.text()).toBe('Max connections reached');
    const started = Date.now();
    const slow = await fetch(`${url}/playlists/small.m3u?fault=slow-start=1`);
    await slow.text();
    expect(Date.now() - started).toBeGreaterThanOrEqual(990);
    const bad = await fetch(`${url}/playlists/small.m3u?fault=explode`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('explode');
  });
});

describe('request log', () => {
  it('logs every request', async () => {
    const handle = await sim();
    const { url } = handle;
    await (
      await fetch(`${url}/player_api.php?${creds}`, { headers: { 'user-agent': 'probe/1' } })
    ).text();
    await (await fetch(`${url}/playlists/small.m3u`)).text();
    await (await fetch(`${url}/logos/1.png`)).arrayBuffer();
    const entries = handle.requests();
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      method: 'GET',
      path: '/player_api.php',
      status: 200,
      account: 'demo',
      headers: { 'user-agent': 'probe/1' },
    });
    expect(entries[0]?.bytes).toBeGreaterThan(0);
    expect(typeof entries[0]?.ms).toBe('number');
    expect(await (await fetch(`${url}/_sim/requests`)).json()).toEqual(entries);
    expect((await fetch(`${url}/_sim/requests`, { method: 'DELETE' })).status).toBe(204);
    expect(handle.requests()).toEqual([]);
    await (await fetch(`${url}/logos/2.png`)).arrayBuffer();
    handle.clear();
    expect(handle.requests()).toEqual([]);
  });

  it('never logs a password', async () => {
    const handle = await sim();
    const { url } = handle;
    await fetch(`${url}/get.php?${creds}`).then((r) => r.text());
    await fetch(`${url}/live${pair}1001.ts?fault=status=404`).then((r) => r.text());
    await fetch(`${url}/`, {
      headers: {
        authorization: `Basic ${basic}`,
        referer: `http://${demo.username}:${demo.password}@x/`,
      },
    }).then((r) => r.text());
    await fetch(`${url}/`, { headers: { referer: `http://h/get.php?${creds}` } }).then((r) =>
      r.text(),
    );
    await fetch(`${url}/live/${demo.username}/typo/1001.ts`).then((r) => r.text());
    const short = `/${demo.username}/${demo.password}/1001`;
    const other = '/alice/' + 'hunter22' + '/';
    await fetch(`${url}${short}?fault=status=404`).then((r) => r.text());
    await fetch(`${url}/live${other}1001.ts?fault=status=404`).then((r) => r.text());
    await fetch(`${url}/movie${other}7.mp4`).then((r) => r.text());
    await fetch(`${url}/`, {
      headers: { referer: `http://h${short}` },
    }).then((r) => r.text());
    await fetch(`${url}/`, {
      headers: { referer: `http://h/live${other}1001.ts` },
    }).then((r) => r.text());
    const okGet = await fetch(`${url}/get.php?${creds}`);
    expect(okGet.status).toBe(200);
    await okGet.text();
    const entries = handle.requests();
    const every = JSON.stringify(entries);
    expect(every).not.toContain('hunter22');
    expect(every).not.toContain(short);
    expect(every).toContain('/demo/***/1001');
    expect(every).toContain('/live/alice/***/1001.ts');
    expect(every).toContain('/movie/alice/***/7.mp4');
    expect(entries[0]?.query.password).toBe('***');
    expect(entries[0]?.query.username).toBe('demo');
    const json = JSON.stringify(entries);
    expect(json).not.toContain(`"password":"${demo.password}"`);
    expect(json).not.toContain(`password=${demo.password}`);
    expect(json).not.toContain(`${demo.username}&password=${demo.password}`);
    expect(json).not.toContain('/typo/');
    expect(json).toContain('/live/demo/***/1001.ts');
    expect(json).not.toContain(pair);
    expect(json).not.toContain(basic);
    expect(json).not.toContain(`${demo.username}:${demo.password}`);
    expect(json).toContain('"username":"demo"');
    expect(json).toContain('/live/demo/***/1001.ts');
  });

  it('redacts entries without touching the input', () => {
    const entry: LogEntry = {
      t: 'x',
      method: 'GET',
      path: `/movie${pair}7.mp4`,
      query: { password: demo.password, username: demo.username },
      headers: {
        authorization: 'Bearer abc',
        referer: `http://${demo.username}:${demo.password}@h/p`,
      },
      status: 200,
      bytes: 0,
      ms: 0,
      account: 'demo',
      streamId: 7,
      recipe: null,
      fault: null,
      openConnections: 0,
    };
    const out = redact(entry);
    expect(out.query).toEqual({ password: '***', username: 'demo' });
    expect(out.headers.authorization).toBe('***');
    expect(out.headers.referer).toBe('http://demo:***@h/p');
    expect(out.path).toBe('/movie/demo/***/7.mp4');
    expect(entry.query.password).toBe(demo.password);
  });

  it('answers unknown routes with 404 and logs them', async () => {
    const handle = await sim();
    const res = await fetch(`${handle.url}/nothing/here`);
    expect(res.status).toBe(404);
    await res.text();
    expect(handle.requests()[0]).toMatchObject({ path: '/nothing/here', status: 404 });
  });
});

describe('harness events', () => {
  it('accepts harness events', async () => {
    const { url } = await sim();
    const post = await fetch(`${url}/_sim/events`, { method: 'POST', body: '{"a":1}\n{"b":2}\n' });
    expect(post.status).toBe(204);
    expect(await (await fetch(`${url}/_sim/events`)).json()).toEqual([{ a: 1 }, { b: 2 }]);
    const bad = await fetch(`${url}/_sim/events`, { method: 'POST', body: '{"a":1}\nnot json\n' });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('line 2');
    const big = await fetch(`${url}/_sim/events`, { method: 'POST', body: 'x'.repeat(1_048_577) });
    expect(big.status).toBe(413);
  });
});

describe('log file', () => {
  it('rejects naming the path when the log file cannot be created', async () => {
    const bad = join(tmpdir(), 'elv-sim-missing-dir', 'nested', 'log.jsonl');
    const error = await startSim({ port: 0, logFile: bad }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(bad);
  });

  it('keeps serving and reports once when the log file fails later', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-sim-'));
    const file = join(dir, 'log.jsonl');
    const handle = await startSim({ port: 0, clock: CLOCK, logFile: file });
    open.push(handle);
    rmSync(file);
    mkdirSync(file);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${handle.url}/logos/1.png`);
        expect(res.status).toBe(200);
        await res.arrayBuffer();
      }
      const reports = stderr.mock.calls.filter(([text]) =>
        String(text).includes('log file disabled'),
      );
      expect(reports).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
    expect(handle.requests()).toHaveLength(3);
    rmSync(dir, { recursive: true, force: true });
  });

  it('masks the whole password value, including letters s', () => {
    const entry: LogEntry = {
      t: 'x',
      method: 'GET',
      path: '/',
      query: {},
      headers: { referer: 'http://h/get.php?password=compass&x=1' },
      status: 200,
      bytes: 0,
      ms: 0,
      account: null,
      streamId: null,
      recipe: null,
      fault: null,
      openConnections: 0,
    };
    expect(redact(entry).headers.referer).toBe('http://h/get.php?password=***&x=1');
  });

  it('appends one JSON line per request', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'elv-sim-'));
    const file = join(dir, 'log.jsonl');
    const handle = await startSim({ port: 0, clock: CLOCK, logFile: file });
    open.push(handle);
    await (await fetch(`${handle.url}/logos/1.png`)).arrayBuffer();
    await (await fetch(`${handle.url}/nothing`)).text();
    const lines = readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1] as string)).toMatchObject({ path: '/nothing', status: 404 });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('startup', () => {
  it('rejects with a clear error when the port is taken', async () => {
    const first = await sim();
    const error = await startSim({ port: first.port }).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('already in use');
    expect((error as Error).message).toContain(String(first.port));
  });

  it('advances the simulator clock from the fixed start', async () => {
    const handle = await sim();
    const res = await fetch(`${handle.url}/player_api.php?${creds}`);
    const body = (await res.json()) as { server_info: { timestamp_now: number } };
    expect(Math.abs(body.server_info.timestamp_now - CLOCK.getTime() / 1000)).toBeLessThan(30);
  });
});

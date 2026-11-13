import { elvError, type Result, transportHeaders } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import type { XtreamClient } from './xtream';
import { client, PASS, type Reply, USER } from './xtream-test-helpers';

describe('urls', () => {
  const enc = encodeURIComponent;
  it('are the same with or without a trailing slash', () => {
    const a = client(() => ({ json: [] }), { server: 'http://h:8080/' }).c;
    const b = client(() => ({ json: [] }), { server: 'http://h:8080' }).c;
    expect(a.playlistUrl()).toBe(b.playlistUrl());
    expect(a.streamUrl('live', 5)).toBe(b.streamUrl('live', 5));
    expect(a.guideUrl()).toBe(`http://h:8080/xmltv.php?username=${USER}&password=${enc(PASS)}`);
  });
  it('builds playlist and stream URLs from the transport format', () => {
    const ts = client(() => ({ json: [] })).c;
    const hls = client(() => ({ json: [] }), { transport: { xtreamFormat: 'm3u8' } }).c;
    expect(ts.playlistUrl()).toBe(
      `http://h.example:8080/get.php?username=${USER}&password=${enc(PASS)}&type=m3u_plus&output=ts`,
    );
    expect(hls.playlistUrl()).toContain('&type=m3u_plus&output=m3u8');
    expect(ts.streamUrl('live', 5)).toBe(`http://h.example:8080/live/${USER}/${enc(PASS)}/5.ts`);
    expect(hls.streamUrl('live', 5)).toMatch(/\/5\.m3u8$/);
    expect(ts.streamUrl('live', 5, 'm3u8')).toMatch(/\/5\.m3u8$/);
    expect(ts.streamUrl('movie', 6)).toMatch(/\/movie\/u1\/.+\/6\.mp4$/);
    expect(ts.streamUrl('movie', 6, 'mkv')).toMatch(/\/6\.mkv$/);
    expect(ts.streamUrl('episode', 7, 'mkv')).toMatch(/\/series\/u1\/.+\/7\.mkv$/);
    expect(ts.streamUrl('series', 7)).toMatch(/\/series\/.+\/7\.mp4$/);
  });
  it('keeps a path in the server URL', () => {
    const c = client(() => ({ json: [] }), { server: 'http://h.example/panel//' }).c;
    expect(c.guideUrl()).toMatch(/^http:\/\/h\.example\/panel\/xmltv\.php\?/);
  });
});

describe('requests', () => {
  it('carry the transport headers and the credentials in the API URL', async () => {
    const transport = { userAgent: 'UA/1', referer: 'http://r.example/' };
    const { c, requests } = client(() => ({ json: [] }), { transport });
    await c.liveStreams();
    expect(requests[0]?.headers).toEqual(transportHeaders(transport));
    const u = new URL(requests[0]?.url ?? '');
    expect(u.pathname).toBe('/player_api.php');
    expect(u.searchParams.get('username')).toBe(USER);
    expect(u.searchParams.get('password')).toBe(PASS);
  });
});

describe('never leaks credentials in errors', () => {
  it('keeps password, its encoding and the URL out of every failure', async () => {
    const routes: Reply[] = [
      { throws: true },
      { text: 'oops', status: 500 },
      { text: 'not json' },
      { json: { nothing: true } },
      { fail: elvError('network', 'timeout') },
      { text: '', status: 401 },
    ];
    for (const reply of routes) {
      const { c } = client(() => reply);
      const calls: Array<(x: XtreamClient) => Promise<Result<unknown>>> = [
        (x) => x.account(),
        (x) => x.liveStreams(),
        (x) => x.seriesInfo(1),
        (x) => x.shortEpg(1),
      ];
      for (const call of calls) {
        const text = JSON.stringify(await call(c));
        expect(text).not.toContain(PASS);
        expect(text).not.toContain(encodeURIComponent(PASS));
        expect(text).not.toContain('player_api');
        expect(text).not.toContain('h.example');
      }
    }
  });
});

describe('pasted server URLs', () => {
  const pw = ['pass', 'word'].join('');
  const pasted = `username=pasted&${pw}=zzz`;
  const forms = [
    'http://h.example/player_api.php',
    `http://h.example/player_api.php?${pasted}`,
    `http://h.example/get.php?${pasted}&type=m3u_plus&output=ts`,
    `http://h.example/xmltv.php?${pasted}#frag`,
    'http://h.example/xmltv.php/',
    'http://h.example/',
  ];
  it.each(forms)('normalizes %s', async (server) => {
    const { c, requests } = client(() => ({ json: [] }), { server });
    expect(c.guideUrl()).toBe(
      `http://h.example/xmltv.php?username=${USER}&${pw}=${encodeURIComponent(PASS)}`,
    );
    expect(c.playlistUrl()).toMatch(/^http:\/\/h\.example\/get\.php\?username=u1&/);
    await c.liveStreams();
    expect(requests[0]?.url).toMatch(/^http:\/\/h\.example\/player_api\.php\?username=u1&/);
    for (const url of [
      c.playlistUrl(),
      c.guideUrl(),
      c.streamUrl('live', 1),
      requests[0]?.url ?? '',
    ]) {
      expect(url).not.toContain('pasted');
      expect(url).not.toContain('zzz');
    }
  });
  it('keeps a path prefix', () => {
    const { c } = client(() => ({ json: [] }), {
      server: 'http://h.example/panel/player_api.php?x=1',
    });
    expect(c.guideUrl()).toMatch(/^http:\/\/h\.example\/panel\/xmltv\.php\?/);
  });
});

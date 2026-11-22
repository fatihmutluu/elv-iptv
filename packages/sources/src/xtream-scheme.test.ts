import { elvError, err, type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createXtreamClient } from './xtream';
import {
  clearXtreamSchemeCache,
  getCachedXtreamScheme,
  hasExplicitScheme,
  resolveXtreamBaseUrl,
  setCachedXtreamScheme,
} from './xtream-scheme';
import { PASS, USER, value } from './xtream-test-helpers';

const enc = (s: string) => new TextEncoder().encode(s);

function jsonBody(payload: unknown): AsyncIterable<Uint8Array> {
  const bytes = enc(JSON.stringify(payload));
  return {
    async *[Symbol.asyncIterator]() {
      yield bytes;
    },
  };
}

describe('xtream-scheme utilities (#229)', () => {
  it('detects explicit http:// and https:// schemes case-insensitively', () => {
    expect(hasExplicitScheme('https://panel.example')).toBe(true);
    expect(hasExplicitScheme('http://panel.example:8080')).toBe(true);
    expect(hasExplicitScheme('  HTTPS://panel.example/panel  ')).toBe(true);
    expect(hasExplicitScheme('  HTTP://panel.example  ')).toBe(true);
    expect(hasExplicitScheme('panel.example')).toBe(false);
    expect(hasExplicitScheme('panel.example:8443/panel')).toBe(false);
    expect(hasExplicitScheme('  panel.example/player_api.php?u=1  ')).toBe(false);
    expect(hasExplicitScheme('')).toBe(false);
  });

  it('caches schemes per HttpClient and normalized hostKey without leaking across clients', () => {
    const httpA: HttpClient = {
      async get() {
        return err(elvError('network', 'fetch-failed'));
      },
    };
    const httpB: HttpClient = {
      async get() {
        return err(elvError('network', 'fetch-failed'));
      },
    };

    expect(getCachedXtreamScheme(httpA, 'panel.example')).toBeUndefined();
    setCachedXtreamScheme(httpA, 'PANEL.EXAMPLE:8080/panel/', 'http');

    expect(getCachedXtreamScheme(httpA, 'panel.example:8080')).toBe('http');
    expect(getCachedXtreamScheme(httpA, 'https://panel.example:8080/player_api.php')).toBe('http');
    expect(getCachedXtreamScheme(httpB, 'panel.example:8080')).toBeUndefined();

    clearXtreamSchemeCache(httpA);
    expect(getCachedXtreamScheme(httpA, 'panel.example:8080')).toBeUndefined();
  });

  it('resolves scheme-less servers HTTPS-first, honors cached scheme, and preserves explicit schemes', () => {
    const http: HttpClient = {
      async get() {
        return err(elvError('network', 'fetch-failed'));
      },
    };

    // Uncached scheme-less defaults to https://
    expect(resolveXtreamBaseUrl('panel.example:8443/panel/player_api.php?x=1', http)).toBe(
      'https://panel.example:8443/panel',
    );
    expect(resolveXtreamBaseUrl('panel.example')).toBe('https://panel.example');

    // Cached http:// applies to scheme-less inputs
    setCachedXtreamScheme(http, 'panel.example:8443', 'http');
    expect(resolveXtreamBaseUrl('panel.example:8443/panel/get.php?a=b', http)).toBe(
      'http://panel.example:8443/panel',
    );

    // Explicit scheme is ALWAYS preserved regardless of cache
    expect(resolveXtreamBaseUrl('https://panel.example:8443/panel/', http)).toBe(
      'https://panel.example:8443/panel',
    );
    setCachedXtreamScheme(http, 'panel.example:8443', 'https');
    expect(resolveXtreamBaseUrl('HTTP://panel.example:8443/xmltv.php', http)).toBe(
      'http://panel.example:8443',
    );
  });
});

describe('createXtreamClient HTTPS-first probing and SchemeCache (#229)', () => {
  it('probes https:// first for scheme-less server, caches https on success, and uses https for all endpoints', async () => {
    const calls: Array<{ url: string; timeoutMs?: number }> = [];
    const http: HttpClient = {
      async get(url, opts) {
        calls.push({
          url,
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
        });
        return ok({ status: 200, headers: {}, body: jsonBody([]) });
      },
    };

    const c = createXtreamClient({
      http,
      server: 'secure.example:8443/panel',
      username: USER,
      password: PASS,
    });

    expect(value(await c.liveStreams())).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toMatch(/^https:\/\/secure\.example:8443\/panel\/player_api\.php\?/);
    expect(calls[0]?.timeoutMs).toBeLessThan(60_000);
    expect(getCachedXtreamScheme(http, 'secure.example:8443')).toBe('https');

    // Subsequent call uses normal timeout and cached https
    expect(value(await c.vodStreams())).toEqual([]);
    expect(calls[1]?.url).toMatch(/^https:\/\/secure\.example:8443\/panel\/player_api\.php\?/);
    expect(calls[1]?.timeoutMs).toBe(60_000);
    expect(c.streamUrl('live', 10)).toMatch(/^https:\/\/secure\.example:8443\/panel\/live\//);
    expect(c.playlistUrl()).toMatch(/^https:\/\/secure\.example:8443\/panel\/get\.php\?/);
    expect(c.guideUrl()).toMatch(/^https:\/\/secure\.example:8443\/panel\/xmltv\.php\?/);
  });

  it('falls back to http:// on TLS/transport failure, caches http for subsequent endpoints, streamRows, and URL builders', async () => {
    const urls: string[] = [];
    const http: HttpClient = {
      async get(url) {
        urls.push(url);
        if (url.startsWith('https://')) {
          return err(elvError('network', 'fetch-failed'));
        }
        if (url.includes('get_live_streams')) {
          return ok({
            status: 200,
            headers: {},
            body: jsonBody([{ stream_id: 7, name: 'News', category_id: '1' }]),
          });
        }
        return ok({ status: 200, headers: {}, body: jsonBody([]) });
      },
    };

    const c = createXtreamClient({
      http,
      server: 'legacy.example:8080',
      username: USER,
      password: PASS,
    });

    // First call probes https:// -> transport fail -> falls back to http:// and caches 'http'
    const live = value(await c.liveStreams());
    expect(live).toHaveLength(1);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toMatch(/^https:\/\/legacy\.example:8080\/player_api\.php\?/);
    expect(urls[1]).toMatch(/^http:\/\/legacy\.example:8080\/player_api\.php\?/);
    expect(getCachedXtreamScheme(http, 'legacy.example:8080')).toBe('http');

    // Subsequent endpoints and URL builders immediately use http:// with ZERO https probes
    expect(value(await c.vodStreams())).toEqual([]);
    expect(urls).toHaveLength(3);
    expect(urls[2]).toMatch(/^http:\/\/legacy\.example:8080\/player_api\.php\?/);
    expect(c.streamUrl('live', 7)).toMatch(/^http:\/\/legacy\.example:8080\/live\//);
    expect(c.playlistUrl()).toMatch(/^http:\/\/legacy\.example:8080\/get\.php\?/);
    expect(c.guideUrl()).toMatch(/^http:\/\/legacy\.example:8080\/xmltv\.php\?/);

    // Sibling client sharing the same HttpClient also immediately uses http://
    const sibling = createXtreamClient({
      http,
      server: 'legacy.example:8080/player_api.php',
      username: USER,
      password: PASS,
    });
    expect(sibling.streamUrl('movie', 9)).toMatch(/^http:\/\/legacy\.example:8080\/movie\//);
    const streamed: number[] = [];
    const gen = sibling.streamLiveStreams();
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        expect(step.value.ok).toBe(true);
        break;
      }
      for (const item of step.value) streamed.push(item.id);
    }
    expect(streamed).toEqual([7]);
    expect(urls).toHaveLength(4);
    expect(urls[3]).toMatch(/^http:\/\/legacy\.example:8080\/player_api\.php\?/);
  });

  it('also probes and falls back to http:// in streamRows when first call is streaming', async () => {
    const urls: string[] = [];
    const http: HttpClient = {
      async get(url) {
        urls.push(url);
        if (url.startsWith('https://')) {
          return err(elvError('network', 'timeout'));
        }
        return ok({
          status: 200,
          headers: {},
          body: jsonBody([{ stream_id: 1, name: 'Ch 1', category_id: '1' }]),
        });
      },
    };

    const c = createXtreamClient({
      http,
      server: 'stream-only.example',
      username: USER,
      password: PASS,
    });
    const ids: number[] = [];
    const gen = c.streamLiveStreams();
    for (;;) {
      const step = await gen.next();
      if (step.done) {
        expect(step.value.ok).toBe(true);
        break;
      }
      for (const item of step.value) ids.push(item.id);
    }
    expect(ids).toEqual([1]);
    expect(urls.map((u) => new URL(u).protocol)).toEqual(['https:', 'http:']);
    expect(getCachedXtreamScheme(http, 'stream-only.example')).toBe('http');
  });

  it.each([
    [401, 'auth', 'http-401'],
    [403, 'auth', 'http-403'],
    [404, 'network', 'http-404'],
    [429, 'network', 'http-429'],
    [500, 'network', 'http-500'],
    [503, 'network', 'http-503'],
  ] as const)(
    'never falls back to http:// when https:// responds with HTTP %i and caches https',
    async (status, category, code) => {
      const urls: string[] = [];
      const http: HttpClient = {
        async get(url) {
          urls.push(url);
          return ok({ status, headers: {}, body: jsonBody({}) });
        },
      };

      const c = createXtreamClient({
        http,
        server: 'panel-err.example',
        username: USER,
        password: PASS,
      });
      const res = await c.liveStreams();
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.category).toBe(category);
        expect(res.error.code).toBe(code);
      }
      expect(urls).toHaveLength(1);
      expect(urls[0]).toMatch(/^https:\/\//);
      expect(getCachedXtreamScheme(http, 'panel-err.example')).toBe('https');
    },
  );

  it('never falls back to http:// on too-many-redirects and caches https (#229)', async () => {
    const urls: string[] = [];
    const http: HttpClient = {
      async get(url) {
        urls.push(url);
        return err(elvError('network', 'too-many-redirects'));
      },
    };

    const c = createXtreamClient({
      http,
      server: 'loop.example',
      username: USER,
      password: PASS,
    });
    const res = await c.liveStreams();
    expect(res).toEqual({
      ok: false,
      error: { category: 'network', code: 'too-many-redirects' },
    });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^https:\/\//);
    expect(getCachedXtreamScheme(http, 'loop.example')).toBe('https');
  });

  it('does not poison cache when both https:// and http:// fail with transport errors', async () => {
    const urls: string[] = [];
    const http: HttpClient = {
      async get(url) {
        urls.push(url);
        return err(elvError('network', 'fetch-failed'));
      },
    };
    const c = createXtreamClient({
      http,
      server: 'offline.example',
      username: USER,
      password: PASS,
    });
    const res = await c.liveStreams();
    expect(res.ok).toBe(false);
    expect(urls.map((u) => new URL(u).protocol)).toEqual(['https:', 'http:']);
    expect(getCachedXtreamScheme(http, 'offline.example')).toBeUndefined();
  });

  it('never auto-switches schemes when explicit http:// or https:// is provided', async () => {
    const httpUrls: string[] = [];
    const httpClient1: HttpClient = {
      async get(url) {
        httpUrls.push(url);
        return err(elvError('network', 'fetch-failed'));
      },
    };
    const explicitHttps = createXtreamClient({
      http: httpClient1,
      server: 'https://strict-https.example',
      username: USER,
      password: PASS,
    });
    expect((await explicitHttps.liveStreams()).ok).toBe(false);
    expect(httpUrls).toHaveLength(1);
    expect(httpUrls[0]).toMatch(/^https:\/\//);
    expect(getCachedXtreamScheme(httpClient1, 'strict-https.example')).toBeUndefined();

    const explicitHttpUrls: string[] = [];
    const httpClient2: HttpClient = {
      async get(url) {
        explicitHttpUrls.push(url);
        return ok({ status: 200, headers: {}, body: jsonBody([]) });
      },
    };
    const explicitHttp = createXtreamClient({
      http: httpClient2,
      server: 'http://strict-http.example',
      username: USER,
      password: PASS,
    });
    expect(value(await explicitHttp.liveStreams())).toEqual([]);
    expect(explicitHttpUrls).toHaveLength(1);
    expect(explicitHttpUrls[0]).toMatch(/^http:\/\//);
    expect(getCachedXtreamScheme(httpClient2, 'strict-http.example')).toBeUndefined();
  });
});

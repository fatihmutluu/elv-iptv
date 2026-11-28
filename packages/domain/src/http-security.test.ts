import { describe, expect, it, vi } from 'vitest';
import { createFetchHttpClient, type FetchLike } from './index';

function headersOf(entries: Record<string, string>) {
  return {
    forEach(cb: (value: string, key: string) => void) {
      for (const [k, v] of Object.entries(entries)) cb(v, k);
    },
  };
}

function emptyBody(): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      // empty
    },
  };
}

describe('createFetchHttpClient security invariants', () => {
  it('enforces the 10-hop redirect cap (allows 10 hops, rejects 11th with network/too-many-redirects)', async () => {
    const makeRedirectFetch = (totalRedirects: number): FetchLike => {
      let seen = 0;
      return async () => {
        seen += 1;
        if (seen <= totalRedirects) {
          return {
            status: 302,
            headers: headersOf({ Location: `https://origin.example/hop-${seen}` }),
            body: emptyBody(),
          };
        }
        return {
          status: 200,
          headers: headersOf({ 'Content-Type': 'text/plain' }),
          body: emptyBody(),
        };
      };
    };

    const okRes = await createFetchHttpClient(makeRedirectFetch(10)).get(
      'https://origin.example/start',
    );
    expect(okRes.ok).toBe(true);
    if (okRes.ok) {
      expect(okRes.value.finalUrl).toBe('https://origin.example/hop-10');
      await okRes.value.body[Symbol.asyncIterator]().return?.();
    }

    const tooMany = await createFetchHttpClient(makeRedirectFetch(11)).get(
      'https://origin.example/start',
    );
    expect(tooMany).toEqual({
      ok: false,
      error: { category: 'network', code: 'too-many-redirects' },
    });
  });

  it('strips all 5 credential headers on cross-origin redirects while retaining them on same-origin redirects', async () => {
    const seenCalls: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seenCalls.push({ url, ...(init.headers ? { headers: { ...init.headers } } : {}) });
      if (url === 'https://origin.example:443/start') {
        return {
          status: 302,
          headers: headersOf({ Location: 'https://origin.example/same-origin' }),
          body: emptyBody(),
        };
      }
      if (url === 'https://origin.example/same-origin') {
        return {
          status: 307,
          headers: headersOf({ Location: 'https://cdn.example/cross-origin' }),
          body: emptyBody(),
        };
      }
      return {
        status: 200,
        headers: headersOf({}),
        body: emptyBody(),
      };
    };

    const res = await createFetchHttpClient(fetchImpl).get('https://origin.example:443/start', {
      headers: {
        Authorization: 'Bearer tok-1',
        'Proxy-Authorization': 'Basic proxy-1',
        Cookie: 'sid=abc',
        'X-Api-Key': 'key-1',
        'X-Auth-Token': 'auth-1',
        'User-Agent': 'ELV/1.0',
        Referer: 'https://origin.example/',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) await res.value.body[Symbol.asyncIterator]().return?.();

    expect(seenCalls).toHaveLength(3);
    // Hop 1 (same origin via default port 443): all 5 credential headers retained
    expect(seenCalls[1]?.headers).toEqual({
      Authorization: 'Bearer tok-1',
      'Proxy-Authorization': 'Basic proxy-1',
      Cookie: 'sid=abc',
      'X-Api-Key': 'key-1',
      'X-Auth-Token': 'auth-1',
      'User-Agent': 'ELV/1.0',
      Referer: 'https://origin.example/',
    });
    // Hop 2 (cross origin): all 5 credential headers stripped, non-credential headers preserved
    expect(seenCalls[2]?.headers).toEqual({
      'User-Agent': 'ELV/1.0',
      Referer: 'https://origin.example/',
    });
  });

  it('strips all 5 credential headers on scheme downgrade and cross-host redirects while preserving same-host port moves (NET-2)', async () => {
    const reqHeaders = {
      Authorization: 'Bearer tok',
      'Proxy-Authorization': 'Basic p',
      Cookie: 'a=b',
      'X-Api-Key': 'k',
      'X-Auth-Token': 't',
      'User-Agent': 'ELV/1.0',
    };
    for (const [target, expected] of [
      ['http://origin.example/downgrade', { 'User-Agent': 'ELV/1.0' }],
      ['https://other.example/cross-host', { 'User-Agent': 'ELV/1.0' }],
      ['https://origin.example:8443/alt-port', reqHeaders],
    ] as const) {
      const seenHeaders: Array<Record<string, string> | undefined> = [];
      const fetchImpl: FetchLike = async (url, init) => {
        seenHeaders.push(init.headers ? { ...init.headers } : undefined);
        if (url === 'https://origin.example/start') {
          return {
            status: 302,
            headers: headersOf({ Location: target }),
            body: emptyBody(),
          };
        }
        return { status: 200, headers: headersOf({}), body: emptyBody() };
      };
      const res = await createFetchHttpClient(fetchImpl).get('https://origin.example/start', {
        headers: reqHeaders,
      });
      expect(res.ok).toBe(true);
      if (res.ok) await res.value.body[Symbol.asyncIterator]().return?.();
      expect(seenHeaders[1]).toEqual(expected);
    }
  });

  it.each([
    'file:///etc/passwd',
    'file://localhost/C:/Windows/win.ini',
    'javascript:alert(1)',
    'javascript://origin.example/%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'ftp://files.example/list.m3u',
  ])(
    'rejects redirect Location with disallowed scheme %s without fetching it',
    async (location) => {
      const fetchSpy = vi.fn<FetchLike>(async () => ({
        status: 302,
        headers: headersOf({ Location: location }),
        body: emptyBody(),
      }));

      const res = await createFetchHttpClient(fetchSpy).get('https://origin.example/start');
      expect(res).toEqual({
        ok: false,
        error: { category: 'network', code: 'http-302' },
      });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    },
  );

  it('strips CRLF header injection and stays safe against __proto__ headers', async () => {
    let sentHeaders: Record<string, string> | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      sentHeaders = init.headers;
      return { status: 200, headers: headersOf({}), body: emptyBody() };
    };

    const hostile = JSON.parse(
      '{"User-Agent":"ELV/1.0\\r\\nX-Injected: pwn","Bad Header":"drop","__proto__":"safe\\nval"}',
    ) as Record<string, string>;

    const res = await createFetchHttpClient(fetchImpl).get('https://origin.example/ok', {
      headers: hostile,
    });
    expect(res.ok).toBe(true);
    if (res.ok) await res.value.body[Symbol.asyncIterator]().return?.();

    expect(sentHeaders).toBeDefined();
    expect(sentHeaders?.['User-Agent']).toBe('ELV/1.0X-Injected: pwn');
    expect(sentHeaders?.['Bad Header']).toBeUndefined();
    expect(Object.getPrototypeOf(sentHeaders)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects non-HTTP(S) initial URLs without invoking fetchImpl', async () => {
    const fetchSpy = vi.fn<FetchLike>(async () => ({
      status: 200,
      headers: headersOf({}),
      body: emptyBody(),
    }));
    const client = createFetchHttpClient(fetchSpy);
    for (const bad of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/plain,hello',
      'ftp://files.example/list.m3u',
      '/relative/path',
    ]) {
      expect(await client.get(bad)).toEqual({
        ok: false,
        error: { category: 'network', code: 'fetch-failed' },
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('propagates valid HTTP(S) res.url into finalUrl and redirect base, and rejects non-HTTP(S) res.url after cancelling body', async () => {
    const redirected = await createFetchHttpClient(async () => ({
      status: 200,
      url: 'https://cdn.example/redirected/list.m3u',
      headers: headersOf({}),
      body: emptyBody(),
    })).get('https://origin.example/start');
    expect(redirected.ok).toBe(true);
    if (redirected.ok) {
      expect(redirected.value.finalUrl).toBe('https://cdn.example/redirected/list.m3u');
      await redirected.value.body[Symbol.asyncIterator]().return?.();
    }

    // Relative redirect resolves against res.url when platform already followed an earlier hop
    const seenUrls: string[] = [];
    const relativeAfterNativeHop = await createFetchHttpClient(async (u) => {
      seenUrls.push(u);
      if (seenUrls.length === 1) {
        return {
          status: 302,
          url: 'https://cdn.example/sub/step1',
          headers: headersOf({ Location: 'step2.m3u' }),
          body: emptyBody(),
        };
      }
      return { status: 200, headers: headersOf({}), body: emptyBody() };
    }).get('https://origin.example/start');
    expect(relativeAfterNativeHop.ok).toBe(true);
    if (relativeAfterNativeHop.ok) {
      expect(seenUrls).toEqual([
        'https://origin.example/start',
        'https://cdn.example/sub/step2.m3u',
      ]);
      expect(relativeAfterNativeHop.value.finalUrl).toBe('https://cdn.example/sub/step2.m3u');
      await relativeAfterNativeHop.value.body[Symbol.asyncIterator]().return?.();
    }

    // Non-HTTP(S) res.url must cancel/discard body and fail closed
    let cancelled = false;
    const badResUrl = await createFetchHttpClient(async () => ({
      status: 200,
      url: 'file:///etc/passwd',
      headers: headersOf({}),
      body: {
        getReader: () => ({
          read: async () => ({ done: true }),
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => undefined,
        }),
      },
    })).get('https://origin.example/start');
    expect(badResUrl).toEqual({
      ok: false,
      error: { category: 'network', code: 'fetch-failed' },
    });
    expect(cancelled).toBe(true);
  });

  it('echoes same-origin 302 Set-Cookie headers across redirects, merges with caller Cookie, and never leaks cross-origin or Secure over http (#171)', async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, ...(init.headers ? { headers: { ...init.headers } } : {}) });
      if (url === 'https://origin.example/live/start') {
        return {
          status: 302,
          headers: {
            forEach(cb) {
              cb('https://origin.example/live/hop1', 'Location');
            },
            getSetCookie: () => [
              'edge=tok1; Path=/live; Secure',
              'sid=updated; Path=/; Domain=.example',
            ],
          },
          body: emptyBody(),
        };
      }
      if (url === 'https://origin.example/live/hop1') {
        return {
          status: 302,
          headers: headersOf({
            Location: 'https://cdn.example/media/step1',
          }),
          body: emptyBody(),
        };
      }
      if (url === 'https://cdn.example/media/step1') {
        return {
          status: 302,
          headers: {
            forEach(cb) {
              cb('https://cdn.example/media/step2', 'Location');
            },
            get(name) {
              if (name.toLowerCase() === 'set-cookie') {
                return 'cdn_s=abc; Expires=Wed, 21 Oct 2030 07:28:00 GMT; Path=/media, cdn_f=1; Path=/';
              }
              return null;
            },
          },
          body: emptyBody(),
        };
      }
      if (url === 'https://cdn.example/media/step2') {
        return {
          status: 302,
          headers: headersOf({ Location: 'https://origin.example/live/bounce' }),
          body: emptyBody(),
        };
      }
      return { status: 200, headers: headersOf({}), body: emptyBody() };
    };

    const res = await createFetchHttpClient(fetchImpl).get('https://origin.example/live/start', {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'caller=keep; sid=old',
        'User-Agent': 'ELV/1.0',
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) await res.value.body[Symbol.asyncIterator]().return?.();

    expect(seen).toHaveLength(5);
    // Hop 1 (same origin): caller Cookie merged with Set-Cookie (jar overrides sid, keeps caller=keep, adds edge=tok1)
    expect(seen[1]?.headers?.Authorization).toBe('Bearer secret');
    expect(seen[1]?.headers?.Cookie).toBe('caller=keep; edge=tok1; sid=updated');
    // Hop 2 (cross origin to cdn.example): Authorization + caller Cookie + origin jar cookies ALL stripped
    expect(seen[2]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
    // Hop 3 (same origin on cdn.example): receives ONLY cdn.example's Set-Cookie (via get('set-cookie') fallback!)
    expect(seen[3]?.headers).toEqual({
      'User-Agent': 'ELV/1.0',
      Cookie: 'cdn_s=abc; cdn_f=1',
    });
    // Hop 4 (bounce back to origin.example): caller Authorization stays stripped, cdn cookies NEVER leak, origin jar cookies apply
    expect(seen[4]?.headers?.Authorization).toBeUndefined();
    expect(seen[4]?.headers?.Cookie).toBe('edge=tok1; sid=updated');
  });

  it('never leaks Secure cookies on https-to-http redirect downgrade or http Set-Cookie (#171)', async () => {
    const seen: Array<{ url: string; headers?: Record<string, string> }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      seen.push({ url, ...(init.headers ? { headers: { ...init.headers } } : {}) });
      if (url === 'https://origin.example/start') {
        return {
          status: 302,
          headers: headersOf({
            Location: 'http://origin.example/downgraded',
            'Set-Cookie': 'sec=secret; Path=/; Secure',
          }),
          body: emptyBody(),
        };
      }
      if (url === 'http://origin.example/downgraded') {
        return {
          status: 302,
          headers: headersOf({
            Location: 'http://origin.example/final',
            'Set-Cookie': 'http_sec=no; Path=/; Secure, plain=yes; Path=/',
          }),
          body: emptyBody(),
        };
      }
      return { status: 200, headers: headersOf({}), body: emptyBody() };
    };

    const res = await createFetchHttpClient(fetchImpl).get('https://origin.example/start');
    expect(res.ok).toBe(true);
    if (res.ok) await res.value.body[Symbol.asyncIterator]().return?.();

    expect(seen[1]?.headers?.Cookie).toBeUndefined();
    expect(seen[2]?.headers?.Cookie).toBe('plain=yes');
  });
});

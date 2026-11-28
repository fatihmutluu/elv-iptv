import { describe, expect, it } from 'vitest';
import { createFetchHttpClient, type FetchLike, type HttpResponse } from './http';
import type { Result } from './result';

function headers(h: Record<string, string>) {
  return {
    forEach: (cb: (v: string, k: string) => void) => {
      for (const [k, v] of Object.entries(h)) cb(v, k);
    },
  };
}

function okOf(r: Result<HttpResponse>): HttpResponse {
  if (!r.ok) throw new Error('expected ok');
  return r.value;
}

describe('createFetchHttpClient same-host redirect credential policy (NET-2)', () => {
  const creds = {
    Authorization: 'Bearer secret-token',
    'Proxy-Authorization': 'Basic proxy-tok',
    Cookie: 'sid=abc',
    'X-Api-Key': 'api-k',
    'X-Auth-Token': 'auth-t',
    'User-Agent': 'ELV/1.0',
  };

  it('preserves credentials on same-host http -> https upgrades', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, headers: init.headers });
      if (calls.length === 1) {
        return {
          status: 301,
          headers: headers({ Location: 'https://panel.example/secure/list.m3u' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: null };
    });

    const res = okOf(await client.get('http://panel.example/list.m3u', { headers: creds }));
    expect(res.finalUrl).toBe('https://panel.example/secure/list.m3u');
    expect(calls).toHaveLength(2);
    expect(calls[1]?.headers).toEqual(creds);
  });

  it('preserves credentials on same-host port changes (:80 -> :8080)', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, headers: init.headers });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: headers({ Location: 'http://panel.example:8080/live/stream' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: null };
    });

    const res = okOf(await client.get('http://panel.example:80/live/stream', { headers: creds }));
    expect(res.finalUrl).toBe('http://panel.example:8080/live/stream');
    expect(calls[1]?.headers).toEqual(creds);
  });

  it('strips credentials on https -> http downgrades', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, headers: init.headers });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: headers({ Location: 'http://panel.example/plain' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: null };
    });

    expect((await client.get('https://panel.example/secure', { headers: creds })).ok).toBe(true);
    expect(calls[1]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
  });

  it('strips credentials on http -> https -> http downgrade chain and never re-attaches them', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, headers: init.headers });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: headers({ Location: 'https://panel.example/hop1' }),
          body: null,
        };
      }
      if (calls.length === 2) {
        return {
          status: 302,
          headers: headers({ Location: 'http://panel.example/hop2-downgrade' }),
          body: null,
        };
      }
      if (calls.length === 3) {
        return {
          status: 302,
          headers: headers({ Location: 'https://panel.example/hop3-reupgrade' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: null };
    });

    expect((await client.get('http://panel.example/start', { headers: creds })).ok).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.headers).toEqual(creds);
    expect(calls[1]?.headers).toEqual(creds);
    expect(calls[2]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
    expect(calls[3]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
  });

  it('strips credentials on cross-host redirects even over https', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, headers: init.headers });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: headers({ Location: 'https://other.example/file' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: null };
    });

    expect((await client.get('https://panel.example/start', { headers: creds })).ok).toBe(true);
    expect(calls[1]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
  });

  it('preserves credentials across trailing DNS root dot equivalence', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, headers: init.headers });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: headers({ Location: 'https://panel.example:8443/next' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: null };
    });

    const fetchRes = await client.get('http://panel.example./start', { headers: creds });
    expect(fetchRes.ok).toBe(true);
    expect(calls[1]?.headers).toEqual(creds);
  });

  it('strips credentials if initial response.url upgraded to https and next hop downgrades to http', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const fetchImpl: FetchLike = async (u, init) => {
      calls.push({ url: u, headers: init.headers });
      if (calls.length === 1) {
        return {
          status: 302,
          url: 'https://panel.example/upgraded-hop',
          headers: headers({ Location: 'http://panel.example/plain' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: null };
    };
    const client = createFetchHttpClient(fetchImpl);
    expect((await client.get('http://panel.example/start', { headers: creds })).ok).toBe(true);
    expect(calls[1]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
  });

  it('handles IPv6 literal http -> https -> http downgrade cleanly and preserves same-host IPv6 https port moves (M8)', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, headers: init.headers });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: headers({ Location: 'https://[::1]/hop1' }),
          body: null,
        };
      }
      if (calls.length === 2) {
        return {
          status: 302,
          headers: headers({ Location: 'https://[::1]:8443/hop2' }),
          body: null,
        };
      }
      if (calls.length === 3) {
        return {
          status: 302,
          headers: headers({ Location: 'http://[::1]:8080/hop3-downgrade' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: null };
    });

    expect((await client.get('http://[::1]/start', { headers: creds })).ok).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls[1]?.headers).toEqual(creds);
    expect(calls[2]?.headers).toEqual(creds);
    expect(calls[3]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
  });
});

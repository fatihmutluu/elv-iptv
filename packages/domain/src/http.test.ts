import { describe, expect, it, vi } from 'vitest';
import { createFetchHttpClient, type FetchLike, type HttpResponse, httpStatusError } from './http';
import type { Result } from './result';

const enc = (s: string) => new TextEncoder().encode(s);

async function collect(body: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const c of body) out.push(new TextDecoder().decode(c));
  return out;
}

function headers(h: Record<string, string>) {
  return {
    forEach: (cb: (v: string, k: string) => void) => {
      for (const [k, v] of Object.entries(h)) cb(v, k);
    },
  };
}

function readerBody(chunks: Uint8Array[]) {
  let i = 0;
  let released = false;
  return {
    body: {
      getReader: () => ({
        read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
          const value = chunks[i++];
          return value === undefined ? { done: true } : { done: false, value };
        },
        releaseLock: () => {
          released = true;
        },
      }),
    },
    released: () => released,
  };
}

function okOf(r: Result<HttpResponse>): HttpResponse {
  if (!r.ok) throw new Error('expected ok');
  return r.value;
}

const abortable: FetchLike = (_u, init) =>
  new Promise((_res, rej) => {
    init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
  });

describe('createFetchHttpClient', () => {
  it('streams a reader body in order and lower-cases headers', async () => {
    const rb = readerBody([enc('a'), enc('b')]);
    const client = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({ 'Content-Type': 'x/y' }),
      body: rb.body,
    }));
    const res = okOf(await client.get('http://h/x'));
    expect(res.headers).toEqual({ 'content-type': 'x/y' });
    expect(await collect(res.body)).toEqual(['a', 'b']);
    expect(rb.released()).toBe(true);
  });

  it('streams an async-iterable body', async () => {
    async function* gen() {
      yield enc('1');
      yield enc('2');
    }
    const client = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({}),
      body: gen(),
    }));
    expect(await collect(okOf(await client.get('http://h/x')).body)).toEqual(['1', '2']);
  });

  it('yields nothing for a null body', async () => {
    const client = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({}),
      body: null,
    }));
    expect(await collect(okOf(await client.get('http://h/x')).body)).toEqual([]);
  });

  it('returns ok with headers and an empty body for HTTP 304 Not Modified', async () => {
    const client = createFetchHttpClient(async () => ({
      status: 304,
      headers: headers({ ETag: '"v1"', 'Last-Modified': 'Mon, 15 Jun 2026 00:00:00 GMT' }),
      body: null,
    }));
    const res = okOf(await client.get('http://h/x', { headers: { 'if-none-match': '"v1"' } }));
    expect(res.status).toBe(304);
    expect(res.headers).toEqual({
      etag: '"v1"',
      'last-modified': 'Mon, 15 Jun 2026 00:00:00 GMT',
    });
    expect(await collect(res.body)).toEqual([]);
  });

  it('works with a real WHATWG Response body', async () => {
    const client = createFetchHttpClient(async () => new Response('hello'));
    expect((await collect(okOf(await client.get('http://h/x')).body)).join('')).toBe('hello');
  });

  it('forwards request headers and a signal', async () => {
    let seen: Parameters<FetchLike>[1] | undefined;
    const client = createFetchHttpClient(async (_u, init) => {
      seen = init;
      return { status: 200, headers: headers({}), body: null };
    });
    await client.get('http://h/x', { headers: { 'user-agent': 'A' } });
    expect(seen?.headers).toEqual({ 'user-agent': 'A' });
    expect(seen?.signal).toBeDefined();
  });

  it.each([
    [401, 'auth'],
    [403, 'auth'],
    [500, 'network'],
    [404, 'network'],
  ])('maps status %i', async (status, category) => {
    const client = createFetchHttpClient(async () => ({
      status,
      headers: headers({}),
      body: null,
    }));
    expect(await client.get('http://h/x')).toEqual({
      ok: false,
      error: { category, code: `http-${status}` },
    });
    expect(httpStatusError(status)).toEqual({ category, code: `http-${status}` });
  });

  const reset = (code = 'ECONNRESET', message = 'read ECONNRESET') =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(message), { code }),
    });

  it.each([
    ['ECONNRESET', 'read ECONNRESET'],
    ['EPIPE', 'write EPIPE'],
    ['UND_ERR_SOCKET', 'other side closed'],
  ])(
    'retries once when a reused connection fails with %s before any response',
    async (code, message) => {
      let calls = 0;
      const client = createFetchHttpClient(async () => {
        calls += 1;
        if (calls === 1) throw reset(code, message);
        return { status: 200, headers: headers({}), body: null };
      });
      expect((await client.get('http://h/x')).ok).toBe(true);
      expect(calls).toBe(2);
    },
  );

  it('retries on a cause message of "other side closed" without a code', async () => {
    let calls = 0;
    const client = createFetchHttpClient(async () => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new TypeError('fetch failed'), {
          cause: new Error('other side closed'),
        });
      return { status: 200, headers: headers({}), body: null };
    });
    expect((await client.get('http://h/x')).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it('does not retry other pre-response failures', async () => {
    let calls = 0;
    const client = createFetchHttpClient(async () => {
      calls += 1;
      throw new TypeError('fetch failed');
    });
    expect(await client.get('http://h/x')).toEqual({
      ok: false,
      error: { category: 'network', code: 'fetch-failed' },
    });
    expect(calls).toBe(1);
  });

  it('gives fetch-failed after a second reset', async () => {
    let calls = 0;
    const client = createFetchHttpClient(async () => {
      calls += 1;
      throw reset();
    });
    expect(await client.get('http://h/x')).toEqual({
      ok: false,
      error: { category: 'network', code: 'fetch-failed' },
    });
    expect(calls).toBe(2);
  });

  it('does not retry an aborted request', async () => {
    const controller = new AbortController();
    let calls = 0;
    const client = createFetchHttpClient(async () => {
      calls += 1;
      controller.abort();
      throw reset();
    });
    const r = await client.get('http://h/x', { signal: controller.signal });
    expect(r).toEqual({ ok: false, error: { category: 'network', code: 'aborted' } });
    expect(calls).toBe(1);
  });

  it('shares one timeout budget between the attempt and its retry', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const client = createFetchHttpClient(
        (_url, init) => {
          calls += 1;
          if (calls === 1) {
            return new Promise((_resolve, reject) => setTimeout(() => reject(reset()), 50));
          }
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        },
        { timeoutMs: 80 },
      );
      let result: Result<HttpResponse> | undefined;
      void client.get('http://h/x').then((r) => {
        result = r;
      });
      await vi.advanceTimersByTimeAsync(79);
      expect(calls).toBe(2);
      expect(result).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(result).toEqual({ ok: false, error: { category: 'network', code: 'timeout' } });
    } finally {
      vi.useRealTimers();
    }
  });

  it('maps a thrown TypeError to fetch-failed without leaking credentials', async () => {
    const url = 'http://user:secret@h/get.php?username=a&password=hunter2';
    const client = createFetchHttpClient(async (u) => {
      throw new TypeError(`Failed to fetch ${u}`);
    });
    const r = await client.get(url);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.category).toBe('network');
      expect(r.error.code).toBe('fetch-failed');
      const text = JSON.stringify(r.error);
      expect(text).not.toContain('secret');
      expect(text).not.toContain('hunter2');
    }
  });

  it('times out and aborts the signal', async () => {
    let signal: AbortSignal | undefined;
    const client = createFetchHttpClient((_u, init) => {
      signal = init.signal;
      return new Promise(() => {});
    });
    expect(await client.get('http://h/x', { timeoutMs: 10 })).toEqual({
      ok: false,
      error: { category: 'network', code: 'timeout' },
    });
    expect(signal?.aborted).toBe(true);
  });

  it('applies the default timeout', async () => {
    const client = createFetchHttpClient(abortable, { timeoutMs: 10 });
    expect(await client.get('http://h/x')).toEqual({
      ok: false,
      error: { category: 'network', code: 'timeout' },
    });
  });

  it('honours a caller abort, before and during the request', async () => {
    const client = createFetchHttpClient(abortable);
    const ctl = new AbortController();
    const p = client.get('http://h/x', { signal: ctl.signal });
    ctl.abort();
    expect(await p).toEqual({ ok: false, error: { category: 'network', code: 'aborted' } });
    const pre = new AbortController();
    pre.abort();
    expect(await client.get('http://h/x', { signal: pre.signal })).toEqual({
      ok: false,
      error: { category: 'network', code: 'aborted' },
    });
  });

  function trackedReader(chunks: string[]) {
    let i = 0;
    const state = { cancelled: 0, released: 0 };
    const body = {
      getReader: () => ({
        read: async (): Promise<{ done: boolean; value?: Uint8Array }> => {
          const c = chunks[i++];
          return c === undefined ? { done: true } : { done: false, value: enc(c) };
        },
        cancel: async () => {
          state.cancelled++;
        },
        releaseLock: () => {
          state.released++;
        },
      }),
    };
    return { body, state };
  }

  it('cancels and releases the stream when the consumer stops early', async () => {
    const t = trackedReader(['a', 'b', 'c']);
    const client = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({}),
      body: t.body,
    }));
    const res = okOf(await client.get('http://h/x'));
    for await (const _ of res.body) break;
    expect(t.state).toEqual({ cancelled: 1, released: 1 });
  });

  it('does not cancel a fully read stream', async () => {
    const t = trackedReader(['a']);
    const client = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({}),
      body: t.body,
    }));
    await collect(okOf(await client.get('http://h/x')).body);
    expect(t.state).toEqual({ cancelled: 0, released: 1 });
  });

  it('returns an early-stopped async iterable and tolerates a reader without cancel', async () => {
    let returned = 0;
    const iterable = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false, value: enc('x') }),
        return: async () => {
          returned++;
          return { done: true as const, value: undefined };
        },
      }),
    };
    const c1 = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({}),
      body: iterable,
    }));
    for await (const _ of okOf(await c1.get('http://h/x')).body) break;
    expect(returned).toBe(1);
    const plain = readerBody([enc('a'), enc('b')]);
    const c2 = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({}),
      body: plain.body,
    }));
    for await (const _ of okOf(await c2.get('http://h/x')).body) break;
    expect(plain.released()).toBe(true);
  });

  it('swallows failures while cancelling or releasing', async () => {
    const body = {
      getReader: () => ({
        read: async () => ({ done: false, value: enc('a') }),
        cancel: async () => {
          throw new Error('boom');
        },
        releaseLock: () => {
          throw new Error('boom');
        },
      }),
    };
    const client = createFetchHttpClient(async () => ({ status: 200, headers: headers({}), body }));
    for await (const _ of okOf(await client.get('http://h/x')).body) break;
  });

  it('cancels the body of a non-2xx response', async () => {
    const t = trackedReader(['err']);
    const client = createFetchHttpClient(async () => ({
      status: 500,
      headers: headers({}),
      body: t.body,
    }));
    expect(await client.get('http://h/x')).toEqual({
      ok: false,
      error: { category: 'network', code: 'http-500' },
    });
    expect(t.state).toEqual({ cancelled: 1, released: 1 });
  });

  it('ends the iteration with an abort error when the caller aborts mid-body', async () => {
    let cancelled = 0;
    let pending: () => void = () => {};
    let n = 0;
    const body = {
      getReader: () => ({
        read: (): Promise<{ done: boolean; value?: Uint8Array }> =>
          n++ === 0
            ? Promise.resolve({ done: false, value: enc('a') })
            : new Promise((r) => {
                pending = () => r({ done: true });
              }),
        cancel: async () => {
          cancelled++;
          pending();
        },
        releaseLock: () => {},
      }),
    };
    const ctl = new AbortController();
    const client = createFetchHttpClient(async () => ({ status: 200, headers: headers({}), body }));
    const res = okOf(await client.get('http://h/x', { signal: ctl.signal }));
    const seen: string[] = [];
    const run = (async () => {
      for await (const chunk of res.body) {
        seen.push(new TextDecoder().decode(chunk));
        ctl.abort();
      }
    })();
    await expect(run).rejects.toThrow('aborted');
    expect(seen).toEqual(['a']);
    expect(cancelled).toBe(1);
  });

  it('aborts a body whose signal was already aborted before reading', async () => {
    const t = trackedReader(['a']);
    const ctl = new AbortController();
    const client = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({}),
      body: t.body,
    }));
    const res = okOf(await client.get('http://h/x', { signal: ctl.signal }));
    ctl.abort();
    await expect(collect(res.body)).rejects.toThrow('aborted');
    expect(t.state.cancelled).toBe(1);
  });

  it('streams and discards @@asyncIterator bodies when Symbol.asyncIterator is undefined', async () => {
    const OriginalSymbol = globalThis.Symbol;
    const FakeSymbol = Object.assign(
      ((description?: string | number) => OriginalSymbol(description)) as typeof Symbol,
      {
        for: OriginalSymbol.for.bind(OriginalSymbol),
        keyFor: OriginalSymbol.keyFor.bind(OriginalSymbol),
        asyncIterator: undefined as unknown as typeof Symbol.asyncIterator,
      },
    );
    (globalThis as { Symbol: typeof Symbol }).Symbol = FakeSymbol;
    try {
      let returned = 0;
      const makeBabelBody = (chunks: Uint8Array[]) => {
        let idx = 0;
        const gen = {
          '@@asyncIterator'() {
            return gen;
          },
          next: async () =>
            idx < chunks.length
              ? { done: false as const, value: chunks[idx++] as Uint8Array }
              : { done: true as const, value: undefined },
          return: async () => {
            returned++;
            return { done: true as const, value: undefined };
          },
        };
        return gen as unknown as AsyncIterable<Uint8Array>;
      };

      const okClient = createFetchHttpClient(async () => ({
        status: 200,
        headers: headers({}),
        body: makeBabelBody([enc('he'), enc('rmes')]),
      }));
      const okRes = okOf(await okClient.get('http://h/x'));
      const fallbackMethod = (
        okRes.body as unknown as Record<string, () => AsyncIterator<Uint8Array>>
      )['@@asyncIterator'];
      expect(typeof fallbackMethod).toBe('function');
      const it = fallbackMethod?.call(okRes.body) as AsyncIterator<Uint8Array>;
      const pieces: string[] = [];
      for (;;) {
        const step = await it.next();
        if (step.done) break;
        pieces.push(new TextDecoder().decode(step.value));
      }
      expect(pieces.join('')).toBe('hermes');

      const errClient = createFetchHttpClient(async () => ({
        status: 503,
        headers: headers({}),
        body: makeBabelBody([enc('err')]),
      }));
      expect((await errClient.get('http://h/x')).ok).toBe(false);
      expect(returned).toBe(1);
    } finally {
      (globalThis as { Symbol: typeof Symbol }).Symbol = OriginalSymbol;
    }
  });

  it('sanitizes outbound headers, sets manual redirect mode, and returns finalUrl', async () => {
    let seen: Parameters<FetchLike>[1] | undefined;
    const client = createFetchHttpClient(async (_u, init) => {
      seen = init;
      return { status: 200, headers: headers({}), body: null };
    });
    const res = okOf(
      await client.get('https://origin.example/list.m3u', {
        headers: {
          'User-Agent': 'ELV/1.0\r\nInjected: yes',
          'Invalid Name': 'drop-me',
          'X-Empty': '\r\n\0',
        },
      }),
    );
    expect(seen?.headers).toEqual({ 'User-Agent': 'ELV/1.0Injected: yes' });
    expect(seen?.redirect).toBe('manual');
    expect(res.finalUrl).toBe('https://origin.example/list.m3u');
  });

  it('manually follows redirects with credential headers, preserving them same-origin and stripping them cross-origin', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const body1 = trackedReader(['r1']);
    const body2 = trackedReader(['r2']);
    const body3 = trackedReader(['r3']);
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, init });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: headers({ Location: '/next/path?x=1' }),
          body: body1.body,
        };
      }
      if (calls.length === 2) {
        return {
          status: 307,
          headers: headers({ Location: '../sibling' }),
          body: body2.body,
        };
      }
      if (calls.length === 3) {
        return {
          status: 301,
          headers: headers({ Location: 'https://cdn.other.example/stream.ts' }),
          body: body3.body,
        };
      }
      return {
        status: 200,
        headers: headers({ 'Content-Type': 'video/mp2t' }),
        body: readerBody([enc('ok')]).body,
      };
    });

    const res = okOf(
      await client.get('https://origin.example:443/start/live', {
        headers: {
          Authorization: 'Bearer secret\r\n',
          'Proxy-Authorization': 'Basic proxy',
          Cookie: 'sid=123',
          'User-Agent': 'ELV/1.0',
        },
      }),
    );

    expect(await collect(res.body)).toEqual(['ok']);
    expect(calls).toHaveLength(4);
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(calls[0]?.init.headers).toEqual({
      Authorization: 'Bearer secret',
      'Proxy-Authorization': 'Basic proxy',
      Cookie: 'sid=123',
      'User-Agent': 'ELV/1.0',
    });
    // Hop 1: same-origin root-relative redirect keeps credentials
    expect(calls[1]?.url).toBe('https://origin.example/next/path?x=1');
    expect(calls[1]?.init.headers).toEqual(calls[0]?.init.headers);
    // Hop 2: same-origin relative ../ redirect keeps credentials
    expect(calls[2]?.url).toBe('https://origin.example/sibling');
    expect(calls[2]?.init.headers).toEqual(calls[0]?.init.headers);
    // Hop 3: cross-origin redirect strips Authorization, Proxy-Authorization, and Cookie
    expect(calls[3]?.url).toBe('https://cdn.other.example/stream.ts');
    expect(calls[3]?.init.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
    // Intermediate redirect bodies were all discarded cleanly
    expect(body1.state).toEqual({ cancelled: 1, released: 1 });
    expect(body2.state).toEqual({ cancelled: 1, released: 1 });
    expect(body3.state).toEqual({ cancelled: 1, released: 1 });
  });

  it('never re-attaches credentials when a cross-origin redirect bounces back to the initial origin', async () => {
    const calls: Array<{ url: string; headers: Record<string, string> | undefined }> = [];
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, headers: init.headers });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: headers({ Location: '//untrusted.example/bounce' }),
          body: null,
        };
      }
      if (calls.length === 2) {
        return {
          status: 303,
          headers: headers({ Location: '?step=2' }),
          body: null,
        };
      }
      if (calls.length === 3) {
        return {
          status: 302,
          headers: headers({ Location: 'https://origin.example/final' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: null };
    });

    const res = await client.get('https://origin.example/start', {
      headers: { Authorization: 'Bearer secret', 'User-Agent': 'ELV/1.0' },
    });
    expect(res.ok).toBe(true);
    expect(calls[1]?.url).toBe('https://untrusted.example/bounce');
    expect(calls[1]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
    expect(calls[2]?.url).toBe('https://untrusted.example/bounce?step=2');
    expect(calls[2]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
    expect(calls[3]?.url).toBe('https://origin.example/final');
    expect(calls[3]?.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
  });

  it('fails with network/too-many-redirects when a credentialed redirect loop exceeds 10 hops', async () => {
    let calls = 0;
    const bodies: Array<ReturnType<typeof trackedReader>> = [];
    const client = createFetchHttpClient(async (u) => {
      calls += 1;
      const b = trackedReader([`hop-${calls}`]);
      bodies.push(b);
      return {
        status: 308,
        headers: headers({ Location: `${u}?n=${calls}` }),
        body: b.body,
      };
    });

    const res = await client.get('https://origin.example/loop', {
      headers: { Authorization: 'Bearer tok' },
    });
    expect(res).toEqual({
      ok: false,
      error: { category: 'network', code: 'too-many-redirects' },
    });
    expect(calls).toBe(11);
    for (const b of bodies) {
      expect(b.state).toEqual({ cancelled: 1, released: 1 });
    }
  });

  it('refuses redirects with missing or non-http(s) Location headers cleanly', async () => {
    const noLocClient = createFetchHttpClient(async () => ({
      status: 302,
      headers: headers({}),
      body: null,
    }));
    expect(
      await noLocClient.get('https://origin.example/a', {
        headers: { Cookie: 'a=1' },
      }),
    ).toEqual({ ok: false, error: { category: 'network', code: 'http-302' } });

    const badSchemeClient = createFetchHttpClient(async () => ({
      status: 302,
      headers: headers({ Location: 'javascript:alert(1)' }),
      body: null,
    }));
    expect(
      await badSchemeClient.get('https://origin.example/a', {
        headers: { Cookie: 'a=1' },
      }),
    ).toEqual({ ok: false, error: { category: 'network', code: 'http-302' } });
  });

  it('manually follows URL-credential redirects without credential headers, discards intermediate bodies, rejects non-HTTP(S) schemes, and reports finalUrl', async () => {
    const calls: Array<{ url: string; init: Parameters<FetchLike>[1] }> = [];
    const hopBody = trackedReader(['redirecting']);
    const client = createFetchHttpClient(async (u, init) => {
      calls.push({ url: u, init });
      if (calls.length === 1) {
        return {
          status: 302,
          headers: headers({ Location: 'https://cdn.other.example/lists/channel.m3u' }),
          body: hopBody.body,
        };
      }
      if (calls.length === 2) {
        return {
          status: 301,
          headers: headers({ Location: 'v2/playlist.m3u' }),
          body: null,
        };
      }
      return { status: 200, headers: headers({}), body: readerBody([enc('#EXTM3U')]).body };
    });

    const res = okOf(
      await client.get('https://user:pass@origin.example/get.php?token=secret&password=pw', {
        headers: { 'User-Agent': 'ELV/1.0' },
      }),
    );
    expect(res.finalUrl).toBe('https://cdn.other.example/lists/v2/playlist.m3u');
    expect(await collect(res.body)).toEqual(['#EXTM3U']);
    expect(calls.map((c) => c.init.redirect)).toEqual(['manual', 'manual', 'manual']);
    expect(calls[1]?.url).toBe('https://cdn.other.example/lists/channel.m3u');
    expect(calls[1]?.init.headers).toEqual({ 'User-Agent': 'ELV/1.0' });
    expect(hopBody.state).toEqual({ cancelled: 1, released: 1 });

    // Rejects non-HTTP(S) redirect target even with no credential headers
    const fileHop = trackedReader(['bad']);
    const fileClient = createFetchHttpClient(async () => ({
      status: 302,
      headers: headers({ Location: 'file:///etc/passwd' }),
      body: fileHop.body,
    }));
    expect(await fileClient.get('https://origin.example/get.php?token=secret')).toEqual({
      ok: false,
      error: { category: 'network', code: 'http-302' },
    });
    expect(fileHop.state).toEqual({ cancelled: 1, released: 1 });

    // Respects explicit redirect: 'manual' by not following hops
    const manualClient = createFetchHttpClient(async () => ({
      status: 302,
      headers: headers({ Location: 'https://origin.example/next' }),
      body: null,
    }));
    expect(await manualClient.get('https://origin.example/a', { redirect: 'manual' })).toEqual({
      ok: false,
      error: { category: 'network', code: 'http-302' },
    });
  });
});

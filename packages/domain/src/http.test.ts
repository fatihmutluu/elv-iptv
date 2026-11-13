import { describe, expect, it } from 'vitest';
import { createFetchHttpClient, type FetchLike, type HttpResponse } from './http';
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
});

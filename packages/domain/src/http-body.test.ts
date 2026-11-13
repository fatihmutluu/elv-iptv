import { describe, expect, it } from 'vitest';
import { createFetchHttpClient, type HttpResponse } from './http';
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

function okOf(r: Result<HttpResponse>): HttpResponse {
  if (!r.ok) throw new Error('expected ok');
  return r.value;
}

describe('createFetchHttpClient body failures', () => {
  it('ends a body that stalls after one chunk with network/timeout', async () => {
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
    const client = createFetchHttpClient(
      async () => ({ status: 200, headers: headers({}), body }),
      {
        idleTimeoutMs: 20,
      },
    );
    const res = okOf(await client.get('http://h/x'));
    const seen: string[] = [];
    const started = Date.now();
    const failure = await (async () => {
      try {
        for await (const chunk of res.body) seen.push(new TextDecoder().decode(chunk));
      } catch (e) {
        return e as { category?: string; code?: string };
      }
      return undefined;
    })();
    expect(seen).toEqual(['a']);
    expect(failure).toMatchObject({ category: 'network', code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(cancelled).toBe(1);
  });

  it('lets a per-request idle timeout override the default', async () => {
    const body = {
      getReader: () => ({
        read: (): Promise<{ done: boolean; value?: Uint8Array }> => new Promise(() => {}),
        releaseLock: () => {},
      }),
    };
    const client = createFetchHttpClient(
      async () => ({ status: 200, headers: headers({}), body }),
      {
        idleTimeoutMs: 60_000,
      },
    );
    const res = okOf(await client.get('http://h/x', { idleTimeoutMs: 10 }));
    await expect(collect(res.body)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('marks a mid-body abort as network/aborted', async () => {
    let cancelled = 0;
    let n = 0;
    const t = {
      body: {
        getReader: () => ({
          read: async (): Promise<{ done: boolean; value?: Uint8Array }> =>
            n++ === 0 ? { done: false, value: enc('a') } : { done: true },
          cancel: async () => {
            cancelled++;
          },
          releaseLock: () => {},
        }),
      },
    };
    const ctl = new AbortController();
    const client = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({}),
      body: t.body,
    }));
    const res = okOf(await client.get('http://h/x', { signal: ctl.signal }));
    ctl.abort();
    await expect(collect(res.body)).rejects.toMatchObject({ category: 'network', code: 'aborted' });
    expect(cancelled).toBe(1);
  });

  it('treats an undefined body like null', async () => {
    const client = createFetchHttpClient(async () => ({
      status: 200,
      headers: headers({}),
      body: undefined,
    }));
    expect(await collect(okOf(await client.get('http://h/x')).body)).toEqual([]);
    const failing = createFetchHttpClient(async () => ({
      status: 500,
      headers: headers({}),
      body: undefined,
    }));
    expect((await failing.get('http://h/x')).ok).toBe(false);
  });
});

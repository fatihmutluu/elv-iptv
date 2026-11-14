import { describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('expo/fetch', () => ({ fetch: mocked.fetch }));

import { createDeviceHttpClient } from './http';

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const dec = (b: Uint8Array) => String.fromCharCode(...b);

function streamOf(...chunks: string[]) {
  let i = 0;
  return {
    getReader: () => ({
      read: async () =>
        i < chunks.length ? { done: false, value: enc(chunks[i++] ?? '') } : { done: true },
      cancel: async () => undefined,
      releaseLock: () => undefined,
    }),
  };
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<string> {
  let out = '';
  for await (const chunk of body) out += dec(chunk);
  return out;
}

describe('createDeviceHttpClient', () => {
  it('passes headers and streams the body in chunks', async () => {
    mocked.fetch.mockResolvedValue({
      status: 200,
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      body: streamOf('ab', 'cd'),
    });
    const res = await createDeviceHttpClient().get('https://x.test/a', {
      headers: { 'User-Agent': 'u' },
    });
    expect(mocked.fetch).toHaveBeenCalledWith(
      'https://x.test/a',
      expect.objectContaining({ headers: { 'User-Agent': 'u' } }),
    );
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.headers['content-type']).toBe('text/plain');
    const chunks: string[] = [];
    for await (const c of res.value.body) chunks.push(dec(c));
    expect(chunks).toEqual(['ab', 'cd']);
  });

  it('reads the whole body where the response does not stream', async () => {
    mocked.fetch.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: null,
      arrayBuffer: async () => enc('whole').buffer,
    });
    const res = await createDeviceHttpClient().get('https://x.test/b');
    if (!res.ok) throw new Error('expected ok');
    expect(await drain(res.value.body)).toBe('whole');
  });

  it('reports a non-2xx status as an error', async () => {
    mocked.fetch.mockResolvedValue({ status: 401, headers: new Headers(), body: null });
    const res = await createDeviceHttpClient().get('https://x.test/c');
    expect(res).toEqual({ ok: false, error: { category: 'auth', code: 'http-401' } });
  });

  it('keeps status and headers of a response that exposes them as prototype getters', async () => {
    class ProtoResponse {
      get status() {
        return 200;
      }
      get headers() {
        return new Headers({ 'X-Test': '1' });
      }
      get body() {
        return null;
      }
      async arrayBuffer() {
        return enc('proto').buffer;
      }
    }
    mocked.fetch.mockResolvedValue(new ProtoResponse());
    const res = await createDeviceHttpClient().get('https://x.test/d');
    if (!res.ok) throw new Error('expected ok');
    expect(res.value.status).toBe(200);
    expect(res.value.headers['x-test']).toBe('1');
    expect(await drain(res.value.body)).toBe('proto');
  });

  it('keeps the status of an empty error response without a body', async () => {
    class ProtoResponse {
      get status() {
        return 403;
      }
      get headers() {
        return new Headers();
      }
      get body() {
        return null;
      }
    }
    mocked.fetch.mockResolvedValue(new ProtoResponse());
    const res = await createDeviceHttpClient().get('https://x.test/e');
    expect(res).toEqual({ ok: false, error: { category: 'auth', code: 'http-403' } });
  });
});

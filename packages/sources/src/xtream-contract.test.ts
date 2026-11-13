import { err, type HttpClient, type HttpResponse, ok, type Result } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createXtreamClient } from './xtream';
import { client, expectErr, PASS, USER, value } from './xtream-test-helpers';

const enc = (s: string) => new TextEncoder().encode(s);

function clientWith(
  body: () => AsyncIterable<Uint8Array>,
  extra: { maxBodyBytes?: number; server?: string } = {},
) {
  const urls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const http: HttpClient = {
    async get(url, options): Promise<Result<HttpResponse>> {
      urls.push(url);
      signals.push(options?.signal);
      return ok({ status: 200, headers: {}, body: body() });
    },
  };
  const c = createXtreamClient({
    http,
    server: extra.server ?? 'http://h.example',
    username: USER,
    password: PASS,
    ...(extra.maxBodyBytes === undefined ? {} : { maxBodyBytes: extra.maxBodyBytes }),
  });
  return { c, urls, signals };
}

describe('category_ids fallback', () => {
  it('falls back to category_id when category_ids is empty or blank', async () => {
    const { c } = client(() => ({
      json: [
        { stream_id: 1, name: 'A', category_id: '7', category_ids: [] },
        { stream_id: 2, name: 'B', category_id: '8', category_ids: [''] },
        { stream_id: 3, name: 'C', category_id: '9', category_ids: [4] },
      ],
    }));
    const rows = value(await c.liveStreams());
    expect(rows.map((r) => r.categoryIds)).toEqual([['7'], ['8'], ['4']]);
  });
});

describe('cancellation', () => {
  it('forwards the signal and ends with network/aborted when aborted mid-body', async () => {
    const ctl = new AbortController();
    async function* body() {
      yield enc('[{"stream_id":1,');
      await new Promise((resolve) => setTimeout(resolve, 5));
      ctl.abort();
      throw Object.assign(new Error('aborted'), { category: 'network', code: 'aborted' });
    }
    const { c, signals } = clientWith(body);
    expectErr(await c.liveStreams(undefined, { signal: ctl.signal }), 'network', 'aborted');
    expect(signals[0]).toBe(ctl.signal);
  });

  it('passes the signal through every method', async () => {
    const ctl = new AbortController();
    const { c, signals } = clientWith(async function* () {
      yield enc('{}');
    });
    const o = { signal: ctl.signal };
    await c.account(o);
    await c.categories('live', o);
    await c.vodStreams(undefined, o);
    await c.series(undefined, o);
    await c.seriesInfo(1, o);
    await c.vodInfo(1, o);
    await c.shortEpg(1, 2, o);
    expect(signals).toHaveLength(7);
    expect(signals.every((s) => s === ctl.signal)).toBe(true);
  });

  it('reports a pre-aborted call and a throwing client as aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const http: HttpClient = {
      async get() {
        throw new Error('boom');
      },
    };
    const c = createXtreamClient({ http, server: 'http://h', username: USER, password: PASS });
    expectErr(await c.account({ signal: ctl.signal }), 'network', 'aborted');
    const failing: HttpClient = {
      async get() {
        return err({ category: 'network', code: 'aborted' });
      },
    };
    const d = createXtreamClient({
      http: failing,
      server: 'http://h',
      username: USER,
      password: PASS,
    });
    expectErr(await d.account(), 'network', 'aborted');
  });

  it('surfaces an idle timeout from the body', async () => {
    const { c } = clientWith(async function* () {
      yield enc('[');
      throw Object.assign(new Error('timeout'), { category: 'network', code: 'timeout' });
    });
    expectErr(await c.liveStreams(), 'network', 'timeout');
  });
});

describe('body limits', () => {
  it('fails with source-format/too-large over maxBodyBytes and stops reading', async () => {
    let pulled = 0;
    const { c } = clientWith(
      async function* () {
        for (let i = 0; i < 100; i++) {
          pulled++;
          yield enc('x'.repeat(100));
        }
      },
      { maxBodyBytes: 250 },
    );
    expectErr(await c.liveStreams(), 'source-format', 'too-large');
    expect(pulled).toBeLessThan(10);
  });

  it('reads a body exactly at the cap across many chunks', async () => {
    const text = JSON.stringify([{ stream_id: 1, name: 'A' }]);
    const { c } = clientWith(
      async function* () {
        for (const ch of text) yield enc(ch);
      },
      { maxBodyBytes: text.length },
    );
    expect(value(await c.liveStreams())).toHaveLength(1);
  });
});

describe('server without a scheme', () => {
  it('prepends http:// to every request and URL builder', async () => {
    const { c, urls } = clientWith(
      async function* () {
        yield enc('{}');
      },
      { server: 'h.example:8080/' },
    );
    await c.account();
    expect(urls[0]?.startsWith('http://h.example:8080/player_api.php?')).toBe(true);
    expect(c.playlistUrl().startsWith('http://h.example:8080/get.php?')).toBe(true);
    expect(c.guideUrl().startsWith('http://h.example:8080/xmltv.php?')).toBe(true);
    expect(c.streamUrl('live', 5).startsWith('http://h.example:8080/live/')).toBe(true);
    expect(c.streamUrl('live', 5).endsWith('/5.ts')).toBe(true);
  });
});

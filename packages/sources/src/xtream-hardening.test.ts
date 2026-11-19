import { type HttpClient, ok } from '@elv/domain';
import { describe, expect, it } from 'vitest';
import { createXtreamClient, toNumber } from './index';
import { client, expectErr, PASS, USER, value } from './xtream-test-helpers';

const enc = (s: string) => new TextEncoder().encode(s);

describe('Xtream hardening (#168, #180, #216, #271, #315)', () => {
  it('strips UTF-8 BOM and recovers malformed PHP escapes, lone surrogates, and truncated arrays (#216)', async () => {
    // UTF-8 BOM + invalid PHP escape \' + lone high surrogate \uD83D + truncated trailing element
    const broken =
      '\uFEFF[{"stream_id":1,"name":"King\\\'s \\uD83D News"},{"stream_id":2,"name":"Truncated';
    const { c } = client(() => ({ text: broken }));
    const list = value(await c.liveStreams());
    expect(list).toEqual([{ id: 1, name: "King's \ufffd News", categoryIds: [], catchupDays: 0 }]);
  });

  it('sniffs HTML/JS captive-portal responses on the first chunk and cancels remaining stream (#164)', async () => {
    let chunksRead = 0;
    let returned = false;
    const http: HttpClient = {
      async get() {
        const body: AsyncIterable<Uint8Array> = {
          [Symbol.asyncIterator]() {
            return {
              async next() {
                chunksRead++;
                if (chunksRead === 1) return { done: false, value: enc('  <!DOCTYPE html><html>') };
                return { done: false, value: enc('x'.repeat(65536)) };
              },
              async return() {
                returned = true;
                return { done: true, value: undefined };
              },
            };
          },
        };
        return ok({ status: 200, headers: {}, body });
      },
    };
    const c = createXtreamClient({
      http,
      server: 'http://h.example',
      username: USER,
      password: PASS,
    });
    expectErr(await c.liveStreams(), 'source-format', 'invalid-json');
    expect(chunksRead).toBe(1);
    expect(returned).toBe(true);
  });

  it('accepts PHP numeric-keyed list objects, classifies auth:0 in rows(), and parses loose ratings/durations while keeping strict IDs (#168)', async () => {
    expect(toNumber('7.8/10')).toBe(7.8);
    expect(toNumber('8,5 / 10')).toBe(8.5);
    expect(toNumber('45 min')).toBe(45);
    expect(toNumber('5400s')).toBe(5400);

    const { c } = client(() => ({
      json: {
        '0': { stream_id: '10', name: 'Movie A', rating: '7.8/10', category_id: '1' },
        '1': { stream_id: '12.5', name: 'Bad Float ID', category_id: '1' },
        '2': { stream_id: '45 min', name: 'Bad Unit ID', category_id: '1' },
        '3': { stream_id: 20, name: 'Movie B', rating: '8,2/10', category_id: '1' },
      },
    }));
    const movies = value(await c.vodStreams());
    expect(movies.map((m) => ({ id: m.id, rating: m.rating }))).toEqual([
      { id: 10, rating: 7.8 },
      { id: 20, rating: 8.2 },
    ]);

    expectErr(
      await client(() => ({ json: { user_info: { auth: 0 } } })).c.liveStreams(),
      'auth',
      'invalid-credentials',
    );
  });

  it('falls back missing episode_num to 1-based index in toSeriesInfo (#271)', async () => {
    const { c } = client(() => ({
      json: {
        episodes: {
          '1': [
            { id: 101, title: 'Ep A' },
            { id: 102, episode_num: '', title: 'Ep B' },
            { id: 103, episode_num: 5, title: 'Ep E' },
          ],
        },
      },
    }));
    const info = value(await c.seriesInfo(1));
    expect(info.episodes.map((e) => ({ id: e.id, episode: e.episode }))).toEqual([
      { id: 101, episode: 1 },
      { id: 102, episode: 2 },
      { id: 103, episode: 5 },
    ]);
  });

  it('discards non-2xx bodies via iterator.return() without awaiting next(), and preserves %2f/%3a (#180)', async () => {
    let nextCalled = false;
    let returnCalled = false;
    const http: HttpClient = {
      async get() {
        return ok({
          status: 503,
          headers: {},
          body: {
            [Symbol.asyncIterator]: () => ({
              async next() {
                nextCalled = true;
                return { done: true, value: undefined };
              },
              async return() {
                returnCalled = true;
                return { done: true, value: undefined };
              },
            }),
          },
        });
      },
    };
    const c = createXtreamClient({
      http,
      server: 'http://h.example',
      username: 'u/a:b',
      password: 'pass',
    });
    expectErr(await c.account(), 'network', 'http-503');
    expect(nextCalled).toBe(false);
    expect(returnCalled).toBe(true);
    expect(c.streamUrl('live', 9)).toBe('http://h.example/live/u%2Fa%3Ab/pass/9.ts');
  });

  it('paces per-host requests with a monotonic-clock token bucket and aborts cleanly while waiting (#315)', async () => {
    let monoNow = 1000;
    const sleeps: number[] = [];
    const http: HttpClient = {
      async get() {
        return ok({
          status: 200,
          headers: {},
          body: (async function* () {
            yield enc('[]');
          })(),
        });
      },
    };
    const rateLimit = {
      burst: 2,
      ratePerSec: 4, // 250 ms per token
      now: () => monoNow,
      sleep: async (ms: number, signal?: AbortSignal) => {
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        sleeps.push(ms);
        monoNow += ms;
      },
    };
    const c1 = createXtreamClient({
      http,
      server: 'http://panel.example:8080',
      username: USER,
      password: PASS,
      rateLimit,
    });
    const c2 = createXtreamClient({
      http,
      server: 'http://panel.example:8080',
      username: USER,
      password: PASS,
      rateLimit,
    });

    await c1.liveStreams(); // consumes token 1 (remaining: 1)
    await c2.vodStreams(); // consumes token 2 on same host (remaining: 0)
    expect(sleeps).toEqual([]);

    await c1.series(); // waits 250 ms for 1 refilled token!
    expect(sleeps).toEqual([250]);

    // Pre-aborted call during empty bucket fails immediately with network/aborted
    const ctl = new AbortController();
    ctl.abort();
    expectErr(await c2.liveStreams(undefined, { signal: ctl.signal }), 'network', 'aborted');
  });
});

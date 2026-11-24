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

describe('Xtream account-scoped 429 cooldown and mirror failover (#173)', () => {
  it('enforces account-scoped 429 cooldown honoring Retry-After without failing over to backups', async () => {
    let monoNow = 10_000;
    const requestedUrls: string[] = [];
    let should429 = true;
    const http: HttpClient = {
      async get(url) {
        requestedUrls.push(url);
        if (should429) {
          return ok({
            status: 429,
            headers: { 'Retry-After': '30' },
            body: (async function* () {
              yield enc('slow down');
            })(),
          });
        }
        return ok({
          status: 200,
          headers: {},
          body: (async function* () {
            yield enc('[]');
          })(),
        });
      },
    };
    const rateLimit = { burst: 20, ratePerSec: 100, now: () => monoNow };
    const c1 = createXtreamClient({
      http,
      server: 'http://primary.example',
      backupServers: ['http://backup1.example', 'http://backup2.example'],
      username: USER,
      password: PASS,
      rateLimit,
    });
    const c1Sibling = createXtreamClient({
      http,
      server: 'http://backup1.example',
      username: USER,
      password: PASS,
      rateLimit,
    });
    const otherAccount = createXtreamClient({
      http,
      server: 'http://primary.example',
      username: 'other-user',
      password: 'other-password',
      rateLimit,
    });

    const first = await c1.liveStreams();
    const err429 = expectErr(first, 'network', 'http-429');
    expect(err429.detail).toBeUndefined();
    // Must NEVER touch backup servers on 429
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain('http://primary.example/player_api.php');

    // Same account (same client and sibling client) fails fast during cooldown without HTTP calls
    monoNow += 15_000;
    expectErr(await c1.vodStreams(), 'network', 'http-429');
    expectErr(await c1Sibling.series(), 'network', 'http-429');
    expect(requestedUrls).toHaveLength(1);

    // Different account sharing the same HttpClient is NOT blocked
    should429 = false;
    expect(value(await otherAccount.liveStreams())).toEqual([]);
    expect(requestedUrls).toHaveLength(2);

    // Once 30s Retry-After expires, original account resumes cleanly
    monoNow += 15_001;
    expect(value(await c1.liveStreams())).toEqual([]);
    expect(requestedUrls).toHaveLength(3);
  });

  it('honors HTTP-date Retry-After and default cooldown429Ms when http.get returns err(http-429)', async () => {
    let monoNow = 5_000;
    let hits = 0;
    const futureDate = new Date(Date.now() + 20_000).toUTCString();
    const http: HttpClient = {
      async get() {
        hits++;
        if (hits === 1) {
          return ok({
            status: 429,
            headers: { 'retry-after': futureDate },
            body: (async function* () {})(),
          });
        }
        return { ok: false, error: { category: 'network', code: 'http-429' } };
      },
    };
    const c = createXtreamClient({
      http,
      server: 'http://p.example',
      backupServers: ['http://b.example'],
      cooldown429Ms: 45_000,
      username: USER,
      password: PASS,
      rateLimit: { now: () => monoNow },
    });

    expectErr(await c.liveStreams(), 'network', 'http-429');
    expect(hits).toBe(1);
    monoNow += 10_000;
    expectErr(await c.liveStreams(), 'network', 'http-429');
    expect(hits).toBe(1);

    // Advance past HTTP-date (~20s) -> hits again and gets err(http-429) without headers -> uses cooldown429Ms (45s)
    monoNow += 15_000;
    expectErr(await c.liveStreams(), 'network', 'http-429');
    expect(hits).toBe(2);
    monoNow += 40_000;
    expectErr(await c.liveStreams(), 'network', 'http-429');
    expect(hits).toBe(2);
    monoNow += 6_000;
    expectErr(await c.liveStreams(), 'network', 'http-429');
    expect(hits).toBe(3);
  });

  it('fails over in order across backupServers on 5xx/network errors, sticks to active mirror, and promotes primary after cooldown', async () => {
    let monoNow = 1_000;
    const hosts: string[] = [];
    let primaryHealthy = false;
    let backup1Healthy = false;
    const http: HttpClient = {
      async get(url) {
        const host = new URL(url).host;
        hosts.push(host);
        if (host === 'primary.example' && !primaryHealthy) {
          return ok({ status: 503, headers: {}, body: (async function* () {})() });
        }
        if (host === 'backup1.example' && !backup1Healthy) {
          return { ok: false, error: { category: 'network', code: 'timeout' } };
        }
        return ok({
          status: 200,
          headers: {},
          body: (async function* () {
            yield enc('[]');
          })(),
        });
      },
    };

    const c = createXtreamClient({
      http,
      server: 'http://primary.example/',
      backupServers: [
        'http://primary.example',
        '  ',
        'backup1.example/',
        'http://backup2.example/player_api.php',
        'http://backup2.example',
      ],
      primaryCooldownMs: 300_000,
      username: USER,
      password: PASS,
      rateLimit: { now: () => monoNow },
    });

    // Primary 503 -> backup1 timeout -> backup2 200
    expect(value(await c.liveStreams())).toEqual([]);
    expect(hosts).toEqual(['primary.example', 'backup1.example', 'backup2.example']);
    expect(c.playlistUrl()).toContain('http://backup2.example/get.php?');
    expect(c.guideUrl()).toContain('http://backup2.example/xmltv.php?');
    // Stream failover is independent of API failover (#317)
    expect(c.streamUrl('live', 42)).toContain('http://primary.example/live/');

    // Before primaryCooldownMs elapses, subsequent calls stick to backup2 directly
    monoNow += 120_000;
    expect(value(await c.vodStreams())).toEqual([]);
    expect(hosts).toEqual([
      'primary.example',
      'backup1.example',
      'backup2.example',
      'backup2.example',
    ]);

    // After primaryCooldownMs elapses, probe primary first; still unhealthy -> falls back to backup2 & resets cooldown
    monoNow += 200_000;
    expect(value(await c.series())).toEqual([]);
    expect(hosts.slice(-2)).toEqual(['primary.example', 'backup2.example']);

    // Primary recovers, wait another primaryCooldownMs -> probes primary and promotes back
    primaryHealthy = true;
    backup1Healthy = true;
    monoNow += 300_000;
    expect(value(await c.liveStreams())).toEqual([]);
    expect(hosts.at(-1)).toBe('primary.example');
    expect(c.playlistUrl()).toContain('http://primary.example/get.php?');
    expect(c.guideUrl()).toContain('http://primary.example/xmltv.php?');
    expect(c.streamUrl('movie', 9)).toContain('http://primary.example/movie/');
  });

  it('never fails over to backups on 401/403/404 or caller abort, and stops immediately if a backup returns 429', async () => {
    let monoNow = 1_000;
    const hosts: string[] = [];
    let nextStatus = 401;
    const http: HttpClient = {
      async get(url) {
        const host = new URL(url).host;
        hosts.push(host);
        if (host === 'backup1.example') {
          return ok({
            status: 429,
            headers: { 'Retry-After': '0' },
            body: (async function* () {})(),
          });
        }
        return ok({ status: nextStatus, headers: {}, body: (async function* () {})() });
      },
    };
    const c = createXtreamClient({
      http,
      server: 'http://primary.example',
      backupServers: ['http://backup1.example', 'http://backup2.example'],
      username: USER,
      password: PASS,
      rateLimit: { now: () => monoNow },
    });

    expectErr(await c.account(), 'auth', 'http-401');
    nextStatus = 403;
    expectErr(await c.account(), 'auth', 'http-403');
    nextStatus = 404;
    expectErr(await c.account(), 'network', 'http-404');
    expect(hosts).toEqual(['primary.example', 'primary.example', 'primary.example']);

    const ctl = new AbortController();
    ctl.abort();
    expectErr(await c.account({ signal: ctl.signal }), 'network', 'aborted');
    expect(hosts).toHaveLength(3);

    // Primary 502 -> fails over to backup1 -> backup1 returns 429 (clamped to min 1000ms) -> must NOT try backup2!
    nextStatus = 502;
    expectErr(await c.liveStreams(), 'network', 'http-429');
    expect(hosts).toEqual([
      'primary.example',
      'primary.example',
      'primary.example',
      'primary.example',
      'backup1.example',
    ]);
    // Still cooling down for 1000ms minimum
    monoNow += 500;
    expectErr(await c.liveStreams(), 'network', 'http-429');
    expect(hosts).toHaveLength(5);
  });

  it('clamps huge Retry-After values and falls back to cooldown429Ms on unparseable headers, and recovers primary as last resort when backups fail', async () => {
    let monoNow = 10_000;
    const hosts: string[] = [];
    let backupHealthy = true;
    let primaryStatus = 503;
    let retryAfter = '999999';
    const http: HttpClient = {
      async get(url) {
        const host = new URL(url).host;
        hosts.push(host);
        if (host === 'primary.example') {
          if (primaryStatus === 429) {
            return ok({
              status: 429,
              headers: { 'Retry-After': retryAfter },
              body: (async function* () {})(),
            });
          }
          if (primaryStatus >= 500) {
            return ok({ status: primaryStatus, headers: {}, body: (async function* () {})() });
          }
        } else if (!backupHealthy) {
          return ok({ status: 502, headers: {}, body: (async function* () {})() });
        }
        return ok({
          status: 200,
          headers: {},
          body: (async function* () {
            yield enc('[]');
          })(),
        });
      },
    };
    const c = createXtreamClient({
      http,
      server: 'http://primary.example',
      backupServers: ['http://backup1.example'],
      primaryCooldownMs: 300_000,
      cooldown429Ms: 5_000,
      username: USER,
      password: PASS,
      rateLimit: { now: () => monoNow },
    });

    // Primary 503 -> sticks to backup1
    expect(value(await c.liveStreams())).toEqual([]);
    expect(c.playlistUrl()).toContain('http://backup1.example');

    // During cooldown, backup1 dies (502) while primary is healthy again -> tries backup1 then primary as last resort and promotes primary!
    backupHealthy = false;
    primaryStatus = 200;
    monoNow += 10_000;
    expect(value(await c.liveStreams())).toEqual([]);
    expect(hosts.slice(-2)).toEqual(['backup1.example', 'primary.example']);
    expect(c.playlistUrl()).toContain('http://primary.example');

    // Huge Retry-After (999999s) is clamped to 600_000ms
    primaryStatus = 429;
    expectErr(await c.liveStreams(), 'network', 'http-429');
    monoNow += 599_000;
    expectErr(await c.liveStreams(), 'network', 'http-429');
    const hitsBefore = hosts.length;
    monoNow += 2_000;
    retryAfter = 'not-a-date';
    expectErr(await c.liveStreams(), 'network', 'http-429');
    expect(hosts.length).toBe(hitsBefore + 1);
    // Unparseable Retry-After fell back to cooldown429Ms (5_000ms)
    monoNow += 4_000;
    expectErr(await c.liveStreams(), 'network', 'http-429');
    expect(hosts.length).toBe(hitsBefore + 1);
  });

  it('re-checks account 429 cooldown after token-bucket wait so concurrent racing requests never leak to primary or backup', async () => {
    let monoNow = 1_000;
    const requestedHosts: string[] = [];
    let releaseSleep!: () => void;
    const sleepStarted = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    let resumeWaitingReq!: () => void;
    const waitingGate = new Promise<void>((resolve) => {
      resumeWaitingReq = resolve;
    });
    let firstGetDone!: () => void;
    const firstGetFinished = new Promise<void>((resolve) => {
      firstGetDone = resolve;
    });

    const http: HttpClient = {
      async get(url) {
        requestedHosts.push(new URL(url).host);
        firstGetDone();
        return ok({
          status: 429,
          headers: { 'Retry-After': '30' },
          body: (async function* () {})(),
        });
      },
    };
    const c = createXtreamClient({
      http,
      server: 'http://primary.example',
      backupServers: ['http://backup1.example'],
      username: USER,
      password: PASS,
      rateLimit: {
        burst: 1,
        ratePerSec: 1,
        now: () => monoNow,
        sleep: async (ms: number) => {
          releaseSleep();
          await waitingGate;
          monoNow += ms;
        },
      },
    });

    // Request A consumes the 1 token and gets 429; Request B queues in acquireXtreamToken before 429 lands
    const reqA = c.liveStreams();
    const reqB = c.vodStreams();
    await Promise.all([firstGetFinished, sleepStarted]);
    expectErr(await reqA, 'network', 'http-429');

    // Now wake Request B after token-bucket sleep: it must see the active 429 cooldown and NOT call http.get
    resumeWaitingReq();
    expectErr(await reqB, 'network', 'http-429');
    expect(requestedHosts).toEqual(['primary.example']);
  });
});

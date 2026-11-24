import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalizeHealthKey,
  createIdleProbeController,
  createStreamHealthCache,
  DEFAULT_STREAM_HEALTH_MAX_ENTRIES,
  DEFAULT_STREAM_HEALTH_TTL_MS,
} from './stream-health-cache';

const syntheticXtream = (origin: string, user: string, pass: string, id: number, qs: string) =>
  `${origin}/live/${user}/${pass}/${id}.ts?${qs}`;

describe('canonicalizeHealthKey (#167)', () => {
  it('canonicalizes raw URLs credential-free and keeps non-URL item keys trimmed', () => {
    expect(
      canonicalizeHealthKey(
        syntheticXtream('http://u:p@CDN.Example.Test:80', 'demo', 'demo', 42, 'token=abc'),
      ),
    ).toBe('http://cdn.example.test/live/*/*/42.ts');
    expect(canonicalizeHealthKey('  x:src1:live:42  ')).toBe('x:src1:live:42');
    expect(canonicalizeHealthKey('   ')).toBeUndefined();
  });
});

describe('createStreamHealthCache (#167)', () => {
  let nowMs = 10_000;
  const clock = { now: () => nowMs };

  beforeEach(() => {
    nowMs = 10_000;
  });

  it('uses 4,096 max entries and 6-hour TTL by default', () => {
    expect(DEFAULT_STREAM_HEALTH_MAX_ENTRIES).toBe(4_096);
    expect(DEFAULT_STREAM_HEALTH_TTL_MS).toBe(6 * 60 * 60 * 1_000);
  });

  it('strips credentials from URL keys so rotated tokens hit the same cache entry', () => {
    const cache = createStreamHealthCache({ clock });
    const urlA = syntheticXtream(
      'http://cdn.example.test:80',
      'acct1',
      'cred1',
      99,
      'token=a&sig=1',
    );
    const urlB = syntheticXtream('http://CDN.EXAMPLE.TEST', 'acct2', 'cred2', 99, 'token=b');

    cache.recordSuccess(urlA, 420);
    const entry = cache.get(urlB);
    expect(entry).toEqual({
      status: 'healthy',
      consecutiveFailures: 0,
      stallCount: 0,
      lastOutcomeAtMs: 10_000,
      lastSuccessAtMs: 10_000,
      lastTtffMs: 420,
    });
    expect(cache.size()).toBe(1);
    const keys = [...cache.snapshot().keys()];
    expect(keys).toEqual(['http://cdn.example.test/live/*/*/99.ts']);
    expect(keys[0]).not.toContain('acct1');
    expect(keys[0]).not.toContain('cred1');
    expect(keys[0]).not.toContain('token');
  });

  it('transitions status across success, stalls, recoverable failures, and terminal failures', () => {
    const cache = createStreamHealthCache({ clock });

    // Single stall stays healthy; second stall becomes flaky
    expect(cache.recordStall('src:live:1')?.status).toBe('healthy');
    expect(cache.get('src:live:1')?.stallCount).toBe(1);

    nowMs += 1_000;
    expect(cache.recordStall('src:live:1')?.status).toBe('flaky');
    expect(cache.get('src:live:1')?.stallCount).toBe(2);

    // Success resets consecutiveFailures and stallCount back to healthy
    nowMs += 1_000;
    const healed = cache.recordSuccess('src:live:1', 300);
    expect(healed).toMatchObject({
      status: 'healthy',
      consecutiveFailures: 0,
      stallCount: 0,
      lastSuccessAtMs: 12_000,
      lastTtffMs: 300,
    });

    // First non-terminal failure -> flaky; second consecutive failure -> dead
    nowMs += 1_000;
    expect(cache.recordFailure('src:live:1', false)).toMatchObject({
      status: 'flaky',
      consecutiveFailures: 1,
      lastFailureAtMs: 13_000,
    });

    nowMs += 1_000;
    expect(cache.recordFailure('src:live:1', false)).toMatchObject({
      status: 'dead',
      consecutiveFailures: 2,
      lastFailureAtMs: 14_000,
    });

    // Stall while dead preserves worst status ('dead')
    nowMs += 1_000;
    expect(cache.recordStall('src:live:1')?.status).toBe('dead');

    // Immediate terminal failure marks 'dead' on first failure
    nowMs += 1_000;
    expect(cache.recordFailure('src:live:2', true)).toMatchObject({
      status: 'dead',
      consecutiveFailures: 1,
    });
  });

  it('enforces O(1) LRU capacity eviction at maxEntries (including 4,096 default)', () => {
    const small = createStreamHealthCache({ maxEntries: 3, clock });
    small.recordSuccess('k1');
    small.recordSuccess('k2');
    small.recordSuccess('k3');
    // Touch k1 so k2 becomes the LRU entry
    expect(small.get('k1')?.status).toBe('healthy');
    small.recordSuccess('k4');

    expect(small.size()).toBe(3);
    expect(small.get('k2')).toBeUndefined();
    expect(small.get('k1')?.status).toBe('healthy');
    expect(small.get('k3')?.status).toBe('healthy');
    expect(small.get('k4')?.status).toBe('healthy');

    // Verify default 4,096 cap
    const full = createStreamHealthCache({ clock });
    for (let i = 0; i < 4_120; i += 1) {
      full.recordSuccess(`ch:${i}`);
    }
    expect(full.size()).toBe(4_096);
    expect(full.get('ch:0')).toBeUndefined();
    expect(full.get('ch:23')).toBeUndefined();
    expect(full.get('ch:24')?.status).toBe('healthy');
    expect(full.get('ch:4119')?.status).toBe('healthy');
  });

  it('expires entries lazily on get/snapshot and sweeps them on prune after 6-hour TTL', () => {
    const cache = createStreamHealthCache({ clock });
    cache.recordFailure('ch:old', true);

    nowMs += 3 * 60 * 60 * 1_000;
    cache.recordSuccess('ch:mid', 500);

    // Just before 6 hours: both still live
    nowMs = 10_000 + DEFAULT_STREAM_HEALTH_TTL_MS - 1;
    expect(cache.get('ch:old')?.status).toBe('dead');
    expect(cache.get('ch:mid')?.status).toBe('healthy');

    // At exactly 6 hours from ch:old: ch:old expires, ch:mid stays live
    nowMs = 10_000 + DEFAULT_STREAM_HEALTH_TTL_MS;
    expect(cache.get('ch:old')).toBeUndefined();
    expect(cache.get('ch:mid')?.status).toBe('healthy');

    // Add another entry then expire everything and verify snapshot & prune
    cache.recordFailure('ch:exp', false);
    nowMs += DEFAULT_STREAM_HEALTH_TTL_MS;
    expect(cache.snapshot().size).toBe(0);
    expect(cache.size()).toBe(0);

    cache.recordSuccess('ch:prune1');
    cache.recordSuccess('ch:prune2');
    nowMs += DEFAULT_STREAM_HEALTH_TTL_MS;
    expect(cache.prune()).toBe(2);
    expect(cache.size()).toBe(0);
  });

  it('notifies subscribers on mutations, prune, and clear, and ignores throwing listeners', () => {
    const cache = createStreamHealthCache({ clock });
    let notifications = 0;
    const unsubBad = cache.subscribe(() => {
      throw new Error('listener failure');
    });
    const unsubGood = cache.subscribe(() => {
      notifications += 1;
    });

    cache.recordSuccess('ch:1');
    cache.recordStall('ch:1');
    cache.recordFailure('ch:1');
    expect(notifications).toBe(3);

    // Blank key is ignored without notifying
    expect(cache.recordSuccess('   ')).toBeUndefined();
    expect(cache.recordStall('')).toBeUndefined();
    expect(cache.recordFailure(' ')).toBeUndefined();
    expect(notifications).toBe(3);

    cache.clear();
    expect(notifications).toBe(4);
    expect(cache.size()).toBe(0);
    // Clearing an already-empty cache does not notify again
    cache.clear();
    expect(notifications).toBe(4);

    unsubBad();
    unsubGood();
    cache.recordSuccess('ch:2');
    expect(notifications).toBe(4);
  });
});

describe('createIdleProbeController (#167)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('refuses background probes when maxConnections <= 1 or omitted', () => {
    const ctl = createIdleProbeController();
    expect(ctl.beginProbe()).toBeNull();
    expect(ctl.beginProbe({ maxConnections: 1 })).toBeNull();
    expect(ctl.beginProbe({ maxConnections: 0 })).toBeNull();
    expect(ctl.beginProbe({ maxConnections: -2 })).toBeNull();
    expect(ctl.activeCount()).toBe(0);
  });

  it('tracks multi-connection probes, cleans up on finishProbe, and aborts all synchronously on abortAll', () => {
    const ctl = createIdleProbeController();
    const s1 = ctl.beginProbe({ maxConnections: 2 });
    const s2 = ctl.beginProbe({ maxConnections: 4 });
    const s3 = ctl.beginProbe({ maxConnections: 2 });

    expect(s1).not.toBeNull();
    expect(s2).not.toBeNull();
    expect(s3).not.toBeNull();
    expect(ctl.activeCount()).toBe(3);

    // Completing s2 removes it without aborting
    ctl.finishProbe(s2 as AbortSignal);
    expect(s2?.aborted).toBe(false);
    expect(ctl.activeCount()).toBe(2);

    const reasons: unknown[] = [];
    s1?.addEventListener('abort', () => reasons.push(s1.reason));
    s3?.addEventListener('abort', () => reasons.push(s3.reason));

    ctl.abortAll('tune');
    expect(ctl.activeCount()).toBe(0);
    expect(s1?.aborted).toBe(true);
    expect(s3?.aborted).toBe(true);
    expect(s2?.aborted).toBe(false);
    expect(reasons).toEqual(['tune', 'tune']);
  });
});

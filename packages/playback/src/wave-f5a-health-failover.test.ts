import { elvError, err, ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineError, LoadCommand, StreamRequest } from './engine';
import { bridgeNativeEngine, type NativeLoadCommand } from './native-bridge';
import { createPlaybackService } from './service';
import { createIdleProbeController, createStreamHealthCache } from './stream-health-cache';
import {
  createStreamHealthScorer,
  DEFAULT_HEALTH_SCORER_HALF_LIFE_MS,
} from './stream-health-scorer';
import { createFakePlayerEngine, type FakeStep } from './testing';
import type { TuneRequest } from './types';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});
afterEach(() => vi.useRealTimers());

function makeService(
  opts: Parameters<typeof createPlaybackService>[0] extends infer D
    ? Omit<D, 'engine' | 'clock' | 'timers'>
    : never = {},
  scripts: Record<string, readonly FakeStep[]> = {},
) {
  const engine = createFakePlayerEngine({
    scripts,
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const loads: LoadCommand[] = [];
  const origLoad = engine.load.bind(engine);
  vi.spyOn(engine, 'load').mockImplementation((cmd) => {
    loads.push(cmd);
    origLoad(cmd);
  });
  const service = createPlaybackService({
    engine,
    clock: { now: () => Date.now() },
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    ...opts,
  });
  return { engine, service, loads };
}

async function climbToRung4(
  engine: ReturnType<typeof createFakePlayerEngine>,
  service: ReturnType<typeof createPlaybackService>,
  e: EngineError = { code: 'network' },
): Promise<void> {
  for (const gap of [0, 1_000, 2_000, 4_000]) {
    engine.emit({ attempt: service.getState().attempt, type: 'error', error: e });
    await vi.advanceTimersByTimeAsync(gap);
  }
}

describe('Wave F5A playback wiring (#157, #167, #195, #172)', () => {
  it('forwards dnsFamily and hostOverride from StreamRequest into engine.load options and bridgeNativeEngine', async () => {
    const { service, loads } = makeService({}, { 'https://edge.test/live/1.ts': [] });
    service.tune({
      item: 'x:src1:live:1',
      accountKey: 'src1',
      kind: 'live',
      resolve: () =>
        Promise.resolve(
          ok({
            url: 'https://edge.test/live/1.ts',
            headers: {},
            dnsFamily: 'ipv4',
            hostOverride: '203.0.113.10',
            sourceId: 'src1',
            channelKey: 'x:src1:live:1',
            accountKey: 'src1',
            maxConnections: 2,
          }),
        ),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(loads).toHaveLength(1);
    expect(loads[0]?.options).toMatchObject({
      dnsFamily: 'ipv4',
      hostOverride: '203.0.113.10',
    });

    // Verify native bridge flattens dnsFamily & hostOverride onto NativeLoadCommand
    const nativeLoads: NativeLoadCommand[] = [];
    const bridged = bridgeNativeEngine(
      {
        load: (cmd) => nativeLoads.push(cmd),
        retry: () => {},
        play: () => {},
        pause: () => {},
        seek: () => {},
        stop: () => {},
        recreate: () => {},
        release: () => {},
        addListener: () => ({ remove: () => {} }),
      },
      {
        capabilities: {
          mpegTsOverHttp: true,
          hls: true,
          liveSeek: false,
          softwareAudioFallback: false,
          recreate: true,
          audioTrackSelection: true,
          subtitleTrackSelection: true,
        },
        uptimeMs: () => 0,
        now: () => Date.now(),
      },
    );
    bridged.load({
      attempt: 1,
      url: 'https://edge.test/live/1.ts',
      headers: {},
      kind: 'live',
      options: { dnsFamily: 'ipv6', hostOverride: '2001:db8::1' },
    });
    expect(nativeLoads[0]).toMatchObject({
      dnsFamily: 'ipv6',
      hostOverride: '2001:db8::1',
    });
    service.dispose();
  });

  it('synchronously aborts all active idle probes at the start of service.tune() before calling resolve()', () => {
    const idleProbeController = createIdleProbeController();
    const signal = idleProbeController.beginProbe({ maxConnections: 2 });
    expect(signal?.aborted).toBe(false);

    const events: string[] = [];
    signal?.addEventListener('abort', () => events.push(`aborted:${String(signal.reason)}`));

    const { service } = makeService({ idleProbeController }, { 'http://a.test/1.ts': [] });
    service.tune({
      item: 'x:src1:live:1',
      accountKey: 'src1',
      kind: 'live',
      resolve: () => {
        events.push(`resolve:aborted=${String(signal?.aborted)}`);
        return Promise.resolve(ok({ url: 'http://a.test/1.ts', headers: {} }));
      },
    });

    expect(events).toEqual(['aborted:tune', 'resolve:aborted=true']);
    expect(idleProbeController.activeCount()).toBe(0);
    service.dispose();
  });

  it('records passive health cache, decayed scorer, throttled buffer depth, and onStreamOutcome callbacks', async () => {
    const clock = { now: () => Date.now() };
    const healthCache = createStreamHealthCache({ clock });
    const healthScorer = createStreamHealthScorer({ clock });
    const outcomes: { url: string; outcome: 'success' | 'failure' }[] = [];

    const stream: StreamRequest = {
      url: 'http://edge.test/live/u/p/10.ts?token=abc',
      finalUrl: 'http://cdn.test/live/u/p/10.ts?token=xyz',
      headers: {},
      sourceId: 'src1',
    };
    const { engine, service } = makeService(
      {
        healthCache,
        healthScorer,
        onStreamOutcome: (s, outcome) => outcomes.push({ url: s.url, outcome }),
      },
      { [stream.url]: [] },
    );

    service.tune({
      item: 'x:src1:live:10',
      accountKey: 'src1',
      kind: 'live',
      resolve: () => Promise.resolve(ok(stream)),
    });
    await vi.advanceTimersByTimeAsync(0);

    // Advance 600ms and emit firstFrame -> fast TTFF (+0.8) & healthy cache
    await vi.advanceTimersByTimeAsync(600);
    const attempt = service.getState().attempt;
    engine.emit({ attempt, type: 'firstFrame', atMs: Date.now() });
    engine.emit({ attempt, type: 'state', state: 'playing' });

    expect(healthCache.get('x:src1:live:10')).toMatchObject({
      status: 'healthy',
      lastTtffMs: 600,
    });
    expect(healthCache.get('http://edge.test/live/u/p/10.ts')).toMatchObject({
      status: 'healthy',
      lastTtffMs: 600,
    });
    expect(healthScorer.score(stream.finalUrl as string)).toBeCloseTo(0.8, 5);
    expect(outcomes).toEqual([{ url: stream.url, outcome: 'success' }]);

    // Clock ticks with 5s live buffer: first tick sampled (+0.25), second within 5s throttled!
    const scoreBeforeBuffer = healthScorer.score(stream.finalUrl as string);
    engine.emit({
      attempt,
      type: 'clock',
      anchor: { positionMs: 10_000, liveEdgeMs: 15_000, atMs: Date.now(), rate: 1 },
    });
    const scoreAfterFirstBuf = healthScorer.score(stream.finalUrl as string);
    expect(scoreAfterFirstBuf - scoreBeforeBuffer).toBeCloseTo(0.25, 2);

    await vi.advanceTimersByTimeAsync(2_000);
    engine.emit({
      attempt,
      type: 'clock',
      anchor: { positionMs: 12_000, liveEdgeMs: 17_000, atMs: Date.now(), rate: 1 },
    });
    // Still throttled (< 5s), so score did NOT increase by another +0.25
    expect(healthScorer.score(stream.finalUrl as string)).toBeLessThanOrEqual(scoreAfterFirstBuf);

    // Stall start records stall into both cache and scorer; stall end is ignored
    engine.emit({ attempt, type: 'stall', phase: 'start', atMs: Date.now() });
    engine.emit({ attempt, type: 'stall', phase: 'end', atMs: Date.now() });
    expect(healthCache.get('x:src1:live:10')?.stallCount).toBe(1);
    engine.emit({ attempt, type: 'stall', phase: 'start', atMs: Date.now() });
    expect(healthCache.get('x:src1:live:10')?.status).toBe('flaky');

    // Terminal 404 marks dead immediately and fires onStreamOutcome('failure')
    engine.emit({ attempt, type: 'error', error: { code: 'http-404', httpStatus: 404 } });
    expect(healthCache.get('x:src1:live:10')?.status).toBe('dead');
    expect(outcomes.at(-1)).toEqual({ url: stream.url, outcome: 'failure' });

    // Resolve failure records failure on item key
    service.tune({
      item: 'x:src1:live:missing',
      accountKey: 'src1',
      kind: 'live',
      resolve: () => Promise.resolve(err(elvError('playback', 'http-404'))),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(healthCache.get('x:src1:live:missing')?.status).toBe('dead');

    service.dispose();
  });

  it('records failure into healthCache, healthScorer, and onStreamOutcome when live start times out silently', async () => {
    const clock = { now: () => Date.now() };
    const healthCache = createStreamHealthCache({ clock });
    const healthScorer = createStreamHealthScorer({ clock });
    const outcomes: string[] = [];

    const { service } = makeService(
      {
        healthCache,
        healthScorer,
        onStreamOutcome: (s, outcome) => outcomes.push(`${outcome}:${s.url}`),
      },
      { 'http://hung.test/live/1.ts': [] },
    );

    service.tune({
      item: 'x:src1:live:hung',
      accountKey: 'src1',
      kind: 'live',
      resolve: () => Promise.resolve(ok({ url: 'http://hung.test/live/1.ts', headers: {} })),
    });
    await vi.advanceTimersByTimeAsync(0);
    // Live start timeout is 5,000ms
    await vi.advanceTimersByTimeAsync(5_000);

    expect(healthCache.get('x:src1:live:hung')?.status).toBe('flaky');
    expect(healthScorer.score('http://hung.test/live/1.ts')).toBeLessThan(0);
    expect(outcomes).toContain('failure:http://hung.test/live/1.ts');

    service.dispose();
  });

  it('ranks Rung-4 inline alternates by decayed health score and restores user priority after decay', async () => {
    const clock = { now: () => Date.now() };
    const healthScorer = createStreamHealthScorer({ clock });

    // Penalize alt-1 so alt-2 is picked ahead of alt-1 despite alt-1 being first in priority order
    healthScorer.recordFailure('http://alt1.test/live/1.ts');

    const { engine, service, loads } = makeService(
      { healthScorer },
      {
        'http://primary.test/live/1.ts': [],
        'http://alt1.test/live/1.ts': [],
        'http://alt2.test/live/1.ts': [],
      },
    );
    const primary: StreamRequest = {
      url: 'http://primary.test/live/1.ts',
      headers: {},
      accountKey: 'src-a',
      alternates: [
        { url: 'http://alt1.test/live/1.ts', headers: {}, accountKey: 'src-b', maxConnections: 2 },
        { url: 'http://alt2.test/live/1.ts', headers: {}, accountKey: 'src-c', maxConnections: 2 },
      ],
    };

    const req: TuneRequest = {
      item: 'x:src-a:live:1',
      accountKey: 'src-a',
      kind: 'live',
      resolve: () => Promise.resolve(ok(primary)),
    };
    service.tune(req);
    await vi.advanceTimersByTimeAsync(0);
    engine.emit({ attempt: service.getState().attempt, type: 'state', state: 'playing' });

    await climbToRung4(engine, service);
    expect(loads.at(-1)?.url).toBe('http://alt2.test/live/1.ts');

    // If alt2 also fails, falls back to alt1
    engine.emit({ attempt: service.getState().attempt, type: 'error', error: { code: 'network' } });
    await vi.advanceTimersByTimeAsync(4_000);
    expect(loads.at(-1)?.url).toBe('http://alt1.test/live/1.ts');

    // Stop playback and advance clock past 12 half-lives so penalties decay below tie tolerance (< 0.01) -> user priority restored!
    service.stop();
    await vi.advanceTimersByTimeAsync(12 * DEFAULT_HEALTH_SCORER_HALF_LIFE_MS);
    service.tune(req);
    await vi.advanceTimersByTimeAsync(0);
    engine.emit({ attempt: service.getState().attempt, type: 'firstFrame', atMs: Date.now() });
    engine.emit({ attempt: service.getState().attempt, type: 'state', state: 'playing' });
    await climbToRung4(engine, service);
    expect(loads.at(-1)?.url).toBe('http://alt1.test/live/1.ts');

    service.dispose();
  });

  it('skips saturated cross-source alternates via canAcquireAlternate while allowing same-account alternates', async () => {
    const canAcquireAlternate = vi.fn((accountKey: string, maxConnections: number) => {
      if (accountKey === 'src-saturated') return false;
      return maxConnections >= 1;
    });

    const { engine, service, loads } = makeService(
      { canAcquireAlternate },
      {
        'http://src-a.test/live/1.ts': [],
        'http://saturated.test/live/1.ts': [],
        'http://src-a-backup.test/live/1.ts': [],
      },
    );
    const primary: StreamRequest = {
      url: 'http://src-a.test/live/1.ts',
      headers: {},
      accountKey: 'src-a',
      maxConnections: 1,
      alternates: [
        // Cross-source saturated account -> MUST BE SKIPPED!
        {
          url: 'http://saturated.test/live/1.ts',
          headers: {},
          accountKey: 'src-saturated',
          maxConnections: 1,
        },
        // Same-account backup mirror (maxConnections: 1) -> MUST BE ALLOWED because stopMedia closed prior socket!
        {
          url: 'http://src-a-backup.test/live/1.ts',
          headers: {},
          accountKey: 'src-a',
          maxConnections: 1,
          dnsFamily: 'ipv4',
          hostOverride: '203.0.113.55',
        },
      ],
    };

    service.tune({
      item: 'x:src-a:live:1',
      accountKey: 'src-a',
      kind: 'live',
      resolve: () => Promise.resolve(ok(primary)),
    });
    await vi.advanceTimersByTimeAsync(0);
    engine.emit({ attempt: service.getState().attempt, type: 'state', state: 'playing' });

    await climbToRung4(engine, service);
    expect(loads.map((l) => l.url)).not.toContain('http://saturated.test/live/1.ts');
    expect(loads.at(-1)?.url).toBe('http://src-a-backup.test/live/1.ts');
    expect(loads.at(-1)?.options).toMatchObject({
      dnsFamily: 'ipv4',
      hostOverride: '203.0.113.55',
    });
    expect(canAcquireAlternate).toHaveBeenCalledWith('src-saturated', 1);
    expect(canAcquireAlternate).not.toHaveBeenCalledWith('src-a', 1);

    service.dispose();
  });

  it('cascades http-404 onNotFound through Rung-4 multi-source alternates including consecutive 404s and alternate timeout (#157, #317)', async () => {
    // Scenario 1: primary 404 -> Rung-2 retry 404 -> Rung-4 alt1 404 -> Rung-4 alt2 succeeds
    {
      const { engine, service, loads } = makeService(
        {},
        {
          'http://primary.test/stream/1': [],
          'http://alt1.test/stream/1': [],
          'http://alt2.test/stream/1': [],
        },
      );
      const primary: StreamRequest = {
        url: 'http://primary.test/stream/1',
        headers: {},
        sourceId: 'src-a',
        accountKey: 'src-a',
        alternates: [
          {
            url: 'http://alt1.test/stream/1',
            headers: {},
            sourceId: 'src-b',
            accountKey: 'src-b',
          },
          {
            url: 'http://alt2.test/stream/1',
            headers: {},
            sourceId: 'src-c',
            accountKey: 'src-c',
          },
        ],
      };

      service.tune({
        item: 'x:src-a:live:1',
        accountKey: 'src-a',
        kind: 'live',
        resolve: () => Promise.resolve(ok(primary)),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(loads.at(-1)?.url).toBe('http://primary.test/stream/1');

      // Primary 404 -> Rung 2 reload after 1s gap
      engine.emit({
        attempt: service.getState().attempt,
        type: 'error',
        error: { code: 'http-404', httpStatus: 404 },
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(loads.at(-1)?.url).toBe('http://primary.test/stream/1');

      // Rung 2 404 -> Rung 4 alt1 immediately (silent gap 0)
      engine.emit({
        attempt: service.getState().attempt,
        type: 'error',
        error: { code: 'http-404', httpStatus: 404 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(loads.at(-1)?.url).toBe('http://alt1.test/stream/1');

      // alt1 ALSO returns 404 -> Rung 4 advances to alt2 instead of giving up
      engine.emit({
        attempt: service.getState().attempt,
        type: 'error',
        error: { code: 'http-404', httpStatus: 404 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(loads.at(-1)?.url).toBe('http://alt2.test/stream/1');

      // alt2 succeeds
      engine.emit({ attempt: service.getState().attempt, type: 'firstFrame', atMs: Date.now() });
      engine.emit({ attempt: service.getState().attempt, type: 'state', state: 'playing' });
      expect(service.getState().status.kind).toBe('playing');
      service.dispose();
    }

    // Scenario 2: primary 404 -> Rung-2 retry 404 -> Rung-4 alt1 times out silently -> advances to alt2
    {
      const { engine, service, loads } = makeService(
        {},
        {
          'http://primary.test/stream/2': [],
          'http://alt1.test/stream/2': [],
          'http://alt2.test/stream/2': [],
        },
      );
      const primary: StreamRequest = {
        url: 'http://primary.test/stream/2',
        headers: {},
        sourceId: 'src-a',
        accountKey: 'src-a',
        alternates: [
          {
            url: 'http://alt1.test/stream/2',
            headers: {},
            sourceId: 'src-b',
            accountKey: 'src-b',
          },
          {
            url: 'http://alt2.test/stream/2',
            headers: {},
            sourceId: 'src-c',
            accountKey: 'src-c',
          },
        ],
      };

      service.tune({
        item: 'x:src-a:live:2',
        accountKey: 'src-a',
        kind: 'live',
        resolve: () => Promise.resolve(ok(primary)),
      });
      await vi.advanceTimersByTimeAsync(0);

      // Primary 404 -> Rung 2
      engine.emit({
        attempt: service.getState().attempt,
        type: 'error',
        error: { code: 'http-404', httpStatus: 404 },
      });
      await vi.advanceTimersByTimeAsync(1_000);

      // Rung 2 404 -> Rung 4 alt1
      engine.emit({
        attempt: service.getState().attempt,
        type: 'error',
        error: { code: 'http-404', httpStatus: 404 },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(loads.at(-1)?.url).toBe('http://alt1.test/stream/2');

      // alt1 hangs and hits rungTimeoutMs (2s default) -> MUST advance to alt2 instead of giving up
      await vi.advanceTimersByTimeAsync(2_000);
      expect(loads.at(-1)?.url).toBe('http://alt2.test/stream/2');

      engine.emit({ attempt: service.getState().attempt, type: 'firstFrame', atMs: Date.now() });
      engine.emit({ attempt: service.getState().attempt, type: 'state', state: 'playing' });
      expect(service.getState().status.kind).toBe('playing');
      service.dispose();
    }
  });

  it('does not leak primary TuneRequest allowLegacyTls, dnsFamily, or hostOverride onto cross-source alternates (#157, #172)', async () => {
    const { engine, service, loads } = makeService(
      {},
      {
        'https://src-a.test/live/1.ts': [],
        'https://src-b.test/live/1.ts': [],
      },
    );

    const primary: StreamRequest = {
      url: 'https://src-a.test/live/1.ts',
      headers: {},
      sourceId: 'src-a',
      accountKey: 'src-a',
      alternates: [
        {
          url: 'https://src-b.test/live/1.ts',
          headers: {},
          sourceId: 'src-b',
          accountKey: 'src-b',
        },
      ],
    };

    service.tune({
      item: 'x:src-a:live:1',
      accountKey: 'src-a',
      kind: 'live',
      allowLegacyTls: true,
      dnsFamily: 'ipv4',
      hostOverride: '203.0.113.10',
      resolve: () => Promise.resolve(ok(primary)),
    });
    await vi.advanceTimersByTimeAsync(0);

    // Primary inherits TuneRequest overrides
    expect(loads[0]?.url).toBe('https://src-a.test/live/1.ts');
    expect(loads[0]?.options).toMatchObject({
      allowLegacyTls: true,
      dnsFamily: 'ipv4',
      hostOverride: '203.0.113.10',
    });

    // Fail primary to Rung 4 -> Source B alternate must NOT inherit Source A's transport overrides
    await climbToRung4(engine, service);
    const altLoad = loads.at(-1);
    expect(altLoad?.url).toBe('https://src-b.test/live/1.ts');
    expect(altLoad?.options?.allowLegacyTls).toBeUndefined();
    expect(altLoad?.options?.dnsFamily).toBeUndefined();
    expect(altLoad?.options?.hostOverride).toBeUndefined();

    service.dispose();
  });
});

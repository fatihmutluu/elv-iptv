import { ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClockAnchor, EngineCapabilities, EngineEvent, StreamRequest } from './engine';
import { bridgeNativeEngine, type NativeEngineHandle } from './native-bridge';
import { createPlaybackService } from './service';
import { resolveSeekTarget } from './service-events';
import { createFakePlayerEngine, type FakePlayerEngine } from './testing';
import {
  clampLiveSeekPosition,
  DEFAULT_LIVE_BEHIND_THRESHOLD_MS,
  formatLiveOffset,
  isBehindLiveEdge,
  resolveLiveTimeShiftWindow,
} from './timeshift';
import type { PlaybackService, PlaybackState, TuneRequest } from './types';

const req = (url: string): StreamRequest => ({ url, headers: {} });

const tuneReq = (url: string, extra: Partial<TuneRequest> = {}): TuneRequest => ({
  item: `item-${url}`,
  accountKey: 'acc',
  kind: 'live',
  resolve: () => Promise.resolve(ok(req(url))),
  ...extra,
});

function setup(opts?: { withNativeJump?: boolean }): {
  engine: FakePlayerEngine;
  service: PlaybackService;
  jumpSpy?: ReturnType<typeof vi.fn>;
} {
  const engine = createFakePlayerEngine({
    scripts: {},
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    anchorOnPlayPause: true,
  });
  let jumpSpy: ReturnType<typeof vi.fn> | undefined;
  if (opts?.withNativeJump) {
    jumpSpy = vi.fn();
    engine.jumpToLiveEdge = jumpSpy as (attempt: number) => void;
  }
  const service = createPlaybackService({
    engine,
    clock: { now: () => Date.now() },
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    config: { startTimeoutMs: 8_000 },
  });
  return { engine, service, ...(jumpSpy === undefined ? {} : { jumpSpy }) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
});

afterEach(() => vi.useRealTimers());

describe('timeshift pure helpers (#28)', () => {
  it('resolves bounded live time-shift windows and rejects unsupported or invalid anchors', () => {
    expect(resolveLiveTimeShiftWindow(undefined, 10_000)).toBeNull();
    expect(
      resolveLiveTimeShiftWindow(
        {
          positionMs: 50_000,
          atMs: 10_000,
          rate: 1,
          liveSeekableStartMs: 10_000,
          liveEdgeMs: 60_000,
          timeShiftSupported: false,
        },
        10_000,
      ),
    ).toBeNull();
    // Plain live anchor with only liveEdgeMs does not imply time-shift window
    expect(
      resolveLiveTimeShiftWindow(
        { positionMs: 50_000, atMs: 10_000, rate: 1, liveEdgeMs: 60_000 },
        10_000,
      ),
    ).toBeNull();
    // Inverted or zero-span bounds are rejected
    expect(
      resolveLiveTimeShiftWindow(
        {
          positionMs: 50_000,
          atMs: 10_000,
          rate: 1,
          liveSeekableStartMs: 60_000,
          liveEdgeMs: 60_000,
          timeShiftSupported: true,
        },
        10_000,
      ),
    ).toBeNull();
    expect(
      resolveLiveTimeShiftWindow(
        {
          positionMs: 50_000,
          atMs: 10_000,
          rate: 1,
          liveSeekableStartMs: -5_000,
          liveEdgeMs: 60_000,
          timeShiftSupported: true,
        },
        10_000,
      ),
    ).toBeNull();

    // Explicit seekable range with extrapolation
    const win = resolveLiveTimeShiftWindow(
      {
        positionMs: 120_000,
        atMs: 10_000,
        rate: 1,
        liveSeekableStartMs: 60_000,
        liveEdgeMs: 180_000,
        timeShiftSupported: true,
      },
      15_000,
    );
    expect(win).toEqual({
      startMs: 60_000,
      endMs: 180_000,
      spanMs: 120_000,
      positionMs: 125_000,
      behindLiveMs: 55_000,
    });

    // Explicit liveSeekableStartMs + liveEdgeMs works even when timeShiftSupported is omitted
    const implicitWin = resolveLiveTimeShiftWindow(
      {
        positionMs: 30_000,
        atMs: 10_000,
        rate: 0,
        liveSeekableStartMs: 40_000,
        liveEdgeMs: 90_000,
      },
      10_000,
    );
    expect(implicitWin).toEqual({
      startMs: 40_000,
      endMs: 90_000,
      spanMs: 50_000,
      positionMs: 40_000,
      behindLiveMs: 50_000,
    });

    // timeShiftSupported: true with omitted liveSeekableStartMs defaults startMs to 0
    const zeroStartWin = resolveLiveTimeShiftWindow(
      {
        positionMs: 25_000,
        atMs: 10_000,
        rate: 0,
        liveEdgeMs: 30_000,
        timeShiftSupported: true,
      },
      10_000,
    );
    expect(zeroStartWin).toEqual({
      startMs: 0,
      endMs: 30_000,
      spanMs: 30_000,
      positionMs: 25_000,
      behindLiveMs: 5_000,
    });
  });

  it('clamps live seek targets strictly within [liveSeekableStartMs, liveEdgeMs]', () => {
    const anchor: ClockAnchor = {
      positionMs: 120_000,
      atMs: 10_000,
      rate: 1,
      liveSeekableStartMs: 60_000,
      liveEdgeMs: 180_000,
      timeShiftSupported: true,
    };
    expect(clampLiveSeekPosition(anchor, 20_000, 10_000)).toBe(60_000);
    expect(clampLiveSeekPosition(anchor, 250_000, 10_000)).toBe(180_000);
    expect(clampLiveSeekPosition(anchor, 100_000, 10_000)).toBe(100_000);
    expect(clampLiveSeekPosition(anchor, Number.NaN, 10_000)).toBeUndefined();
    expect(clampLiveSeekPosition(undefined, 100_000, 10_000)).toBeUndefined();
    expect(
      clampLiveSeekPosition(
        {
          positionMs: 10_000,
          atMs: 10_000,
          rate: 1,
          liveEdgeMs: 20_000,
          timeShiftSupported: false,
        },
        15_000,
        10_000,
      ),
    ).toBeUndefined();
  });

  it('evaluates isBehindLiveEdge with 2s default threshold and clock extrapolation', () => {
    expect(DEFAULT_LIVE_BEHIND_THRESHOLD_MS).toBe(2_000);
    expect(isBehindLiveEdge(undefined, 10_000)).toBe(false);
    expect(isBehindLiveEdge({ positionMs: 10_000, atMs: 10_000, rate: 1 }, 10_000)).toBe(false);

    const playing: ClockAnchor = {
      positionMs: 25_000,
      atMs: 10_000,
      rate: 1,
      liveEdgeMs: 30_000,
      timeShiftSupported: true,
    };
    expect(isBehindLiveEdge(playing, 10_000)).toBe(true); // 5_000 > 2_000
    expect(isBehindLiveEdge(playing, 13_000)).toBe(false); // 2_000 <= 2_000
    expect(isBehindLiveEdge(playing, 13_000, 1_500)).toBe(true); // 2_000 > 1_500

    const paused: ClockAnchor = { ...playing, rate: 0 };
    expect(isBehindLiveEdge(paused, 20_000)).toBe(true);
  });

  it('formats behind-live offsets as negative MM:SS or H:MM:SS', () => {
    expect(formatLiveOffset(0)).toBe('-00:00');
    expect(formatLiveOffset(-5_000)).toBe('-00:00');
    expect(formatLiveOffset(Number.NaN)).toBe('-00:00');
    expect(formatLiveOffset(5_400)).toBe('-00:05');
    expect(formatLiveOffset(134_000)).toBe('-02:14');
    expect(formatLiveOffset(3_665_000)).toBe('-1:01:05');
  });

  it('clamps live seek targets in resolveSeekTarget and blocks explicit timeShiftSupported=false', () => {
    const windowAnchor: ClockAnchor = {
      positionMs: 100_000,
      atMs: 10_000,
      rate: 1,
      liveSeekableStartMs: 40_000,
      liveEdgeMs: 160_000,
      timeShiftSupported: true,
    };
    expect(resolveSeekTarget(10_000, false, 'playing', undefined, windowAnchor)).toBe(40_000);
    expect(resolveSeekTarget(200_000, false, 'playing', undefined, windowAnchor)).toBe(160_000);
    expect(resolveSeekTarget(90_000, false, 'playing', undefined, windowAnchor)).toBe(90_000);

    const nonSeekable: ClockAnchor = {
      positionMs: 100_000,
      atMs: 10_000,
      rate: 1,
      liveEdgeMs: 100_000,
      timeShiftSupported: false,
    };
    expect(resolveSeekTarget(80_000, false, 'playing', undefined, nonSeekable)).toBeUndefined();

    // Missing, zero, or inverted liveEdgeMs must return undefined (never allow unbounded forward seeks)
    expect(
      resolveSeekTarget(999_999, false, 'playing', undefined, {
        positionMs: 10_000,
        atMs: 10_000,
        rate: 1,
        liveSeekableStartMs: 0,
        timeShiftSupported: true,
      }),
    ).toBeUndefined();
    expect(
      resolveSeekTarget(999_999, false, 'playing', undefined, {
        positionMs: 60_000,
        atMs: 10_000,
        rate: 1,
        liveSeekableStartMs: 60_000,
        liveEdgeMs: 60_000,
        timeShiftSupported: true,
      }),
    ).toBeUndefined();
    expect(
      resolveSeekTarget(999_999, false, 'playing', undefined, {
        positionMs: 60_000,
        atMs: 10_000,
        rate: 1,
        liveSeekableStartMs: 70_000,
        liveEdgeMs: 60_000,
        timeShiftSupported: true,
      }),
    ).toBeUndefined();
  });
});

describe('PlaybackService bounded live time-shift (#28)', () => {
  it('allows seek() and seekBy() clamped strictly to [liveSeekableStartMs, liveEdgeMs] and preserves anchor metadata', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://provider.invalid/live/1.m3u8', { kind: 'live' }));
    await vi.advanceTimersByTimeAsync(300);

    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 150_000,
        atMs: Date.now(),
        rate: 1,
        liveSeekableStartMs: 60_000,
        liveEdgeMs: 180_000,
        timeShiftSupported: true,
      },
    });

    // Seek below window start clamps to liveSeekableStartMs
    service.seek(10_000);
    expect(service.getState().anchor?.positionMs).toBe(60_000);
    expect(service.getState().anchor?.liveSeekableStartMs).toBe(60_000);
    expect(service.getState().anchor?.timeShiftSupported).toBe(true);
    expect(service.getState().atLiveEdge).toBe(false);
    expect(engine.commands.at(-1)).toEqual({ name: 'seek', attempt: t, positionMs: 60_000 });

    // Rejected pre-seek clock still updates liveSeekableStartMs / liveEdgeMs / timeShiftSupported
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 151_000,
        atMs: Date.now(),
        rate: 1,
        liveSeekableStartMs: 65_000,
        liveEdgeMs: 185_000,
        timeShiftSupported: true,
      },
    });
    expect(service.getState().anchor?.liveSeekableStartMs).toBe(65_000);
    expect(service.getState().anchor?.liveEdgeMs).toBe(185_000);

    // Let seek settle, then seekBy(-10_000) clamps to start and seekBy(+500_000) clamps to liveEdgeMs
    await vi.advanceTimersByTimeAsync(500);
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 70_000,
        atMs: Date.now(),
        rate: 1,
        liveSeekableStartMs: 65_000,
        liveEdgeMs: 185_000,
        timeShiftSupported: true,
      },
    });
    service.seekBy?.(-20_000);
    expect(service.getState().anchor?.positionMs).toBe(65_000);
    await vi.advanceTimersByTimeAsync(500);

    service.seekBy?.(500_000);
    expect(service.getState().anchor?.positionMs).toBe(185_000);
    expect(service.getState().atLiveEdge).toBe(true);
  });

  it('blocks live seek() and seekBy() when timeShiftSupported is false', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://provider.invalid/live/raw.ts', { kind: 'live' }));
    await vi.advanceTimersByTimeAsync(300);

    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 20_000,
        atMs: Date.now(),
        rate: 1,
        liveEdgeMs: 20_000,
        timeShiftSupported: false,
      },
    });

    service.seek(10_000);
    service.seekBy?.(-10_000);
    expect(engine.commands.filter((c) => c.name === 'seek')).toHaveLength(0);
    expect(service.getState().anchor?.positionMs).toBe(20_000);
  });

  it('jumpToLiveEdge() seeks directly to liveEdgeMs when timeShiftSupported is true and behind > 2s', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://provider.invalid/live/hls.m3u8', { kind: 'live' }));
    await vi.advanceTimersByTimeAsync(300);

    // Within 2s -> returns false
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 178_500,
        atMs: Date.now(),
        rate: 1,
        liveSeekableStartMs: 60_000,
        liveEdgeMs: 180_000,
        timeShiftSupported: true,
      },
    });
    expect(service.jumpToLiveEdge()).toBe(false);

    // Behind by 25s -> jumps straight to liveEdgeMs (180_000)
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 155_000,
        atMs: Date.now(),
        rate: 1,
        liveSeekableStartMs: 60_000,
        liveEdgeMs: 180_000,
        timeShiftSupported: true,
      },
    });
    expect(service.jumpToLiveEdge()).toBe(true);
    expect(service.getState().anchor?.positionMs).toBe(180_000);
    expect(service.getState().atLiveEdge).toBe(true);
    expect(engine.commands.at(-1)).toEqual({ name: 'seek', attempt: t, positionMs: 180_000 });
  });

  it('jumpToLiveEdge() delegates to engine.jumpToLiveEdge when supported', async () => {
    const { engine, service, jumpSpy } = setup({ withNativeJump: true });
    const t = service.tune(
      tuneReq('http://provider.invalid/live/native-jump.m3u8', { kind: 'live' }),
    );
    await vi.advanceTimersByTimeAsync(300);

    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 100_000,
        atMs: Date.now(),
        rate: 0,
        liveSeekableStartMs: 60_000,
        liveEdgeMs: 180_000,
        timeShiftSupported: true,
      },
    });

    expect(service.jumpToLiveEdge()).toBe(true);
    expect(jumpSpy).toHaveBeenCalledWith(t);
    expect(service.getState().anchor?.positionMs).toBe(180_000);
    expect(service.getState().atLiveEdge).toBe(true);
  });

  it('supports seekBy() on VOD streams clamped to [0, durationMs]', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://provider.invalid/movie/1.mp4', { kind: 'vod' }));
    await vi.advanceTimersByTimeAsync(300);
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 50_000, atMs: Date.now(), rate: 1, durationMs: 120_000 },
    });

    service.seekBy?.(10_000);
    expect(service.getState().anchor?.positionMs).toBe(60_000);
    expect(engine.commands.at(-1)).toEqual({ name: 'seek', attempt: t, positionMs: 60_000 });

    service.seekBy?.(Number.NaN);
    expect(service.getState().anchor?.positionMs).toBe(60_000);
  });

  it('notifies subscribers when liveSeekableStartMs or timeShiftSupported changes on clock anchor', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://provider.invalid/live/notify.m3u8', { kind: 'live' }));
    await vi.advanceTimersByTimeAsync(300);

    const now = Date.now();
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 20_000,
        atMs: now,
        rate: 1,
        liveEdgeMs: 20_000,
        timeShiftSupported: false,
      },
    });

    const snapshots: PlaybackState[] = [];
    service.subscribe((s) => snapshots.push(s));

    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 20_000,
        atMs: now,
        rate: 1,
        liveSeekableStartMs: 0,
        liveEdgeMs: 20_000,
        timeShiftSupported: true,
      },
    });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.anchor?.timeShiftSupported).toBe(true);
    expect(snapshots[0]?.anchor?.liveSeekableStartMs).toBe(0);
  });

  it('preserves liveSeekableStartMs and timeShiftSupported in native bridge and FakePlayerEngine play/pause anchors', async () => {
    const listeners = new Set<(event: EngineEvent) => void>();
    const jumpNative = vi.fn();
    const native: NativeEngineHandle = {
      load: vi.fn(),
      retry: vi.fn(),
      play: vi.fn(),
      pause: vi.fn(),
      seek: vi.fn(),
      jumpToLiveEdge: jumpNative,
      stop: vi.fn(),
      recreate: vi.fn(),
      release: vi.fn(),
      addListener: (_name, listener) => {
        listeners.add(listener);
        return { remove: () => listeners.delete(listener) };
      },
    };
    const caps: EngineCapabilities = {
      mpegTsOverHttp: true,
      hls: true,
      liveSeek: true,
      softwareAudioFallback: true,
      recreate: true,
      audioTrackSelection: true,
      subtitleTrackSelection: true,
    };
    const bridged = bridgeNativeEngine(native, {
      capabilities: caps,
      uptimeMs: () => 5_000,
      now: () => 50_000,
    });
    const received: EngineEvent[] = [];
    bridged.subscribe((e) => received.push(e));
    bridged.load({ attempt: 1, url: 'http://sim/live/1.m3u8', headers: {}, kind: 'live' });
    for (const l of listeners) {
      l({
        attempt: 1,
        type: 'clock',
        anchor: {
          positionMs: 12_000,
          atMs: 4_900,
          rate: 1,
          liveSeekableStartMs: 0,
          liveEdgeMs: 30_000,
          timeShiftSupported: true,
        },
      });
      l({
        attempt: 1,
        type: 'clock',
        anchor: {
          positionMs: 12_000,
          atMs: 4_950,
          rate: 1,
          liveSeekableStartMs: -10,
          liveEdgeMs: 30_000,
          timeShiftSupported: false,
        },
      });
    }
    bridged.jumpToLiveEdge?.(2);
    expect(jumpNative).toHaveBeenCalledWith(2);
    expect(received).toEqual([
      {
        attempt: 1,
        type: 'clock',
        anchor: {
          positionMs: 12_000,
          atMs: 49_900,
          rate: 1,
          liveSeekableStartMs: 0,
          liveEdgeMs: 30_000,
          timeShiftSupported: true,
        },
      },
      {
        attempt: 1,
        type: 'clock',
        anchor: {
          positionMs: 12_000,
          atMs: 49_950,
          rate: 1,
          liveEdgeMs: 30_000,
          timeShiftSupported: false,
        },
      },
    ]);

    // FakePlayerEngine preserves liveSeekableStartMs & timeShiftSupported across pause/play
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://provider.invalid/live/fake.m3u8', { kind: 'live' }));
    await vi.advanceTimersByTimeAsync(300);
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: {
        positionMs: 40_000,
        atMs: Date.now(),
        rate: 1,
        liveSeekableStartMs: 10_000,
        liveEdgeMs: 60_000,
        timeShiftSupported: true,
      },
    });
    service.pause();
    await vi.advanceTimersByTimeAsync(10);
    expect(service.getState().anchor?.liveSeekableStartMs).toBe(10_000);
    expect(service.getState().anchor?.timeShiftSupported).toBe(true);
  });
});

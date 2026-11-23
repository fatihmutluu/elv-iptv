import { ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StreamRequest, StreamVideoInfo } from './index';
import { createPlaybackService } from './service';
import { createFakePlayerEngine } from './testing';
import type { PlaybackState, TuneRequest } from './types';

const req = (url: string): StreamRequest => ({ url, headers: {} });
const tuneReq = (url: string, extra: Partial<TuneRequest> = {}): TuneRequest => ({
  item: `item-${url}`,
  accountKey: 'acc',
  kind: 'live',
  resolve: () => Promise.resolve(ok(req(url))),
  ...extra,
});

function setup() {
  const engine = createFakePlayerEngine({
    scripts: {},
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const service = createPlaybackService({
    engine,
    clock: { now: () => Date.now() },
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    config: { startTimeoutMs: 8000 },
  });
  return { engine, service };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe('PlaybackService mediaInfo handling (#58)', () => {
  it('accepts mediaInfo, merges incremental updates, and deduplicates identical values', async () => {
    const { engine, service } = setup();
    const notifications: Array<StreamVideoInfo | undefined> = [];
    service.subscribe((s: PlaybackState) => notifications.push(s.videoInfo));

    const attempt = service.tune(tuneReq('http://sim/live/1.ts'));
    await vi.advanceTimersByTimeAsync(0);
    notifications.length = 0;

    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080, hdr: 'sdr' },
    });
    expect(service.getState().videoInfo).toEqual({ width: 1920, height: 1080, hdr: 'sdr' });
    expect(notifications).toHaveLength(1);

    // Identical payload does not re-notify subscribers
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080, hdr: 'sdr' },
    });
    expect(notifications).toHaveLength(1);

    // Partial follow-up merges fps, codec, and upgraded HDR cleanly
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { fps: 50, codec: 'hevc', hdr: 'hdr10' },
    });
    expect(service.getState().videoInfo).toEqual({
      width: 1920,
      height: 1080,
      fps: 50,
      codec: 'hevc',
      hdr: 'hdr10',
    });
    expect(notifications).toHaveLength(2);

    // Re-emitting a subset with unchanged values does not notify
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { fps: 50, codec: 'hevc' },
    });
    expect(notifications).toHaveLength(2);
  });

  it('drops stale-token mediaInfo events and ignores invalid empty updates', async () => {
    const { engine, service } = setup();
    const attempt1 = service.tune(tuneReq('http://sim/live/1.ts'));
    await vi.advanceTimersByTimeAsync(0);
    const attempt2 = service.tune(tuneReq('http://sim/live/2.ts'));
    await vi.advanceTimersByTimeAsync(0);

    const beforeDropped = service.getState().staleEventsDropped;
    engine.emit({
      attempt: attempt1,
      type: 'mediaInfo',
      info: { width: 1280, height: 720, codec: 'h264', hdr: 'sdr' },
    });
    expect(service.getState().videoInfo).toBeUndefined();
    expect(service.getState().staleEventsDropped).toBe(beforeDropped + 1);

    // Invalid/non-positive or blank fields produce no state update
    const listener = vi.fn();
    service.subscribe(listener);
    engine.emit({
      attempt: attempt2,
      type: 'mediaInfo',
      info: { width: 0, height: -10, fps: Number.NaN, codec: '   ' },
    });
    expect(service.getState().videoInfo).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();

    // Valid event on active attempt succeeds
    engine.emit({
      attempt: attempt2,
      type: 'mediaInfo',
      info: { width: 3840, height: 2160, fps: 60, codec: ' hevc ', hdr: 'dv' },
    });
    expect(service.getState().videoInfo).toEqual({
      width: 3840,
      height: 2160,
      fps: 60,
      codec: 'hevc',
      hdr: 'dv',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('clears videoInfo to undefined on every new tune() and on stop()', async () => {
    const { engine, service } = setup();
    const attempt1 = service.tune(tuneReq('http://sim/live/1.ts'));
    await vi.advanceTimersByTimeAsync(0);

    engine.emit({
      attempt: attempt1,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080, fps: 25, codec: 'h264', hdr: 'sdr' },
    });
    expect(service.getState().videoInfo?.width).toBe(1920);

    // New tune clears videoInfo immediately
    const attempt2 = service.tune(tuneReq('http://sim/live/2.ts'));
    expect(service.getState().videoInfo).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);

    engine.emit({
      attempt: attempt2,
      type: 'mediaInfo',
      info: { width: 3840, height: 2160, fps: 50, codec: 'hevc', hdr: 'hlg' },
    });
    expect(service.getState().videoInfo?.hdr).toBe('hlg');

    // Stop clears videoInfo and ignores late mediaInfo while idle
    service.stop();
    expect(service.getState().videoInfo).toBeUndefined();
    engine.emit({
      attempt: attempt2,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080 },
    });
    expect(service.getState().videoInfo).toBeUndefined();
  });

  it('preserves, updates, deduplicates, and validates positive finite aspectRatio (#332)', async () => {
    const { engine, service } = setup();
    const notifications: Array<StreamVideoInfo | undefined> = [];
    service.subscribe((s: PlaybackState) => notifications.push(s.videoInfo));

    const attempt = service.tune(tuneReq('http://sim/live/aspect.ts'));
    await vi.advanceTimersByTimeAsync(0);
    notifications.length = 0;

    // Invalid aspectRatio values alone do not create videoInfo
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { aspectRatio: 0 },
    });
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { aspectRatio: -1.77 },
    });
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { aspectRatio: Number.NaN },
    });
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { aspectRatio: Number.POSITIVE_INFINITY },
    });
    expect(service.getState().videoInfo).toBeUndefined();
    expect(notifications).toHaveLength(0);

    // Valid aspectRatio is stored and preserved across partial updates
    const dar16x9 = 16 / 9;
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080, aspectRatio: dar16x9 },
    });
    expect(service.getState().videoInfo).toEqual({
      width: 1920,
      height: 1080,
      aspectRatio: dar16x9,
    });
    expect(notifications).toHaveLength(1);

    // Identical aspectRatio does not re-notify
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { aspectRatio: dar16x9 },
    });
    expect(notifications).toHaveLength(1);

    // Partial update without aspectRatio preserves previous aspectRatio
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { fps: 50 },
    });
    expect(service.getState().videoInfo).toEqual({
      width: 1920,
      height: 1080,
      fps: 50,
      aspectRatio: dar16x9,
    });
    expect(notifications).toHaveLength(2);

    // Changing only aspectRatio notifies subscribers
    engine.emit({
      attempt,
      type: 'mediaInfo',
      info: { aspectRatio: 2.39 },
    });
    expect(service.getState().videoInfo).toEqual({
      width: 1920,
      height: 1080,
      fps: 50,
      aspectRatio: 2.39,
    });
    expect(notifications).toHaveLength(3);
  });
});

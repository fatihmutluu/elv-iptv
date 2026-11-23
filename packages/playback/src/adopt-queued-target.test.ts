import { ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_TRACKS, type StreamRequest } from './engine';
import { createPlaybackService } from './service';
import { createFakePlayerEngine } from './testing';
import type { TuneRequest } from './types';

const streamReq = (url: string): StreamRequest => ({ url, headers: { 'x-a': 'b' } });

const vodReq = (item: string, url: string, extra: Partial<TuneRequest> = {}): TuneRequest => ({
  item,
  accountKey: 'acc-1',
  kind: 'vod',
  resolve: () => Promise.resolve(ok(streamReq(url))),
  ...extra,
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('PlaybackService.adoptQueuedTarget (#205)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
  });

  afterEach(() => vi.useRealTimers());

  it('updates state.item/accountKey, clears stale metadata, preserves attempt for controls, and reloads Ep 2 on retry/replay', async () => {
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
    });

    const attempt1 = service.tune(vodReq('ep:1', 'http://sim.test/ep1.mkv'));
    await flush();

    // Episode 1 becomes playing with chapters, videoInfo, droppedFrames, tracks, and anchor.
    engine.emit({ attempt: attempt1, type: 'state', state: 'playing' });
    engine.emit({
      attempt: attempt1,
      type: 'clock',
      anchor: { positionMs: 2_390_000, atMs: 1_000, rate: 1, durationMs: 2_400_000 },
    });
    engine.emit({
      attempt: attempt1,
      type: 'mediaInfo',
      info: { width: 1920, height: 1080, fps: 24, codec: 'hevc', droppedFrames: 7 },
    });
    engine.emit({
      attempt: attempt1,
      type: 'chapters',
      chapters: [{ id: 'ch:1', title: 'Intro', startMs: 0, endMs: 60_000 }],
    });
    engine.emit({
      attempt: attempt1,
      type: 'tracks',
      tracks: {
        audio: [{ id: 'a:1', language: 'eng' }],
        subtitles: [{ id: 's:1', language: 'eng' }],
        selectedAudioId: 'a:1',
        selectedSubtitleId: 's:1',
      },
    });

    expect(service.getState().item).toBe('ep:1');
    expect(service.getState().chapters).toHaveLength(1);
    expect(service.getState().videoInfo?.width).toBe(1920);
    expect(service.getState().droppedFrames).toBe(7);
    expect(service.getState().tracks.audio).toHaveLength(1);

    // Gapless queue advance to Episode 2
    const ep2Stream = streamReq('http://sim.test/ep2.mkv');
    const loadsBefore = engine.commands.filter((c) => c.name === 'load').length;
    const stopsBefore = engine.commands.filter((c) => c.name === 'stop').length;

    service.adoptQueuedTarget(
      vodReq('ep:2', 'http://sim.test/ep2.mkv', { accountKey: 'acc-2', startMs: 0 }),
      ep2Stream,
    );

    const adopted = service.getState();
    expect(adopted.item).toBe('ep:2');
    expect(adopted.accountKey).toBe('acc-2');
    expect(adopted.attempt).toBe(attempt1);
    expect(adopted.status.kind).toBe('playing');
    expect(adopted.chapters).toBeUndefined();
    expect(adopted.videoInfo).toBeUndefined();
    expect(adopted.droppedFrames).toBeUndefined();
    expect(adopted.anchor).toBeUndefined();
    expect(adopted.tracks).toEqual(EMPTY_TRACKS);
    // Must not issue stop/load on adoption
    expect(engine.commands.filter((c) => c.name === 'load')).toHaveLength(loadsBefore);
    expect(engine.commands.filter((c) => c.name === 'stop')).toHaveLength(stopsBefore);

    // Controls (seek, pause, stop) continue working against the active engine slot
    service.seek(30_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(engine.commands.some((c) => c.name === 'seek' && c.positionMs === 30_000)).toBe(true);

    service.pause();
    const pauseAttempt = service.getState().attempt;
    expect(engine.commands.some((c) => c.name === 'pause' && c.attempt === pauseAttempt)).toBe(
      true,
    );

    // Ending Episode 2 and replaying via play() or retry() reloads Episode 2 (NOT Episode 1!)
    const loadSpy = vi.spyOn(engine, 'load');
    engine.emit({ attempt: pauseAttempt, type: 'state', state: 'ended' });
    expect(service.getState().status.kind).toBe('ended');

    service.play();
    await flush();
    expect(loadSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'http://sim.test/ep2.mkv',
        startMs: 0,
      }),
    );

    // Retry from ended also reloads Episode 2 from 0
    const replayAttempt = service.getState().attempt;
    engine.emit({ attempt: replayAttempt, type: 'state', state: 'ended' });
    service.retry();
    await flush();
    expect(loadSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'http://sim.test/ep2.mkv',
        startMs: 0,
      }),
    );

    // Stop works cleanly after adoption
    service.stop();
    expect(service.getState().status.kind).toBe('idle');
    service.dispose();
  });

  it('reloads Episode 2 on failed -> retry() after adopting queued target without stream', async () => {
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
    });

    const attempt1 = service.tune(vodReq('ep:1', 'http://sim.test/ep1.mkv'));
    await flush();
    engine.emit({ attempt: attempt1, type: 'state', state: 'playing' });

    service.adoptQueuedTarget(vodReq('ep:2', 'http://sim.test/ep2.mkv'));
    expect(service.getState().item).toBe('ep:2');

    // Emit fatal auth failure -> service transitions to failed (loaded = false)
    engine.emit({ attempt: attempt1, type: 'error', error: { code: 'http-403' } });
    expect(service.getState().status.kind).toBe('failed');

    service.retry();
    await flush();
    const lastLoad = engine.commands.filter((c) => c.name === 'load').at(-1);
    expect(lastLoad?.name === 'load' && lastLoad.url).toBe('http://sim.test/ep2.mkv');

    service.dispose();
  });
});

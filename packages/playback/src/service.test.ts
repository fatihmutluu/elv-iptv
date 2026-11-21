import { elvError, err, ok, type Result } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAYBACK_CONFIG } from './config';
import { EMPTY_TRACKS, type MediaTracks, type StreamRequest } from './engine';
import type { RecoveryHooks } from './seam';
import { createPlaybackService, createPlaybackServiceWith } from './service';
import { createFakePlayerEngine, type FakePlayerEngine, type FakeStep } from './testing';
import type { PlaybackService, TuneRequest } from './types';

const req = (url: string): StreamRequest => ({ url, headers: { 'x-a': 'b' } });

interface Deferred {
  promise: Promise<Result<StreamRequest>>;
  settle: (r: Result<StreamRequest>) => void;
}
function deferred(): Deferred {
  let settle!: (r: Result<StreamRequest>) => void;
  const promise = new Promise<Result<StreamRequest>>((res) => {
    settle = res;
  });
  return { promise, settle };
}

function setup(
  hooks?: RecoveryHooks,
  scripts: Record<string, readonly FakeStep[]> = {},
): { engine: FakePlayerEngine; service: PlaybackService } {
  const engine = createFakePlayerEngine({
    scripts,
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const deps = {
    engine,
    clock: { now: () => Date.now() },
    timers: {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    config: { startTimeoutMs: 8000 },
  };
  const service = hooks
    ? createPlaybackServiceWith(deps, () => hooks)
    : createPlaybackService(deps);
  return { engine, service };
}

const tuneReq = (url: string, extra: Partial<TuneRequest> = {}): TuneRequest => ({
  item: `item-${url}`,
  accountKey: 'acc',
  kind: 'live',
  resolve: () => Promise.resolve(ok(req(url))),
  ...extra,
});

const loads = (e: FakePlayerEngine) => e.commands.filter((c) => c.name === 'load');
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe('config', () => {
  it('has the spec defaults', () => {
    expect(DEFAULT_PLAYBACK_CONFIG).toEqual({
      liveStallWindowMs: 4000,
      liveStartTimeoutMs: 5000,
      startTimeoutMs: 8000,
      rungTimeoutMs: 2000,
      ladderGapsMs: [0, 1000, 2000, 4000],
      stableRestoreMs: 30000,
      limitBackoffMs: [2000, 4000, 8000, 15000],
      limitTotalMs: 60000,
      vodReconnectWindowMs: 120000,
      resolveTimeoutMs: 5000,
      seekCoalesceMs: 80,
      seekSettleTimeoutMs: 12000,
      liveStalePauseMs: 20000,
      liveEdgeToleranceMs: 5000,
    });
  });

  it('cannot be changed at run time', () => {
    expect(Object.isFrozen(DEFAULT_PLAYBACK_CONFIG)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PLAYBACK_CONFIG.ladderGapsMs)).toBe(true);
    expect(Object.isFrozen(DEFAULT_PLAYBACK_CONFIG.limitBackoffMs)).toBe(true);
    expect(() => {
      (DEFAULT_PLAYBACK_CONFIG as { startTimeoutMs: number }).startTimeoutMs = 1;
    }).toThrow(TypeError);
  });
});

describe('tune', () => {
  it('returns a new token, sets tuning and tuneAt', () => {
    const { service } = setup();
    expect(service.getState().status).toEqual({ kind: 'idle' });
    const t1 = service.tune(tuneReq('http://a/1'));
    const t2 = service.tune(tuneReq('http://a/2'));
    expect(t2).toBeGreaterThan(t1);
    const s = service.getState();
    expect(s.status).toEqual({ kind: 'tuning' });
    expect(s.attempt).toBe(t2);
    expect(s.tuneAt).toBe(1000);
    expect(s.item).toBe('item-http://a/2');
    expect(s.accountKey).toBe('acc');
  });

  it('sends exactly one load after resolve', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('http://a/1', { startMs: 5, kind: 'vod' }));
    expect(loads(engine)).toHaveLength(0);
    await flush();
    expect(loads(engine)).toEqual([{ name: 'load', attempt: t, url: 'http://a/1' }]);
  });

  it('passes headers, kind and startMs to the engine', async () => {
    const { engine, service } = setup();
    const spy = vi.spyOn(engine, 'load');
    const t = service.tune(tuneReq('http://a/1', { startMs: 5, kind: 'vod' }));
    await flush();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0]).toStrictEqual({
      attempt: t,
      url: 'http://a/1',
      headers: { 'x-a': 'b' },
      kind: 'vod',
      startMs: 5,
    });
  });

  it('omits startMs when not given', async () => {
    const { engine, service } = setup();
    const spy = vi.spyOn(engine, 'load');
    service.tune(tuneReq('http://a/1'));
    await flush();
    expect(spy.mock.calls[0]?.[0]).not.toHaveProperty('startMs');
  });

  it('loads only the newest tune when resolves settle out of order', async () => {
    const { engine, service } = setup();
    const a = deferred();
    const b = deferred();
    const c = deferred();
    service.tune(tuneReq('A', { resolve: () => a.promise }));
    service.tune(tuneReq('B', { resolve: () => b.promise }));
    const tc = service.tune(tuneReq('C', { resolve: () => c.promise }));
    c.settle(ok(req('C')));
    await flush();
    a.settle(ok(req('A')));
    await flush();
    b.settle(ok(req('B')));
    await flush();
    expect(loads(engine)).toEqual([{ name: 'load', attempt: tc, url: 'C' }]);
  });

  it('ignores a failed resolve of a superseded tune', async () => {
    const { service } = setup();
    const a = deferred();
    service.tune(tuneReq('A', { resolve: () => a.promise }));
    service.tune(tuneReq('B', { resolve: () => new Promise(() => {}) }));
    a.settle(err(elvError('network', 'timeout')));
    await flush();
    expect(service.getState().status).toEqual({ kind: 'tuning' });
  });

  it('fails the tune without loading when resolve fails', async () => {
    const { engine, service } = setup();
    service.tune(
      tuneReq('A', { resolve: () => Promise.resolve(err(elvError('auth', 'expired'))) }),
    );
    await flush();
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'auth', code: 'expired' },
    });
    expect(loads(engine)).toHaveLength(0);
  });

  it('fails with network/timeout when resolve does not settle within 5,000 ms', async () => {
    const { engine, service } = setup();
    const late = deferred();
    service.tune(tuneReq('A', { resolve: () => late.promise }));
    await vi.advanceTimersByTimeAsync(4999);
    expect(service.getState().status).toEqual({ kind: 'tuning' });
    await vi.advanceTimersByTimeAsync(1);
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'network', code: 'timeout' },
    });
    late.settle(ok(req('A')));
    await flush();
    expect(loads(engine)).toHaveLength(0);
  });

  it('times only the newest resolve and none after it settled or the tune stopped', async () => {
    const { engine, service } = setup();
    service.tune(tuneReq('A', { resolve: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(3000);
    service.tune(tuneReq('B'));
    await vi.advanceTimersByTimeAsync(10000);
    expect(service.getState().status).toEqual({ kind: 'playing' });
    service.tune(tuneReq('C', { resolve: () => new Promise(() => {}) }));
    service.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(service.getState().status).toEqual({ kind: 'idle' });
    expect(loads(engine).map((c) => c.url)).toEqual(['B']);
  });

  it('fails the tune when resolve rejects', async () => {
    const { engine, service } = setup();
    service.tune(tuneReq('A', { resolve: () => Promise.reject(new Error('boom')) }));
    await flush();
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'network', code: 'resolve-failed' },
    });
    expect(loads(engine)).toHaveLength(0);
  });
});

describe('engine events', () => {
  it('tracks firstFrame, playing and clock anchors', async () => {
    const { service } = setup();
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(300);
    const s = service.getState();
    expect(s.firstFrameAt).toBe(1300);
    await vi.advanceTimersByTimeAsync(0);
    expect(service.getState().status).toEqual({ kind: 'playing' });
  });

  it('keeps tuning on opening, buffering and ready', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    for (const state of ['opening', 'buffering', 'ready'] as const) {
      engine.emit({ attempt: t, type: 'state', state });
      expect(service.getState().status).toEqual({ kind: 'tuning' });
    }
  });

  it('follows paused and ended states', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A', { kind: 'vod' }));
    await flush();
    engine.emit({ attempt: t, type: 'state', state: 'paused' });
    expect(service.getState().status).toEqual({ kind: 'paused' });
    engine.emit({ attempt: t, type: 'state', state: 'playing' });
    expect(service.getState().status).toEqual({ kind: 'playing' });
    engine.emit({ attempt: t, type: 'state', state: 'ended' });
    expect(service.getState().status).toEqual({ kind: 'ended' });
  });

  it('stores the latest clock anchor as sent', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    const anchor = { positionMs: 10, atMs: 5, rate: 1, durationMs: 100 };
    engine.emit({ attempt: t, type: 'clock', anchor });
    expect(service.getState().anchor).toEqual(anchor);
  });

  it('drops events with an older token and counts them', async () => {
    const { engine, service } = setup();
    const t1 = service.tune(tuneReq('A'));
    const t2 = service.tune(tuneReq('B'));
    await flush();
    engine.emit({ attempt: t1, type: 'state', state: 'playing' });
    engine.emit({ attempt: t1, type: 'error', error: { code: 'network' } });
    const s = service.getState();
    expect(s.attempt).toBe(t2);
    expect(s.status).toEqual({ kind: 'tuning' });
    expect(s.staleEventsDropped).toBe(2);
  });

  it('does not notify subscribers for dropped events', async () => {
    const { engine, service } = setup();
    const t1 = service.tune(tuneReq('A'));
    service.tune(tuneReq('B'));
    await flush();
    const listener = vi.fn();
    service.subscribe(listener);
    engine.emit({ attempt: t1, type: 'state', state: 'playing' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('ignores surface events and events after idle or failure', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    engine.surface('destroyed');
    expect(service.getState().status).toEqual({ kind: 'tuning' });
    service.stop();
    engine.emit({ attempt: t, type: 'state', state: 'playing' });
    expect(service.getState().status).toEqual({ kind: 'idle' });
  });
});

describe('failures', () => {
  it('a terminal engine error fails with the playback error and stops', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    engine.emit({ attempt: t, type: 'error', error: { code: 'http-401', detail: 'x' } });
    expect(service.getState().status).toEqual({
      kind: 'failed',
      error: { category: 'playback', code: 'http-401', detail: 'x' },
    });
    expect(engine.commands.at(-1)).toEqual({ name: 'stop', attempt: t });
  });

  it('the start timeout reaches the recovery 8,000 ms after the load', async () => {
    let fired = 0;
    const onStartTimeout = () => {
      fired += 1;
    };
    const { service } = setup({ onStartTimeout }, { silent: [] });
    service.tune(tuneReq('silent'));
    await vi.advanceTimersByTimeAsync(7999);
    expect(fired).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toBe(1);
    expect(service.getState().status).toEqual({ kind: 'tuning' });
  });

  it('playing cancels the start timeout', async () => {
    const { service } = setup();
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(service.getState().status).toEqual({ kind: 'playing' });
  });

  it('a new tune cancels the pending start timeout', async () => {
    const { service: s } = setup(undefined, { silent: [] });
    s.tune(tuneReq('silent'));
    await vi.advanceTimersByTimeAsync(5000);
    s.tune(tuneReq('other'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(s.getState().status).toEqual({ kind: 'playing' });
    expect(s.getState().attempt).toBe(2);
  });
});

describe('commands', () => {
  it('stop sends stop with the current token and sets idle', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    service.stop();
    expect(engine.commands.at(-1)).toEqual({ name: 'stop', attempt: t });
    expect(service.getState().status).toEqual({ kind: 'idle' });
  });

  it('stop during resolve prevents the load', async () => {
    const { engine, service } = setup();
    const d = deferred();
    service.tune(tuneReq('A', { resolve: () => d.promise }));
    service.stop();
    d.settle(ok(req('A')));
    await flush();
    expect(loads(engine)).toHaveLength(0);
  });

  it('stop while idle is a no-op', () => {
    const { engine, service } = setup();
    service.stop();
    expect(engine.commands).toHaveLength(0);
  });

  it('pause and play advance the attempt token and seek uses the current one', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    service.pause();
    service.play();
    service.seek(4200);
    expect(engine.commands.slice(-3)).toEqual([
      { name: 'pause', attempt: t + 1 },
      { name: 'play', attempt: t + 2 },
      { name: 'seek', attempt: t + 2, positionMs: 4200 },
    ]);
  });

  it('pause, play and seek do nothing while nothing is loaded', () => {
    const { engine, service } = setup();
    service.pause();
    service.play();
    service.seek(1);
    service.retry();
    expect(engine.commands).toHaveLength(0);
  });

  it('retry on loaded media takes a new token and re-arms the start timeout', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(300);
    service.retry();
    const s = service.getState();
    expect(s.attempt).toBe(t + 1);
    expect(s.status).toEqual({ kind: 'tuning' });
    expect(engine.commands.at(-1)).toEqual({ name: 'retry', attempt: t + 1 });
  });

  it('retry after a failure tunes the last request again', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    engine.emit({ attempt: t, type: 'error', error: { code: 'http-401' } });
    service.retry();
    await flush();
    expect(service.getState().attempt).toBe(t + 1);
    expect(loads(engine).map((c) => c.attempt)).toEqual([t, t + 1]);
  });
});

describe('zap window', () => {
  it('pause, seek and retry during the resolve of a zap do not reach the old media', async () => {
    const { engine, service } = setup();
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(400);
    const d = deferred();
    service.tune(tuneReq('B', { resolve: () => d.promise }));
    const before = engine.commands.length;
    service.pause();
    service.play();
    service.seek(10);
    service.retry();
    const names = engine.commands.slice(before).map((c) => c.name);
    expect(names).not.toContain('pause');
    expect(names).not.toContain('play');
    expect(names).not.toContain('seek');
    expect(names).not.toContain('retry');
    expect(service.getState().item).toBe('item-B');
  });

  it('B still loads after a pause during its resolve', async () => {
    const { engine, service } = setup();
    service.tune(tuneReq('A'));
    await vi.advanceTimersByTimeAsync(400);
    const d = deferred();
    const tb = service.tune(tuneReq('B', { resolve: () => d.promise }));
    service.pause();
    d.settle(ok(req('B')));
    await flush();
    expect(loads(engine).map((c) => c.url)).toEqual(['A', 'B']);
    expect(loads(engine).at(-1)?.attempt).toBe(tb);
  });
});

const SAMPLE_TRACKS: MediaTracks = {
  audio: [
    { id: 'a:0', language: 'tur', label: 'Turkish' },
    { id: 'a:1', language: 'eng', label: 'English' },
  ],
  subtitles: [{ id: 's:0', language: 'tur', label: 'Turkish' }],
  selectedAudioId: 'a:0',
  selectedSubtitleId: 's:0',
};

describe('tracks and seek', () => {
  it('exposes frozen EMPTY_TRACKS initially, updates on tracks events, and resets on tune and stop', async () => {
    expect(Object.isFrozen(EMPTY_TRACKS)).toBe(true);
    expect(Object.isFrozen(EMPTY_TRACKS.audio)).toBe(true);
    expect(Object.isFrozen(EMPTY_TRACKS.subtitles)).toBe(true);
    const { engine, service } = setup();
    expect(service.getState().tracks).toBe(EMPTY_TRACKS);
    const t1 = service.tune(tuneReq('A'));
    await flush();
    engine.emit({ attempt: t1, type: 'tracks', tracks: SAMPLE_TRACKS });
    expect(service.getState().tracks).toEqual(SAMPLE_TRACKS);
    const t2 = service.tune(tuneReq('B'));
    expect(service.getState().tracks).toBe(EMPTY_TRACKS);
    await flush();
    engine.emit({ attempt: t1, type: 'tracks', tracks: SAMPLE_TRACKS });
    expect(service.getState().tracks).toBe(EMPTY_TRACKS);
    expect(service.getState().staleEventsDropped).toBe(1);
    engine.emit({ attempt: t2, type: 'tracks', tracks: SAMPLE_TRACKS });
    expect(service.getState().tracks).toEqual(SAMPLE_TRACKS);
    service.stop();
    expect(service.getState().tracks).toBe(EMPTY_TRACKS);
  });

  it('forwards track selections with state.attempt and re-applies once after reload if needed', async () => {
    const { engine, service } = setup();
    service.selectAudioTrack('a:1');
    service.selectSubtitleTrack(null);
    expect(engine.commands).toHaveLength(0);
    const t = service.tune(tuneReq('A'));
    await flush();
    engine.emit({ attempt: t, type: 'tracks', tracks: SAMPLE_TRACKS });
    service.selectAudioTrack('a:1');
    service.selectSubtitleTrack(null);
    expect(engine.commands.slice(-2)).toEqual([
      { name: 'selectAudioTrack', attempt: t, trackId: 'a:1' },
      { name: 'selectSubtitleTrack', attempt: t, trackId: null },
    ]);
    service.retry();
    const retryToken = service.getState().attempt;
    engine.emit({ attempt: retryToken, type: 'tracks', tracks: SAMPLE_TRACKS });
    engine.emit({ attempt: retryToken, type: 'tracks', tracks: SAMPLE_TRACKS });
    expect(engine.commands.slice(-2)).toEqual([
      { name: 'selectAudioTrack', attempt: retryToken, trackId: 'a:1' },
      { name: 'selectSubtitleTrack', attempt: retryToken, trackId: null },
    ]);
  });

  it('does not clobber engine-reconciled language when track IDs reorder on reload (Repro A)', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('A'));
    await flush();
    engine.emit({
      attempt: t,
      type: 'tracks',
      tracks: {
        audio: [
          { id: 'a:1', language: 'tur', label: 'Turkish' },
          { id: 'a:2', language: 'eng', label: 'English' },
        ],
        subtitles: [
          { id: 's:1', language: 'tur', label: 'Turkish' },
          { id: 's:2', language: 'eng', label: 'English' },
        ],
        selectedAudioId: 'a:1',
        selectedSubtitleId: null,
      },
    });
    service.selectAudioTrack('a:2');
    service.selectSubtitleTrack('s:2');

    service.retry();
    const reload1 = service.getState().attempt;
    const mark = engine.commands.length;
    // Reload #1 reorders tracks: English is now a:1 / s:1 (already selected by native engine), while a:2 / s:2 is Turkish
    engine.emit({
      attempt: reload1,
      type: 'tracks',
      tracks: {
        audio: [
          { id: 'a:1', language: 'eng', label: 'English' },
          { id: 'a:2', language: 'tur', label: 'Turkish' },
        ],
        subtitles: [
          { id: 's:1', language: 'eng', label: 'English' },
          { id: 's:2', language: 'tur', label: 'Turkish' },
        ],
        selectedAudioId: 'a:1',
        selectedSubtitleId: 's:1',
      },
    });
    expect(engine.commands.slice(mark)).toEqual([]);

    // Reload #2 reorders back to a:2 / s:2 for English while engine defaulted to Turkish a:1 / s:1
    service.retry();
    const reload2 = service.getState().attempt;
    engine.emit({
      attempt: reload2,
      type: 'tracks',
      tracks: {
        audio: [
          { id: 'a:1', language: 'tur', label: 'Turkish' },
          { id: 'a:2', language: 'eng', label: 'English' },
        ],
        subtitles: [
          { id: 's:1', language: 'tur', label: 'Turkish' },
          { id: 's:2', language: 'eng', label: 'English' },
        ],
        selectedAudioId: 'a:1',
        selectedSubtitleId: 's:1',
      },
    });
    expect(engine.commands.slice(-2)).toEqual([
      { name: 'selectAudioTrack', attempt: reload2, trackId: 'a:2' },
      { name: 'selectSubtitleTrack', attempt: reload2, trackId: 's:2' },
    ]);
  });

  it('updates LoadOptions IDs and preserves language/label across consecutive reloads (Repro B)', async () => {
    const { engine, service } = setup();
    const loadSpy = vi.spyOn(engine, 'load');
    const t = service.tune(tuneReq('movie', { kind: 'vod' }));
    await flush();
    // Select before initial tracks arrives to verify metadata backfill
    service.selectAudioTrack('1:1');
    service.selectSubtitleTrack('2:1');
    await vi.advanceTimersByTimeAsync(300);
    engine.emit({
      attempt: t,
      type: 'tracks',
      tracks: {
        audio: [
          { id: '1:0', language: 'tur', label: 'Turkish' },
          { id: '1:1', language: 'eng', label: 'English' },
        ],
        subtitles: [
          { id: '2:0', language: 'tur', label: 'Turkish' },
          { id: '2:1', language: 'eng', label: 'English' },
        ],
        selectedAudioId: '1:1',
        selectedSubtitleId: '2:1',
      },
    });

    // Reload #1: group IDs shift so English becomes 3:1 / 4:1
    engine.emit({ attempt: t, type: 'error', error: { code: 'network' } });
    await vi.advanceTimersByTimeAsync(2000);
    expect(loadSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ options: { audioTrackId: '1:1', subtitleTrackId: '2:1' } }),
    );
    await vi.advanceTimersByTimeAsync(300);
    const r1 = service.getState().attempt;
    engine.emit({
      attempt: r1,
      type: 'tracks',
      tracks: {
        audio: [
          { id: '3:0', language: 'tur', label: 'Turkish' },
          { id: '3:1', language: 'eng', label: 'English' },
        ],
        subtitles: [
          { id: '4:0', language: 'tur', label: 'Turkish' },
          { id: '4:1', language: 'eng', label: 'English' },
        ],
        selectedAudioId: '3:1',
        selectedSubtitleId: '4:1',
      },
    });

    // Reload #2 (second reconnectVod step waits 4,000 ms): LoadOptions must carry resolved 3:1 / 4:1
    engine.emit({ attempt: r1, type: 'error', error: { code: 'network' } });
    await vi.advanceTimersByTimeAsync(4000);
    expect(loadSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ options: { audioTrackId: '3:1', subtitleTrackId: '4:1' } }),
    );
    const r2 = service.getState().attempt;
    engine.emit({
      attempt: r2,
      type: 'tracks',
      tracks: {
        audio: [
          { id: '5:0', language: 'tur', label: 'Turkish' },
          { id: '5:1', language: 'eng', label: 'English' },
        ],
        subtitles: [
          { id: '6:0', language: 'tur', label: 'Turkish' },
          { id: '6:1', language: 'eng', label: 'English' },
        ],
        selectedAudioId: '5:0',
        selectedSubtitleId: '6:0',
      },
    });
    expect(engine.commands.slice(-2)).toEqual([
      { name: 'selectAudioTrack', attempt: r2, trackId: '5:1' },
      { name: 'selectSubtitleTrack', attempt: r2, trackId: '6:1' },
    ]);
  });

  it('reloads ended VOD at clamped target on seek() while retry() without seek restarts from 0', async () => {
    const { engine, service } = setup();
    const loadSpy = vi.spyOn(engine, 'load');
    const t = service.tune(tuneReq('movie', { kind: 'vod' }));
    await vi.advanceTimersByTimeAsync(300);
    engine.emit({ attempt: t, type: 'tracks', tracks: SAMPLE_TRACKS });
    service.selectAudioTrack('a:1');
    service.selectSubtitleTrack(null);
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 120_000, atMs: Date.now(), rate: 1, durationMs: 120_000 },
    });
    engine.emit({ attempt: t, type: 'state', state: 'ended' });
    expect(service.getState().status).toEqual({ kind: 'ended' });

    service.seek(45_000);
    expect(service.getState().status).toEqual({ kind: 'tuning' });
    expect(engine.commands.at(-1)?.name).toBe('load');
    expect(loadSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'movie',
        kind: 'vod',
        startMs: 45_000,
        options: { audioTrackId: 'a:1', subtitleTrackId: null },
      }),
    );
    await vi.advanceTimersByTimeAsync(300);
    expect(service.getState().status).toEqual({ kind: 'playing' });

    engine.emit({ attempt: service.getState().attempt, type: 'state', state: 'ended' });
    service.retry();
    await flush();
    expect(loadSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({
        url: 'movie',
        kind: 'vod',
        startMs: 0,
        options: { audioTrackId: 'a:1', subtitleTrackId: null },
      }),
    );
  });

  it('clamps seek to [0, durationMs] and updates state.anchor immediately', async () => {
    const { engine, service } = setup();
    const t = service.tune(tuneReq('movie', { kind: 'vod' }));
    await vi.advanceTimersByTimeAsync(300);
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 10_000, atMs: Date.now(), rate: 1, durationMs: 100_000 },
    });
    service.seek(150_000);
    expect(service.getState().anchor).toEqual({
      positionMs: 100_000,
      atMs: Date.now(),
      rate: 1,
      durationMs: 100_000,
    });
    expect(engine.commands.at(-1)).toEqual({ name: 'seek', attempt: t, positionMs: 100_000 });
    service.seek(-500);
    expect(service.getState().anchor?.positionMs).toBe(0);
    service.seek(Number.NaN);
    await vi.advanceTimersByTimeAsync(100);
    expect(engine.commands.at(-1)).toEqual({ name: 'seek', attempt: t, positionMs: 0 });
  });

  it('coalesces setSpeed across active seeks, clamps [0.25, 4.0], and resets on tune/stop/dispose', async () => {
    const { engine, service } = setup();
    const speeds: Array<{ attempt: number; rate: number }> = [];
    engine.setSpeed = (attempt, rate) => speeds.push({ attempt, rate });

    service.setSpeed(1.5);
    expect(speeds).toEqual([]);

    const t = service.tune(tuneReq('movie', { kind: 'vod' }));
    await vi.advanceTimersByTimeAsync(300);

    service.seek(30_000);
    service.setSpeed(1.25);
    service.setSpeed(1.5);
    service.setSpeed(9);
    service.setSpeed(Number.NaN);
    expect(speeds).toEqual([]);

    // Seek window clears after 80ms; clock confirms seek at 30_000 -> flushes latest clamped rate (4.0)
    await vi.advanceTimersByTimeAsync(80);
    expect(speeds).toEqual([]);
    engine.emit({
      attempt: t,
      type: 'clock',
      anchor: { positionMs: 30_000, atMs: Date.now(), rate: 1 },
    });
    expect(speeds).toEqual([{ attempt: t, rate: 4.0 }]);

    // Pending speed during seek is cancelled cleanly on stop(), tune(), and dispose()
    await vi.advanceTimersByTimeAsync(100);
    service.seek(45_000);
    service.setSpeed(0.1);
    service.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(speeds).toEqual([{ attempt: t, rate: 4.0 }]);

    const t2 = service.tune(tuneReq('movie2', { kind: 'vod' }));
    await vi.advanceTimersByTimeAsync(300);
    service.setSpeed(0.1);
    expect(speeds).toEqual([
      { attempt: t, rate: 4.0 },
      { attempt: t2, rate: 0.25 },
    ]);

    service.seek(10_000);
    service.setSpeed(2.0);
    service.tune(tuneReq('movie3', { kind: 'vod' }));
    await vi.advanceTimersByTimeAsync(500);
    expect(speeds).toHaveLength(2);

    service.seek(5_000);
    service.setSpeed(1.75);
    service.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(speeds).toHaveLength(2);
  });
});

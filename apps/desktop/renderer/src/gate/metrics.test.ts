import { type PlaybackState, toPlaybackError } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import { createPlayerRecorder, playerLine } from './metrics.ts';
import type { GateFault } from './params.ts';

type Status = PlaybackState['status'];

function make(fault: GateFault = '') {
  const recorder = createPlayerRecorder({ fault, faultItem: 'a' });
  let attempt = 0;
  let state: PlaybackState = { status: { kind: 'idle' }, attempt: 0, staleEventsDropped: 0 };
  const show = (patch: Partial<PlaybackState>) => {
    state = { ...state, ...patch };
    recorder.observe(state);
  };
  return {
    recorder,
    get state() {
      return state;
    },
    /** What a `service.tune` does: the recorder is told, then the service notifies. */
    tune(item: string, at: number, zapAt?: number) {
      recorder.dispatch(item, zapAt);
      attempt += 1;
      const { firstFrameAt: _f, ...rest } = state;
      state = { ...rest, status: { kind: 'tuning' }, attempt, item, tuneAt: at };
      recorder.observe(state);
    },
    status(status: Status) {
      show({ status });
    },
    frame(at: number) {
      show({ firstFrameAt: at });
    },
    show,
  };
}

describe('createPlayerRecorder', () => {
  it('measures cold, warm and zap spans from the tune and the dispatch', () => {
    const h = make();
    h.tune('a', 100);
    h.frame(900);
    h.status({ kind: 'playing' });
    h.tune('b', 2000, 1990);
    h.frame(2400);
    h.tune('c', 4000, 3980);
    h.frame(4700);
    const m = h.recorder.finish(h.state);
    expect(m.ttffColdMs).toBe(800);
    expect(m.ttffWarmMs).toEqual({ p50: 400, p95: 700 });
    expect(m.zapMs).toEqual({ p50: 410, p95: 720, max: 720 });
    expect(m.zaps).toBe(2);
    expect(m.fault).toBe('');
    expect(m.faultOutcome).toBeNull();
  });

  it('counts only the first frame of a tune', () => {
    const h = make();
    h.tune('a', 0);
    h.frame(500);
    h.frame(9000);
    h.tune('b', 10_000, 10_000);
    h.frame(10_300);
    h.frame(20_000);
    const m = h.recorder.finish(h.state);
    expect(m.ttffColdMs).toBe(500);
    expect(m.ttffWarmMs.p50).toBe(300);
  });

  it('reports null for what was never measured', () => {
    const h = make();
    h.tune('a', 0);
    const m = h.recorder.finish(h.state);
    expect(m.ttffColdMs).toBeNull();
    expect(m.ttffWarmMs).toEqual({ p50: null, p95: null });
    expect(m.zapMs).toEqual({ p50: null, p95: null, max: null });
  });

  it('ignores states before the first dispatch', () => {
    const h = make();
    h.status({ kind: 'idle' });
    expect(h.recorder.finish(h.state).staleEventsApplied).toBe(0);
  });

  it('counts a state that shows another channel or an older attempt as a stale event applied', () => {
    const h = make();
    h.tune('a', 0);
    h.show({ item: 'z' });
    h.show({ item: 'a', attempt: 0 });
    const m = h.recorder.finish({ ...h.state, staleEventsDropped: 3 });
    expect(m.staleEventsApplied).toBe(2);
    expect(m.staleEventsDropped).toBe(3);
  });

  it('counts surface creations only', () => {
    const h = make();
    h.recorder.surface('created');
    h.recorder.surface('destroyed');
    expect(h.recorder.finish(h.state).surfaceCreated).toBe(1);
  });

  it('counts failures once per tune and each recovery rung entry', () => {
    const h = make();
    h.tune('a', 0);
    h.status({ kind: 'recovering', rung: 1, nextAtMs: 5 });
    h.status({ kind: 'recovering', rung: 1, nextAtMs: 5 });
    h.status({ kind: 'recovering', rung: 2, nextAtMs: 9 });
    h.status({ kind: 'failed', error: toPlaybackError({ code: 'http-404' }) });
    h.status({ kind: 'failed', error: toPlaybackError({ code: 'http-404' }) });
    h.tune('b', 10);
    h.status({ kind: 'recovering', rung: 1, nextAtMs: 5 });
    const m = h.recorder.finish(h.state);
    expect(m.failures).toBe(1);
    expect(m.recoveries).toEqual({ '1': 2, '2': 1, '3': 0, '4': 0 });
  });

  it('judges a drop run recovered when playing resumes after a rung', () => {
    const h = make('drop5');
    h.tune('a', 0);
    h.frame(300);
    h.status({ kind: 'playing' });
    h.status({ kind: 'recovering', rung: 1, nextAtMs: 6000 });
    h.status({ kind: 'playing' });
    h.tune('b', 7000, 7000);
    expect(h.recorder.finish(h.state).faultOutcome).toBe('recovered');
  });

  it('judges a 404 run failed-in-time and a 509 run limited-backoff at the end of the run', () => {
    const f = make('404');
    f.tune('a', 0);
    f.status({ kind: 'failed', error: toPlaybackError({ code: 'http-404' }) });
    expect(f.recorder.finish(f.state).faultOutcome).toBe('failed-in-time');
    const l = make('509');
    l.tune('a', 0);
    l.status({ kind: 'limited', nextAtMs: 2000 });
    expect(l.recorder.finish(l.state).faultOutcome).toBe('limited-backoff');
  });

  it('judges a fault the service never reacted to as missed, and only the first dwell counts', () => {
    const h = make('404');
    h.tune('a', 0);
    h.frame(300);
    h.status({ kind: 'playing' });
    h.tune('b', 3000, 3000);
    h.tune('a', 6000, 6000);
    h.status({ kind: 'failed', error: toPlaybackError({ code: 'http-404' }) });
    const m = h.recorder.finish(h.state);
    expect(m.faultOutcome).toBe('missed');
    expect(m.failures).toBe(1);
  });

  it('reports missed when the faulted channel was never tuned', () => {
    const h = make('509');
    h.tune('b', 0);
    expect(h.recorder.finish(h.state).faultOutcome).toBe('missed');
  });

  it('judges a notice run limited-backoff', () => {
    const h = make('notice');
    h.tune('a', 0);
    h.status({ kind: 'limited', nextAtMs: 2000 });
    expect(h.recorder.finish(h.state).faultOutcome).toBe('limited-backoff');
  });

  it('counts engine-wedged errors the engine reported', () => {
    const h = make();
    h.recorder.engineError('engine-wedged');
    h.recorder.engineError('network');
    h.recorder.engineError('engine-wedged');
    expect(h.recorder.finish(h.state).engineWedged).toBe(2);
  });

  it('carries the vod result, null without a vod part', () => {
    const h = make();
    expect(h.recorder.finish(h.state).vod).toBeNull();
    expect(h.recorder.finish(h.state, { playing: true, seeked: false }).vod).toEqual({
      playing: true,
      seeked: false,
    });
  });

  it('formats the line', () => {
    const h = make();
    const m = h.recorder.finish(h.state);
    expect(playerLine(m)).toBe(`ELV_GATE_PLAYER ${JSON.stringify(m)}`);
  });
});

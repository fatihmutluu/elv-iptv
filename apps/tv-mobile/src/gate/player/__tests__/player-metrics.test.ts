import { elvError } from '@elv/domain';
import { EMPTY_TRACKS, type PlaybackState } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import { createPlayerRecorder, playerLine } from '../player-metrics';
import type { PlayerFault } from '../player-routes';

type Status = PlaybackState['status'];

function make(fault: PlayerFault = '', soak?: number) {
  let now = 0;
  const recorder = createPlayerRecorder({ fault, faultItem: 'a', soak, now: () => now });
  let attempt = 0;
  let state: PlaybackState = {
    status: { kind: 'idle' },
    attempt: 0,
    tracks: EMPTY_TRACKS,
    staleEventsDropped: 0,
  };
  const show = (patch: Partial<PlaybackState>) => {
    state = { ...state, ...patch };
    recorder.observe(state);
  };
  return {
    recorder,
    get state() {
      return state;
    },
    /** Moves the recorder's clock to `ms`. */
    at(ms: number) {
      now = ms;
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
    h.status({ kind: 'failed', error: elvError('playback', 'http-404') });
    h.status({ kind: 'failed', error: elvError('playback', 'http-404') });
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

  it('judges a drop run recovered when the engine ends its stall while the service plays (rung 0)', () => {
    const h = make('drop5');
    h.tune('a', 0);
    h.frame(300);
    h.status({ kind: 'playing' });
    h.recorder.stall('start');
    h.recorder.stall('end');
    h.tune('b', 10_000, 10_000);
    expect(h.recorder.finish(h.state).faultOutcome).toBe('recovered');
  });

  it('does not count a stall that a rung ended, nor a stall end without a start', () => {
    const r = make('drop5');
    r.tune('a', 0);
    r.frame(300);
    r.status({ kind: 'playing' });
    r.recorder.stall('start');
    r.status({ kind: 'recovering', rung: 1, nextAtMs: 6000 });
    r.recorder.stall('end');
    r.tune('b', 10_000, 10_000);
    expect(r.recorder.finish(r.state).faultOutcome).toBe('missed');
    const e = make('drop5');
    e.tune('a', 0);
    e.status({ kind: 'playing' });
    e.recorder.stall('end');
    expect(e.recorder.finish(e.state).faultOutcome).toBe('missed');
  });

  it('judges a 404 run failed-in-time and a 509 run limited-backoff at the end of the run', () => {
    const f = make('404');
    f.tune('a', 0);
    f.status({ kind: 'failed', error: elvError('playback', 'http-404') });
    expect(f.recorder.finish(f.state).faultOutcome).toBe('failed-in-time');
    const l = make('509');
    l.tune('a', 0);
    l.status({ kind: 'limited', nextAtMs: 2000 });
    expect(l.recorder.finish(l.state).faultOutcome).toBe('limited-backoff');
  });

  it('reports limitedAfterMs from the faulted tune to its first limited state', () => {
    const l = make('509');
    l.tune('a', 100);
    l.at(240);
    l.status({ kind: 'limited', nextAtMs: 2240 });
    l.at(2300);
    l.status({ kind: 'tuning' });
    l.at(2310);
    l.status({ kind: 'limited', nextAtMs: 6310 });
    expect(l.recorder.finish(l.state).limitedAfterMs).toBe(140);
  });

  it('reports limitedAfterMs null without a fault, without limited, or off the faulted channel', () => {
    const none = make();
    none.tune('a', 0);
    none.status({ kind: 'limited', nextAtMs: 2000 });
    expect(none.recorder.finish(none.state).limitedAfterMs).toBeNull();
    const failed = make('404');
    failed.tune('a', 0);
    failed.status({ kind: 'failed', error: elvError('playback', 'http-404') });
    expect(failed.recorder.finish(failed.state).limitedAfterMs).toBeNull();
    const other = make('509');
    other.tune('b', 0);
    other.at(50);
    other.status({ kind: 'limited', nextAtMs: 2050 });
    expect(other.recorder.finish(other.state).limitedAfterMs).toBeNull();
  });

  it('judges a fault the service never reacted to as missed, and only the first dwell counts', () => {
    const h = make('404');
    h.tune('a', 0);
    h.frame(300);
    h.status({ kind: 'playing' });
    h.tune('b', 3000, 3000);
    h.tune('a', 6000, 6000);
    h.status({ kind: 'failed', error: elvError('playback', 'http-404') });
    const m = h.recorder.finish(h.state);
    expect(m.faultOutcome).toBe('missed');
    expect(m.failures).toBe(1);
  });

  it('judges a run that zapped away before the faulted channel played as left', () => {
    const s = make('slowstart');
    s.tune('a', 0);
    s.tune('b', 800, 800);
    s.frame(1500);
    s.status({ kind: 'playing' });
    const m = s.recorder.finish(s.state);
    expect(m.faultOutcome).toBe('left');
    expect(m.zapMs.max).toBe(700);
    const stayed = make('slowstart');
    stayed.tune('a', 0);
    expect(stayed.recorder.finish(stayed.state).faultOutcome).toBe('missed');
    const played = make('slowstart');
    played.tune('a', 0);
    played.status({ kind: 'playing' });
    played.tune('b', 800, 800);
    expect(played.recorder.finish(played.state).faultOutcome).toBe('missed');
  });

  it('reports missed when the faulted channel was never tuned', () => {
    const h = make('509');
    h.tune('b', 0);
    expect(h.recorder.finish(h.state).faultOutcome).toBe('missed');
  });

  it('formats the line', () => {
    const h = make();
    const m = h.recorder.finish(h.state);
    expect(playerLine(m)).toBe(`ELV_GATE_PLAYER ${JSON.stringify(m)}`);
  });

  it('reports the final status kind and no soak block in a normal run', () => {
    const h = make();
    h.tune('a', 0);
    expect(h.recorder.finish(h.state)).toMatchObject({ final: 'other', soak: null });
    h.status({ kind: 'playing' });
    expect(h.recorder.finish(h.state).final).toBe('playing');
    h.status({ kind: 'limited', nextAtMs: 2000 });
    expect(h.recorder.finish(h.state).final).toBe('limited');
    h.status({ kind: 'failed', error: elvError('playback', 'http-404') });
    expect(h.recorder.finish(h.state).final).toBe('failed');
    h.status({ kind: 'recovering', rung: 1, nextAtMs: 5 });
    expect(h.recorder.finish(h.state).final).toBe('other');
    h.status({ kind: 'ended' });
    expect(h.recorder.finish(h.state).final).toBe('other');
  });
});

describe('soak metrics', () => {
  it('measures a live soak from the first frame to the print', () => {
    const h = make('', 1);
    h.tune('a', 0);
    h.at(100);
    h.recorder.stall('start');
    h.at(200);
    h.recorder.stall('end');
    h.frame(500);
    h.status({ kind: 'playing' });
    h.show({ anchor: { positionMs: 10_000, atMs: 700, rate: 1 } });
    h.at(10_000);
    h.recorder.stall('start');
    h.at(11_500);
    h.recorder.stall('end');
    h.recorder.stall('end');
    h.at(50_000);
    h.recorder.stall('start');
    h.show({ anchor: { positionMs: 69_400, atMs: 60_000, rate: 1 } });
    h.at(60_500.256);
    const m = h.recorder.finish(h.state);
    expect(m.final).toBe('playing');
    expect(m.zaps).toBe(0);
    expect(m.soak).toEqual({
      minutes: 1,
      playedMs: 60_000.26,
      positionAdvancedMs: 60_100.26,
      stalls: 2,
      longestStallMs: 10_500.26,
      ended: false,
      durationMs: null,
    });
  });

  it('takes the first anchor seen after the first frame', () => {
    const h = make('', 5);
    h.tune('a', 0);
    h.show({ anchor: { positionMs: 0, atMs: 100, rate: 1 } });
    h.frame(500);
    h.show({ anchor: { positionMs: 5000, atMs: 600, rate: 1 } });
    h.show({ anchor: { positionMs: 9000, atMs: 4600, rate: 1 } });
    h.at(5000);
    expect(h.recorder.finish(h.state).soak?.positionAdvancedMs).toBe(9400 - 4900);
  });

  it('reports zeros for a soak without a frame or an anchor', () => {
    const h = make('', 3);
    h.tune('a', 0);
    h.recorder.stall('start');
    h.status({ kind: 'failed', error: elvError('playback', 'http-404') });
    h.at(4000);
    const m = h.recorder.finish(h.state);
    expect(m.final).toBe('failed');
    expect(m.soak).toEqual({
      minutes: 3,
      playedMs: 0,
      positionAdvancedMs: 0,
      stalls: 0,
      longestStallMs: 0,
      ended: false,
      durationMs: null,
    });
  });

  it('records the end and the duration of a VOD soak', () => {
    const h = make('', 2);
    h.tune('a', 0);
    h.frame(300);
    h.status({ kind: 'playing' });
    h.show({ anchor: { positionMs: 0, atMs: 300, rate: 1, durationMs: 60_000 } });
    h.at(60_300);
    h.show({
      status: { kind: 'ended' },
      anchor: { positionMs: 60_000, atMs: 60_300, rate: 0, durationMs: 60_000 },
    });
    h.at(61_000);
    const m = h.recorder.finish(h.state);
    expect(m.final).toBe('other');
    expect(m.soak).toMatchObject({
      minutes: 2,
      playedMs: 60_700,
      positionAdvancedMs: 60_000,
      ended: true,
      durationMs: 60_000,
    });
  });
});

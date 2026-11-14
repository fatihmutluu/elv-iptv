import type { EngineEvent } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import { createDeriver, type Deriver } from './derive.ts';

function setup(kind: 'live' | 'vod' = 'live') {
  const clock = { t: 1000 };
  const d: Deriver = createDeriver({ now: () => clock.t, clockIntervalMs: 1000 });
  const begin = d.begin(7, kind);
  return { d, clock, begin };
}
const states = (e: EngineEvent[]) => e.flatMap((x) => (x.type === 'state' ? [x.state] : []));
const types = (e: EngineEvent[]) => e.map((x) => x.type);
const clocks = (e: EngineEvent[]) => e.flatMap((x) => (x.type === 'clock' ? [x.anchor] : []));
const restart = (d: Deriver) => d.fileEvent({ event: 'playback-restart' });

function play(s: ReturnType<typeof setup>) {
  s.d.fileEvent({ event: 'file-loaded' });
  s.d.property('pause', false);
  s.d.property('video-params', { w: 1280 });
  s.d.property('time-pos', 0);
  return restart(s.d);
}

describe('deriver', () => {
  it('opening, buffering, playing in order and never ready', () => {
    const s = setup();
    const all = [
      ...s.begin,
      ...s.d.fileEvent({ event: 'file-loaded' }),
      ...s.d.property('video-params', { w: 1 }),
      ...s.d.property('time-pos', 0),
      ...restart(s.d),
    ];
    expect(states(all)).toEqual(['opening', 'buffering', 'playing']);
    expect(all.every((e) => e.attempt === 7)).toBe(true);
    expect(all.some((e) => e.type === 'state' && e.state === 'ready')).toBe(false);
  });

  const frames = (e: EngineEvent[]) => e.filter((x) => x.type === 'firstFrame');

  it('restart after video-params gives firstFrame at the restart, before playing', () => {
    const s = setup();
    s.d.fileEvent({ event: 'file-loaded' });
    s.d.property('video-params', { w: 1280 });
    s.clock.t = 1234;
    const first = restart(s.d);
    expect(first[0]).toEqual({ attempt: 7, type: 'firstFrame', atMs: 1234 });
    expect(types(first).slice(0, 2)).toEqual(['firstFrame', 'state']);
  });

  it('restart before video-params waits and fires firstFrame when video-params arrives', () => {
    const s = setup();
    s.d.fileEvent({ event: 'file-loaded' });
    s.d.property('video-params', null);
    expect(frames(restart(s.d))).toEqual([]);
    s.clock.t = 1500;
    expect(s.d.property('video-params', { w: 1280 })).toEqual([
      { attempt: 7, type: 'firstFrame', atMs: 1500 },
    ]);
    expect(s.d.property('video-params', { w: 1920 })).toEqual([]);
  });

  it('video-params before any restart emits nothing until the restart', () => {
    const s = setup();
    expect(s.d.property('video-params', { w: 1 })).toEqual([]);
  });

  it('audio-only media (vid false) gets firstFrame at the restart', () => {
    for (const vid of [false, 'no']) {
      const s = setup('vod');
      s.d.fileEvent({ event: 'file-loaded' });
      s.d.property('vid', vid);
      expect(frames(restart(s.d))).toHaveLength(1);
    }
  });

  it('vid false after the restart fires firstFrame then', () => {
    const s = setup('vod');
    restart(s.d);
    expect(frames(s.d.property('vid', false))).toHaveLength(1);
    expect(s.d.property('vid', false)).toEqual([]);
  });

  it('a vid track id does not count as audio-only', () => {
    const s = setup();
    s.d.property('vid', 1);
    expect(frames(restart(s.d))).toEqual([]);
  });

  it('a second restart after a seek or cache emits no second firstFrame', () => {
    const s = setup();
    play(s);
    s.d.property('seeking', true);
    expect(frames(restart(s.d))).toEqual([]);
    s.d.property('paused-for-cache', true);
    expect(frames(restart(s.d))).toEqual([]);
    expect(s.d.property('video-params', { w: 2 })).toEqual([]);
  });

  it('paused-for-cache while playing gives stall start and end with buffering', () => {
    const s = setup();
    play(s);
    s.clock.t = 2000;
    const start = s.d.property('paused-for-cache', true);
    expect(start).toContainEqual({ attempt: 7, type: 'stall', phase: 'start', atMs: 2000 });
    expect(states(start)).toEqual(['buffering']);
    expect(clocks(start)[0]?.rate).toBe(0);
    s.clock.t = 3000;
    const end = s.d.property('paused-for-cache', false);
    expect(end).toContainEqual({ attempt: 7, type: 'stall', phase: 'end', atMs: 3000 });
    expect(states(end)).toEqual(['playing']);
    expect(clocks(end)[0]?.rate).toBe(1);
  });

  it('paused-for-cache before playback is not a stall', () => {
    const s = setup();
    s.d.fileEvent({ event: 'file-loaded' });
    expect(s.d.property('paused-for-cache', true)).toEqual([]);
    expect(s.d.property('paused-for-cache', false)).toEqual([]);
  });

  it('clock rate 0 while paused and speed while playing', () => {
    const s = setup();
    play(s);
    s.d.property('time-pos', 5);
    s.d.property('speed', 2);
    const paused = s.d.property('pause', true);
    expect(states(paused)).toEqual(['paused']);
    expect(clocks(paused)[0]).toMatchObject({ rate: 0, positionMs: 5000 });
    s.d.property('speed', 2);
    const resumed = s.d.property('pause', false);
    expect(states(resumed)).toEqual(['playing']);
    expect(clocks(resumed)[0]).toMatchObject({ rate: 2 });
    expect(clocks(s.d.property('core-idle', true))[0]?.rate).toBe(0);
    expect(clocks(s.d.property('core-idle', false))[0]?.rate).toBe(2);
  });

  it('anchors at most once per 1000 ms of time-pos updates', () => {
    const s = setup();
    play(s);
    s.clock.t = 1500;
    expect(s.d.property('time-pos', 1)).toEqual([]);
    s.clock.t = 1999;
    expect(s.d.property('time-pos', 1.5)).toEqual([]);
    s.clock.t = 2000;
    expect(clocks(s.d.property('time-pos', 2))).toHaveLength(1);
    s.clock.t = 2500;
    expect(s.d.property('time-pos', 2.5)).toEqual([]);
  });

  it('seek and restart emit an anchor at once', () => {
    const s = setup();
    play(s);
    s.clock.t = 1100;
    const seeking = s.d.property('seeking', true);
    expect(clocks(seeking)[0]?.rate).toBe(0);
    s.d.property('time-pos', 30);
    s.clock.t = 1200;
    const done = [...s.d.property('seeking', false), ...restart(s.d)];
    expect(clocks(done).length).toBeGreaterThanOrEqual(2);
    expect(clocks(done).at(-1)).toMatchObject({ positionMs: 30000, atMs: 1200, rate: 1 });
  });

  it('carries duration for vod and the live edge for live', () => {
    const vod = setup('vod');
    vod.d.property('duration', 90.5);
    play(vod);
    expect(clocks(vod.d.property('speed', 1))).toEqual([]);
    expect(clocks(vod.d.property('pause', true))[0]).toMatchObject({ durationMs: 90500 });

    const live = setup('live');
    live.d.property('duration', 90);
    live.d.property('demuxer-cache-state', { 'cache-end': 12.25 });
    play(live);
    const a = clocks(live.d.property('pause', true))[0];
    expect(a?.liveEdgeMs).toBe(12250);
    expect(a?.durationMs).toBeUndefined();
  });

  it('ignores unusable property values', () => {
    const s = setup();
    play(s);
    expect(s.d.property('time-pos', null)).toEqual([]);
    expect(s.d.property('demuxer-cache-state', null)).toEqual([]);
    expect(s.d.property('unknown-prop', 1)).toEqual([]);
  });

  it('live eof becomes a network error', () => {
    const s = setup('live');
    play(s);
    const e = s.d.fileEvent({ event: 'end-file', reason: 'eof' });
    expect(e).toEqual([
      { attempt: 7, type: 'error', error: { code: 'network', detail: 'live-eof' } },
    ]);
  });

  it('vod eof becomes ended', () => {
    const s = setup('vod');
    play(s);
    expect(states(s.d.fileEvent({ event: 'end-file', reason: 'eof' }))).toEqual(['ended']);
  });

  it('a stopped media emits nothing more', () => {
    const s = setup();
    play(s);
    expect(s.d.fileEvent({ event: 'end-file', reason: 'stop' })).toEqual([]);
    expect(s.d.property('pause', true)).toEqual([]);
    expect(s.d.property('time-pos', 9)).toEqual([]);
    expect(restart(s.d)).toEqual([]);
    expect(s.d.tick()).toEqual([]);
  });

  it('end-file error uses the kept log lines', () => {
    const s = setup();
    s.d.log({ prefix: 'ffmpeg', level: 'error', text: 'HTTP error 404 Not Found' });
    const e = s.d.fileEvent({ event: 'end-file', reason: 'error', file_error: 'loading failed' });
    expect(e[0]).toMatchObject({ type: 'error', error: { code: 'http-404', httpStatus: 404 } });
  });

  it('log lines are kept to the last 50 per media', () => {
    const s = setup();
    s.d.log({ prefix: 'ffmpeg', level: 'error', text: 'HTTP error 404 Not Found' });
    for (let i = 0; i < 50; i++) s.d.log({ prefix: 'x', level: 'v', text: `noise ${i}` });
    const e = s.d.fileEvent({ event: 'end-file', reason: 'error' });
    expect(e[0]).toMatchObject({ error: { code: 'unknown' } });

    const again = createDeriver({ now: () => 0, clockIntervalMs: 1000 });
    again.begin(1, 'live');
    again.log({ prefix: 'ffmpeg', level: 'error', text: 'HTTP error 403 x' });
    again.begin(2, 'live');
    const second = again.fileEvent({ event: 'end-file', reason: 'error' });
    expect(second[0]).toMatchObject({ attempt: 2, error: { code: 'unknown' } });
  });

  it('adopt re-tags later events', () => {
    const s = setup();
    play(s);
    s.d.adopt(8);
    expect(s.d.property('pause', true).every((e) => e.attempt === 8)).toBe(true);
  });

  it('tick anchors a playing media once per interval and nothing while paused', () => {
    const s = setup();
    play(s);
    s.d.property('time-pos', 3);
    s.clock.t = 1500;
    expect(s.d.tick()).toEqual([]);
    s.clock.t = 2100;
    expect(clocks(s.d.tick())).toHaveLength(1);
    expect(s.d.tick()).toEqual([]);
  });

  it('events with no media begun produce nothing, and a late log or adopt is harmless', () => {
    const d = createDeriver({ now: () => 0, clockIntervalMs: 1000 });
    expect(d.property('pause', true)).toEqual([]);
    expect(d.fileEvent({ event: 'playback-restart' })).toEqual([]);
    expect(d.fileEvent({ event: 'client-message' })).toEqual([]);
    expect(d.tick()).toEqual([]);
    d.log({ prefix: 'a', level: 'v', text: 'HTTP error 404 x' });
    d.adopt(3);
    expect(d.begin(4, 'live')).toEqual([{ attempt: 4, type: 'state', state: 'opening' }]);
    expect(d.fileEvent({ event: 'end-file', reason: 'error' })[0]).toMatchObject({
      attempt: 4,
      error: { code: 'unknown' },
    });
  });

  it('other mpv events on a begun media produce nothing', () => {
    const s = setup();
    expect(s.d.fileEvent({ event: 'client-message' })).toEqual([]);
    expect(s.d.fileEvent({ event: 'start-file' })).toEqual([]);
  });
});

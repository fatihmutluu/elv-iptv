import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMpvEngine, type MpvEngineDeps } from './engine.ts';
import {
  BASE,
  errors,
  live,
  loadfiles,
  playing,
  type SetupOptions,
  setupEngineTest,
  sleep,
  states,
  URL_A,
  URL_VOD,
  VOD,
} from './engine-test-helpers.ts';
import { createFakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import type { VideoPresenter } from './presenter/types.ts';

const URL_EP2 = 'http://sim.test/movie/demo/demo/200002.mp4';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const c of cleanups.splice(0)) await c();
});

const setup = (o: SetupOptions = {}) => setupEngineTest(cleanups, o);

describe('Wave Q4 MpvEngine speed, scrubbing, warmUp & premature VOD EOF guard', () => {
  it('classifies mid-movie VOD EOF as network error instead of ended and inspects recent logs first', async () => {
    const midDropPlain: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 3600 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 600 },
      { afterMs: 7, event: 'playback-restart' },
      { afterMs: 35, event: 'end-file', reason: 'eof' },
    ];
    const midDropHttp: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 3600 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 900 },
      { afterMs: 7, event: 'playback-restart' },
      { afterMs: 25, log: { prefix: 'ffmpeg', level: 'warn', text: 'HTTP error 403 Forbidden' } },
      { afterMs: 35, event: 'end-file', reason: 'eof' },
    ];
    const { engine, events } = await setup({
      scripts: { [URL_VOD]: midDropPlain, [URL_EP2]: midDropHttp },
    });

    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toEqual({
      attempt: 1,
      type: 'error',
      error: { code: 'network', detail: 'vod-premature-eof' },
    });
    expect(states(events, 1)).not.toContain('ended');

    engine.load({ attempt: 2, url: URL_EP2, headers: {}, kind: 'vod' });
    await vi.waitFor(() => expect(errors(events)).toHaveLength(2));
    expect(errors(events)[1]).toMatchObject({
      attempt: 2,
      type: 'error',
      error: { code: 'http-403', httpStatus: 403 },
    });
  });

  it('clears queuedNext and issues playlist-clear when a mid-movie VOD connection drop occurs', async () => {
    const ep1MidDrop: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 1800 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 450 },
      { afterMs: 7, event: 'playback-restart' },
      { afterMs: 60, event: 'end-file', reason: 'eof' },
    ];
    const ep2Normal: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 1800 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 0 },
      { afterMs: 7, event: 'playback-restart' },
    ];
    const { engine, fake, events, ui } = await setup({
      scripts: { [URL_VOD]: ep1MidDrop, [URL_EP2]: ep2Normal },
    });
    const advanced: string[] = [];
    engine.onQueueAdvanced((key) => advanced.push(key));

    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);

    engine.queueNext({
      itemKey: 'series:ep2',
      stream: { url: URL_EP2, headers: {} },
    });
    await vi.waitFor(() =>
      expect(fake.sent.some((c) => c[0] === 'loadfile' && c[2] === 'append-play')).toBe(true),
    );

    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toEqual({
      attempt: 1,
      type: 'error',
      error: { code: 'network', detail: 'vod-premature-eof' },
    });
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['playlist-clear']));
    await sleep(30);
    expect(advanced).toEqual([]);
    expect(ui.some((e) => e.type === 'queueAdvanced')).toBe(false);
    expect(states(events, 1)).not.toContain('ended');
  });

  it('toggles hr-seek via setScrubbing, uses absolute+keyframes for scrubbing & far VOD seeks, and resets on load/stop/release', async () => {
    const vodAt100s: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 3600 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 100 },
      { afterMs: 7, event: 'playback-restart' },
    ];
    const { engine, fake, events } = await setup({
      scripts: { [URL_VOD]: vodAt100s, [URL_EP2]: VOD, [URL_A]: VOD },
    });

    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === 'clock' && e.anchor.positionMs === 100_000)).toBe(true),
    );

    // Fine < 30s VOD nudge while NOT scrubbing uses 'absolute+exact'
    engine.seek(1, 115_000);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['seek', 115, 'absolute+exact']));

    // Far >= 30s VOD jump while NOT scrubbing uses 'absolute+keyframes'
    engine.seek(1, 200_000);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['seek', 200, 'absolute+keyframes']));

    // setScrubbing(true) sets hr-seek=no once (idempotent) and makes even small seeks use 'absolute+keyframes'
    engine.setScrubbing?.(1, true);
    engine.setScrubbing?.(1, true);
    engine.seek(1, 205_000);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['seek', 205, 'absolute+keyframes']));
    expect(fake.sent.filter((c) => c[0] === 'set_property' && c[1] === 'hr-seek')).toEqual([
      ['set_property', 'hr-seek', 'no'],
    ]);

    // setScrubbing(false) restores hr-seek=yes once
    engine.setScrubbing?.(1, false);
    engine.setScrubbing?.(1, false);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['set_property', 'hr-seek', 'yes']));
    expect(fake.sent.filter((c) => c[0] === 'set_property' && c[1] === 'hr-seek')).toEqual([
      ['set_property', 'hr-seek', 'no'],
      ['set_property', 'hr-seek', 'yes'],
    ]);

    // New load while scrubbing resets hr-seek=yes BEFORE loadfile
    engine.setScrubbing?.(1, true);
    await vi.waitFor(() =>
      expect(
        fake.sent.filter((c) => c[0] === 'set_property' && c[1] === 'hr-seek' && c[2] === 'no'),
      ).toHaveLength(2),
    );
    const beforeLoad2 = fake.sent.length;
    engine.load({ attempt: 2, url: URL_EP2, headers: {}, kind: 'vod', startMs: 60_000 });
    await playing(events, 2);
    const afterLoad2 = fake.sent.slice(beforeLoad2);
    const restoreIdx = afterLoad2.findIndex(
      (c) => c[0] === 'set_property' && c[1] === 'hr-seek' && c[2] === 'yes',
    );
    const loadIdx = afterLoad2.findIndex((c) => c[0] === 'loadfile');
    expect(restoreIdx).toBeGreaterThanOrEqual(0);
    expect(loadIdx).toBeGreaterThan(restoreIdx);
    expect(loadfiles(fake).at(-1)?.[4]).toMatchObject({ start: '60.000', 'hr-seek': 'no' });

    // stop() while scrubbing restores hr-seek=yes
    engine.setScrubbing?.(2, true);
    await vi.waitFor(() =>
      expect(
        fake.sent.filter((c) => c[0] === 'set_property' && c[1] === 'hr-seek' && c[2] === 'no'),
      ).toHaveLength(3),
    );
    const beforeStop = fake.sent.length;
    engine.stop(3);
    await vi.waitFor(() =>
      expect(fake.sent.slice(beforeStop)).toContainEqual(['set_property', 'hr-seek', 'yes']),
    );

    // Live TV timeshift always keeps 'absolute' even for >= 30s jumps, and ignores setScrubbing(true)
    engine.load(live(4, URL_A));
    await playing(events, 4);
    const beforeLive = fake.sent.length;
    engine.setScrubbing?.(4, true);
    engine.seek(4, 180_000);
    await vi.waitFor(() =>
      expect(fake.sent.slice(beforeLive)).toContainEqual(['seek', 180, 'absolute']),
    );
    expect(
      fake.sent.slice(beforeLive).some((c) => c[0] === 'set_property' && c[1] === 'hr-seek'),
    ).toBe(false);

    // release() while scrubbing restores hr-seek=yes
    engine.load({ attempt: 5, url: URL_EP2, headers: {}, kind: 'vod' });
    await playing(events, 5);
    engine.setScrubbing?.(5, true);
    await vi.waitFor(() =>
      expect(
        fake.sent.filter((c) => c[0] === 'set_property' && c[1] === 'hr-seek' && c[2] === 'no'),
      ).toHaveLength(4),
    );
    const beforeRelease = fake.sent.length;
    engine.release();
    await vi.waitFor(() =>
      expect(fake.sent.slice(beforeRelease)).toContainEqual(['set_property', 'hr-seek', 'yes']),
    );
  });

  it('warmUp pre-warms idle deferStart process once, isolates spawn errors, and no-ops after release', async () => {
    // Normal warmUp with deferStart: true
    const { engine, fake, events } = await setup({ deferStart: true, ready: false });
    expect(engine.spawns).toBe(0);
    engine.warmUp?.();
    engine.warmUp?.();
    engine.start();
    await vi.waitFor(() => expect(fake.connections).toBe(1));
    expect(engine.spawns).toBe(1);
    engine.load(live(1, URL_A));
    await playing(events, 1);
    expect(engine.spawns).toBe(1);

    // Spawn error during idle warmUp is caught/isolated with no error event, and later load() recovers
    let attemptNum = 0;
    const { engine: engine2, events: events2 } = await setup({
      deferStart: true,
      ready: false,
      spawn: (f) => (args, signal) => {
        attemptNum += 1;
        if (attemptNum === 1) return Promise.reject(new Error('transient spawn failure'));
        return f.spawn(args, signal);
      },
    });
    engine2.warmUp?.();
    await vi.waitFor(() => expect(attemptNum).toBe(1));
    await sleep(15);
    expect(errors(events2)).toEqual([]);
    engine2.load(live(1, URL_A));
    await playing(events2, 1);
    expect(attemptNum).toBe(2);

    // warmUp after release() is a strict no-op
    const { engine: engine3 } = await setup({ deferStart: true, ready: false });
    engine3.release();
    engine3.warmUp?.();
    await sleep(15);
    expect(engine3.spawns).toBe(0);
  });

  it('restores hr-seek=yes after playback-restart on resumed VOD (>= 30s) unless scrubbing and uses absolute+exact for fine seeks', async () => {
    const resumedVod: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 3600 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 60 },
      { afterMs: 8, event: 'playback-restart' },
    ];
    const slowResumeVod: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 3600 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 90 },
      { afterMs: 45, event: 'playback-restart' },
    ];
    const { engine, fake, events } = await setup({
      scripts: { [URL_VOD]: resumedVod, [URL_EP2]: slowResumeVod },
    });

    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod', startMs: 60_000 });
    await playing(events, 1);

    // loadfile set hr-seek=no for fast resume, then playback-restart restores hr-seek=yes
    expect(loadfiles(fake)[0]?.[4]).toMatchObject({ start: '60.000', 'hr-seek': 'no' });
    await vi.waitFor(() => {
      const loadIdx = fake.sent.findIndex((c) => c[0] === 'loadfile');
      expect(
        fake.sent
          .slice(loadIdx + 1)
          .some((c) => c[0] === 'set_property' && c[1] === 'hr-seek' && c[2] === 'yes'),
      ).toBe(true);
    });

    // Fine < 30s VOD nudge uses absolute+exact
    engine.seek(1, 70_000);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['seek', 70, 'absolute+exact']));

    // If user starts scrubbing BEFORE playback-restart fires on a resumed VOD, do NOT clobber hr-seek=no
    const beforeLoad2 = fake.sent.length;
    engine.load({ attempt: 2, url: URL_EP2, headers: {}, kind: 'vod', startMs: 90_000 });
    await vi.waitFor(() => expect(loadfiles(fake)).toHaveLength(2));
    engine.setScrubbing?.(2, true);
    await playing(events, 2);
    await sleep(25);
    const afterLoad2HrSeeks = fake.sent
      .slice(beforeLoad2)
      .filter((c) => c[0] === 'set_property' && c[1] === 'hr-seek');
    expect(afterLoad2HrSeeks).toEqual([['set_property', 'hr-seek', 'no']]);
  });

  it('preserves lastDurationMs when mpv clears duration to undefined right before premature VOD EOF', async () => {
    const ep1DurationClearedBeforeEof: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 1800 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 450 },
      { afterMs: 7, event: 'playback-restart' },
      { afterMs: 55, property: 'duration', value: undefined },
      { afterMs: 60, event: 'end-file', reason: 'eof' },
    ];
    const { engine, fake, events, ui } = await setup({
      scripts: { [URL_VOD]: ep1DurationClearedBeforeEof, [URL_EP2]: VOD },
    });

    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);
    engine.queueNext({ itemKey: 'series:ep2', stream: { url: URL_EP2, headers: {} } });
    await vi.waitFor(() =>
      expect(fake.sent.some((c) => c[0] === 'loadfile' && c[2] === 'append-play')).toBe(true),
    );

    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    expect(errors(events)[0]).toEqual({
      attempt: 1,
      type: 'error',
      error: { code: 'network', detail: 'vod-premature-eof' },
    });
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['playlist-clear']));
    await sleep(25);
    expect(ui.some((e) => e.type === 'queueAdvanced')).toBe(false);
  });

  it('exposes clearQueuedNext alias on MpvEngine that clears queued playlist entries', async () => {
    const { engine, fake, events } = await setup({
      scripts: { [URL_VOD]: VOD, [URL_EP2]: VOD },
    });
    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);
    engine.queueNext({ itemKey: 'series:ep2', stream: { url: URL_EP2, headers: {} } });
    await vi.waitFor(() =>
      expect(fake.sent.some((c) => c[0] === 'loadfile' && c[2] === 'append-play')).toBe(true),
    );

    const beforeClear = fake.sent.length;
    expect(typeof engine.clearQueuedNext).toBe('function');
    engine.clearQueuedNext?.();
    await vi.waitFor(() => expect(fake.sent.slice(beforeClear)).toContainEqual(['playlist-clear']));
  });

  it('aborts and stops a queued episode whose in-flight append-play reply lands after premature VOD EOF', async () => {
    const ep1FastDrop: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 3, event: 'file-loaded' },
      { afterMs: 4, property: 'duration', value: 1800 },
      { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
      { afterMs: 6, property: 'time-pos', value: 450 },
      { afterMs: 7, event: 'playback-restart' },
      { afterMs: 40, event: 'end-file', reason: 'eof' },
    ];
    const fake = createFakeMpv({
      scripts: { [URL_VOD]: ep1FastDrop, [URL_EP2]: VOD },
      transport: 'socket',
    });
    let releaseAppendReply: (() => void) | undefined;
    const presenter: VideoPresenter = {
      kind: 'canvas',
      coversArea: false,
      prepare: async () => [],
      attach: () => undefined,
      setArea: () => undefined,
      toggleFullscreen: () => undefined,
      onEvent: () => () => undefined,
      dispose: () => undefined,
    };
    const timers: MpvEngineDeps['timers'] = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    const ui: unknown[] = [];
    const engine = createMpvEngine({
      spawn: async (args, signal) => {
        const proc = await fake.spawn(args, signal);
        const origCommand = proc.client.command.bind(proc.client);
        return {
          ...proc,
          client: {
            ...proc.client,
            command: (cmd) => {
              const p = origCommand(cmd);
              if (cmd[0] === 'loadfile' && cmd[2] === 'append-play') {
                return new Promise((resolve, reject) => {
                  releaseAppendReply = () => void p.then(resolve, reject);
                });
              }
              return p;
            },
          },
        };
      },
      presenter,
      baseArgs: BASE,
      loadMode: 'replace',
      now: () => Date.now(),
      timers,
      onUi: (ev) => ui.push(ev),
    });
    cleanups.push(async () => {
      engine.release();
      await fake.dispose();
    });

    const events: Parameters<Parameters<typeof engine.subscribe>[0]>[0][] = [];
    engine.subscribe((e) => events.push(e));
    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);

    engine.queueNext({ itemKey: 'series:ep2', stream: { url: URL_EP2, headers: {} } });
    await vi.waitFor(() => expect(releaseAppendReply).toBeDefined());

    // Premature VOD EOF occurs while append-play IPC reply is still in flight
    await vi.waitFor(() => expect(errors(events)).toHaveLength(1));
    const afterErrorIdx = fake.sent.length;

    // Now the in-flight append-play reply lands; Episode 2 already auto-started as playlist/0
    releaseAppendReply?.();
    await vi.waitFor(() =>
      expect(fake.sent.slice(afterErrorIdx)).toContainEqual(['playlist-clear']),
    );
    await vi.waitFor(() => expect(fake.sent.slice(afterErrorIdx)).toContainEqual(['stop']));
    await sleep(25);
    expect(ui.some((e) => (e as { type?: string }).type === 'queueAdvanced')).toBe(false);
  });
});

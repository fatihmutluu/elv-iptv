import type { EngineEvent, LoadCommand, MediaTracks, PlayerEngine } from '@elv/playback';
import { createFakePlayerEngine, type FakeStep } from '@elv/playback/testing';
import { act, render } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { CorpusGateScreen } from '../CorpusGateScreen';
import { buildCorpusItems, type CorpusReport, parseCorpusGateUrl } from '../corpus-items';

jest.mock('@elv/engine-aether', () => ({
  createAetherEngine: () => null,
  AetherSurface: () => null,
}));

jest.mock('@elv/engine-media3', () => ({
  createMedia3Engine: () => null,
  Media3Surface: () => null,
}));

const BASE = 'http://127.0.0.1:7878';
const LIVE = `${BASE}/live/demo/demo`;
const MOVIE = `${BASE}/movie/demo/demo`;
const EMPTY_URL = `${MOVIE}/200001.mp4?fault=empty`;
const TRACK_URLS = new Set([
  `${LIVE}/1010.ts`,
  `${LIVE}/1010.m3u8`,
  `${MOVIE}/200010.mp4`,
  `${MOVIE}/200011.mkv`,
  `${MOVIE}/200010.m3u8`,
]);
const AUDIO_ONLY_URLS = new Set([`${LIVE}/1006.ts`, `${MOVIE}/200006.mp4`]);
const TRACK_ITEMS = ['live-1010', 'live-1010-hls', 'vod-200010', 'vod-200011', 'vod-200010-hls'];

interface EngineOpts {
  empty?: 'network' | 'ended' | 'connection-limit';
  tracks?: 'full' | 'none' | 'other-languages' | 'unswitched';
  clock?: 'running' | 'none' | 'frozen';
  seekLandsAt?: (target: number) => number;
  seekEnds?: boolean;
  neverPlays?: boolean;
}

function trackSet(kind: EngineOpts['tracks']): MediaTracks {
  if (kind === 'none') {
    return { audio: [], subtitles: [], selectedAudioId: null, selectedSubtitleId: null };
  }
  const [a, b] = kind === 'other-languages' ? ['fre', 'spa'] : ['deu', 'eng'];
  const [c, d] = kind === 'other-languages' ? ['ita', 'pol'] : ['eng', 'tur'];
  return {
    audio: [
      { id: 'a:0', language: a },
      { id: 'a:1', language: b },
    ],
    subtitles: [
      { id: 's:0', language: c },
      { id: 's:1', language: d },
    ],
    selectedAudioId: 'a:0',
    selectedSubtitleId: null,
  };
}

function script(url: string, opts: EngineOpts): FakeStep[] {
  if (url === EMPTY_URL) {
    if (opts.empty === 'ended') return [{ afterMs: 2, emit: 'state', state: 'ended' }];
    const code = opts.empty === 'connection-limit' ? 'connection-limit' : 'network';
    return [{ afterMs: 2, emit: 'error', error: { code, detail: 'empty-vod-eof' } }];
  }
  if (opts.neverPlays === true) return [{ afterMs: 0, emit: 'state', state: 'opening' }];
  const steps: FakeStep[] = [{ afterMs: 0, emit: 'state', state: 'opening' }];
  if (!AUDIO_ONLY_URLS.has(url)) steps.push({ afterMs: 1, emit: 'firstFrame' });
  steps.push({ afterMs: 1, emit: 'state', state: 'playing' });
  if (opts.clock !== 'none') {
    steps.push({
      afterMs: 1,
      emit: 'clock',
      positionMs: 100,
      rate: opts.clock === 'frozen' ? 0 : 1,
    });
  }
  if (TRACK_URLS.has(url))
    steps.push({ afterMs: 2, emit: 'tracks', tracks: trackSet(opts.tracks) });
  return steps;
}

function makeEngine(opts: EngineOpts = {}) {
  const seeks: number[] = [];
  const loads: string[] = [];
  const selections: string[] = [];
  let released = false;
  let onFinalStop: (() => void) | undefined;
  const listeners = new Set<(event: EngineEvent) => void>();
  const send = (event: EngineEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const scripts: Record<string, FakeStep[]> = {};
  const base = createFakePlayerEngine({
    scripts,
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, Math.min(ms, 2)),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  base.subscribe(send);
  let tracks = trackSet(opts.tracks);
  const engine: PlayerEngine = {
    ...base,
    load(cmd: LoadCommand) {
      loads.push(cmd.url);
      scripts[cmd.url] = script(cmd.url, opts);
      tracks = trackSet(opts.tracks);
      base.load(cmd);
    },
    seek(attempt, positionMs) {
      seeks.push(positionMs);
      base.seek(attempt, positionMs);
      setTimeout(() => {
        if (opts.seekEnds === true) {
          send({ attempt, type: 'state', state: 'ended' });
          return;
        }
        const landed = opts.seekLandsAt?.(positionMs) ?? positionMs;
        const rate = opts.clock === 'frozen' ? 0 : 1;
        send({
          attempt,
          type: 'clock',
          anchor: { positionMs: landed, atMs: performance.now(), rate, durationMs: 600_000 },
        });
      }, 1);
    },
    selectAudioTrack(attempt, id) {
      selections.push(`audio:${id}`);
      if (opts.tracks === 'unswitched') return;
      tracks = { ...tracks, selectedAudioId: id };
      const next = tracks;
      setTimeout(() => send({ attempt, type: 'tracks', tracks: next }), 1);
    },
    selectSubtitleTrack(attempt, id) {
      selections.push(`subtitle:${id ?? 'off'}`);
      if (opts.tracks === 'unswitched') return;
      tracks = { ...tracks, selectedSubtitleId: id };
      const next = tracks;
      setTimeout(() => send({ attempt, type: 'tracks', tracks: next }), 1);
    },
    stop(attempt) {
      base.stop(attempt);
      if (loads.length === 29) onFinalStop?.();
    },
    release() {
      released = true;
      base.release();
      listeners.clear();
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ attempt: 0, type: 'surface', change: 'created' });
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    engine,
    seeks,
    loads,
    selections,
    isReleased: () => released,
    setOnFinalStop: (fn: () => void) => {
      onFinalStop = fn;
    },
  };
}

const tick = (ms: number): Promise<void> =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });

const reasons = (report: CorpusReport): Record<string, string> =>
  Object.fromEntries(report.failed.map((f) => [f.id, f.reason]));

describe('parseCorpusGateUrl and buildCorpusItems', () => {
  it('parses elviptv://gate/corpus links and builds all 29 corpus items', () => {
    expect(parseCorpusGateUrl(null)).toBeUndefined();
    expect(parseCorpusGateUrl('elviptv://gate/player')).toBeUndefined();
    expect(
      parseCorpusGateUrl('elviptv://gate/corpus?host=127.0.0.1%3A7878&account=demo&burst=8'),
    ).toEqual({
      host: '127.0.0.1:7878',
      account: 'demo',
      burst: 8,
    });
    expect(parseCorpusGateUrl('elviptv://gate/corpus?host=%ZZ&account=%E0%A4%A')).toEqual({
      host: '10.0.2.2:7878',
      account: 'corpus',
      burst: 0,
    });

    const items = buildCorpusItems({ base: BASE, account: 'demo', burst: 8 });
    expect(items).toHaveLength(29);
    expect(items[28]).toMatchObject({
      id: 'vod-200001-empty',
      url: EMPTY_URL,
      expect: 'failed',
      expectError: 'playback/network',
    });
  });
});

describe('CorpusGateScreen', () => {
  let lines: string[] = [];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.replaceProperty(Platform, 'OS', 'android');
    lines = [];
    jest.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string' && msg.startsWith('ELV_GATE_CORPUS ')) lines.push(msg);
    });
    jest.spyOn(console, 'error').mockImplementation((msg: unknown) => {
      if (typeof msg === 'string' && msg.startsWith('ELV_GATE_CORPUS ')) lines.push(msg);
    });
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  async function runSweep(opts: EngineOpts = {}, itemTimeoutMs = 200): Promise<CorpusReport> {
    const h = makeEngine(opts);
    const view = await render(
      <CorpusGateScreen
        params={{ host: '127.0.0.1:7878', account: 'demo', burst: 0 }}
        createEngine={() => h.engine}
        holdMs={10}
        itemTimeoutMs={itemTimeoutMs}
      />,
    );
    await tick(30_000);
    expect(lines).toHaveLength(1);
    await view.unmount();
    return JSON.parse((lines[0] ?? '').slice('ELV_GATE_CORPUS '.length)) as CorpusReport;
  }

  it('sweeps all 29 items, switches requested tracks, seeks VOD HLS, and prints ELV_GATE_CORPUS', async () => {
    const h = makeEngine();
    const view = await render(
      <CorpusGateScreen
        params={{ host: '127.0.0.1:7878', account: 'demo', burst: 0 }}
        createEngine={() => h.engine}
        holdMs={10}
        itemTimeoutMs={200}
      />,
    );
    await tick(5_000);
    expect(lines).toHaveLength(1);
    const report = JSON.parse((lines[0] ?? '').slice('ELV_GATE_CORPUS '.length)) as CorpusReport;
    expect(report).toEqual({
      total: 29,
      passed: 29,
      failed: [],
      surfaceCreated: 1,
      staleEventsApplied: 0,
    });
    expect(h.loads).toHaveLength(29);
    expect(h.seeks).toEqual([30_000]);
    expect(h.selections.filter((s) => s === 'audio:a:1')).toHaveLength(3);
    expect(h.selections.filter((s) => s === 'subtitle:s:1')).toHaveLength(5);
    await view.unmount();
  });

  it('fails the empty VOD item when it ends or fails as connection-limit', async () => {
    const ended = await runSweep({ empty: 'ended' });
    expect(reasons(ended)).toEqual({ 'vod-200001-empty': 'expected failed, settled on ended' });
    lines = [];
    const limit = await runSweep({ empty: 'connection-limit' });
    expect(reasons(limit)).toEqual({
      'vod-200001-empty': 'expected playback/network, got playback/connection-limit',
    });
  });

  it('fails every track item when tracks are empty, missing the language, or unswitched', async () => {
    const empty = await runSweep({ tracks: 'none' });
    expect(reasons(empty)).toEqual({
      'live-1010': 'no audio tracks',
      'live-1010-hls': 'no subtitle tracks',
      'vod-200010': 'no audio tracks',
      'vod-200011': 'no audio tracks',
      'vod-200010-hls': 'no subtitle tracks',
    });
    lines = [];
    const missing = await runSweep({ tracks: 'other-languages' });
    expect(Object.keys(reasons(missing))).toEqual(TRACK_ITEMS);
    expect(reasons(missing)['live-1010']).toBe('no audio track for eng');
    expect(reasons(missing)['live-1010-hls']).toBe('no subtitle track for tur');
    lines = [];
    const unswitched = await runSweep({ tracks: 'unswitched' });
    expect(Object.keys(reasons(unswitched))).toEqual(TRACK_ITEMS);
    expect(reasons(unswitched)['vod-200010']).toBe('audio track a:1 not selected');
    expect(reasons(unswitched)['vod-200010-hls']).toBe('subtitle track s:1 not selected');
  });

  it('fails playable items, including audio-only ones, when the clock is absent or frozen', async () => {
    const noClock = await runSweep({ clock: 'none' }, 80);
    expect(noClock.passed).toBe(1);
    expect(reasons(noClock)['live-1006']).toBe('no clock anchor');
    expect(reasons(noClock)['vod-200006']).toBe('no clock anchor');
    lines = [];
    const frozen = await runSweep({ clock: 'frozen' });
    expect(frozen.passed).toBe(1);
    expect(reasons(frozen)['live-1006']).toBe('clock not advancing');
    expect(reasons(frozen)['vod-200001']).toBe('clock not advancing');
  });

  it('fails a seek that overshoots the window or settles on ended without waiting out the timeout', async () => {
    const overshoot = await runSweep({ seekLandsAt: (target) => target + 60_000 });
    expect(reasons(overshoot)).toEqual({
      'vod-200010-hls': 'seek to 30000 ms not confirmed (clock at 90000 ms)',
    });
    lines = [];
    const h = makeEngine({ seekEnds: true });
    const view = await render(
      <CorpusGateScreen
        params={{ host: '127.0.0.1:7878', account: 'demo', burst: 0 }}
        createEngine={() => h.engine}
        holdMs={10}
        itemTimeoutMs={10_000}
      />,
    );
    await tick(2_000);
    expect(lines).toHaveLength(1);
    const ended = JSON.parse((lines[0] ?? '').slice('ELV_GATE_CORPUS '.length)) as CorpusReport;
    expect(reasons(ended)).toEqual({
      'vod-200010-hls': 'seek to 30000 ms failed (settled on ended)',
    });
    await view.unmount();
  });

  it('clears timers and releases the engine on unmount mid-wait and right before printCorpus', async () => {
    const active = new Set<unknown>();
    const origSet = globalThis.setTimeout;
    const origClear = globalThis.clearTimeout;
    jest.spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: (...cbArgs: unknown[]) => void,
      ms?: number,
      ...args: unknown[]
    ) => {
      const id = origSet(() => {
        active.delete(id);
        fn(...args);
      }, ms);
      if ((ms ?? 0) > 0) active.add(id);
      return id;
    }) as typeof setTimeout);
    jest.spyOn(globalThis, 'clearTimeout').mockImplementation(((
      id?: ReturnType<typeof setTimeout>,
    ) => {
      active.delete(id);
      origClear(id);
    }) as typeof clearTimeout);

    const stalled = makeEngine({ neverPlays: true });
    const stalledView = await render(
      <CorpusGateScreen
        params={{ host: '127.0.0.1:7878', account: 'demo', burst: 0 }}
        createEngine={() => stalled.engine}
        holdMs={25}
        itemTimeoutMs={60_000}
      />,
    );
    await tick(100);
    expect(active.size).toBeGreaterThan(0);
    await stalledView.unmount();
    expect(stalled.isReleased()).toBe(true);
    expect(active.size).toBe(0);
    await tick(120_000);
    expect(lines).toHaveLength(0);

    const almostDone = makeEngine();
    let unmountOnStop = false;
    const view = await render(
      <CorpusGateScreen
        params={{ host: '127.0.0.1:7878', account: 'demo', burst: 0 }}
        createEngine={() => almostDone.engine}
        holdMs={25}
        itemTimeoutMs={200}
      />,
    );
    almostDone.setOnFinalStop(() => {
      unmountOnStop = true;
    });
    for (let i = 0; i < 200 && !unmountOnStop; i += 1) await tick(10);
    expect(unmountOnStop).toBe(true);
    expect(lines).toHaveLength(0);
    await view.unmount();
    expect(active.size).toBe(0);
    await tick(1_000);
    expect(lines).toHaveLength(0);
  });
});

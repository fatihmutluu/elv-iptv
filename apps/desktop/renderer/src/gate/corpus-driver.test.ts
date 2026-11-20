import type { EngineEvent, LoadCommand, MediaTracks, PlayerEngine } from '@elv/playback';
import { createFakePlayerEngine, type FakeStep } from '@elv/playback/testing';
import { describe, expect, it } from 'vitest';
import { corpusLine, createCorpusRun, type DesktopCorpusReport } from './corpus-driver.ts';

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
  empty?: 'network' | 'ended' | 'unsupported';
  tracks?: 'full' | 'none' | 'other-languages' | 'unswitched';
  clock?: 'running' | 'none' | 'frozen';
  seekLandsAt?: (target: number) => number;
  seekResumeDelayMs?: number;
  seekStuckZeroRate?: boolean;
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
    const code = opts.empty === 'unsupported' ? 'unsupported-format' : 'network';
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

function makeEngine(opts: EngineOpts = {}): {
  engine: PlayerEngine;
  seeks: number[];
  selections: string[];
  selectionDelaysMs: number[];
} {
  const seeks: number[] = [];
  const selections: string[] = [];
  const selectionDelaysMs: number[] = [];
  let itemClockAt = 0;
  const listeners = new Set<(event: EngineEvent) => void>();
  const send = (event: EngineEvent): void => {
    if (event.type === 'clock' && event.anchor.positionMs === 100) itemClockAt = performance.now();
    for (const listener of [...listeners]) listener(event);
  };
  const scripts: Record<string, FakeStep[]> = {};
  const base = createFakePlayerEngine({
    scripts,
    now: () => performance.now(),
    schedule: (fn, ms) => setTimeout(fn, Math.min(ms, 1)),
    cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  base.subscribe(send);
  let tracks = trackSet(opts.tracks);
  const later = (fn: () => void): void => {
    setTimeout(fn, 1);
  };
  const engine: PlayerEngine = {
    ...base,
    load(cmd: LoadCommand) {
      scripts[cmd.url] = script(cmd.url, opts);
      tracks = trackSet(opts.tracks);
      base.load(cmd);
    },
    seek(attempt, positionMs) {
      seeks.push(positionMs);
      base.seek(attempt, positionMs);
      later(() => {
        if (opts.seekEnds === true) {
          send({ attempt, type: 'state', state: 'ended' });
          return;
        }
        const landed = opts.seekLandsAt?.(positionMs) ?? positionMs;
        if (opts.seekResumeDelayMs !== undefined || opts.seekStuckZeroRate === true) {
          send({
            attempt,
            type: 'clock',
            anchor: { positionMs: landed, atMs: performance.now(), rate: 0 },
          });
          if (opts.seekResumeDelayMs !== undefined) {
            setTimeout(() => {
              send({
                attempt,
                type: 'clock',
                anchor: { positionMs: landed, atMs: performance.now(), rate: 1 },
              });
            }, opts.seekResumeDelayMs);
          }
          return;
        }
        const rate = opts.clock === 'frozen' ? 0 : 1;
        send({
          attempt,
          type: 'clock',
          anchor: { positionMs: landed, atMs: performance.now(), rate },
        });
      });
    },
    selectAudioTrack(attempt, id) {
      selectionDelaysMs.push(performance.now() - itemClockAt);
      selections.push(`audio:${id}`);
      if (opts.tracks === 'unswitched') return;
      tracks = { ...tracks, selectedAudioId: id };
      const next = tracks;
      later(() => send({ attempt, type: 'tracks', tracks: next }));
    },
    selectSubtitleTrack(attempt, id) {
      selectionDelaysMs.push(performance.now() - itemClockAt);
      selections.push(`subtitle:${id ?? 'off'}`);
      if (opts.tracks === 'unswitched') return;
      tracks = { ...tracks, selectedSubtitleId: id };
      const next = tracks;
      later(() => send({ attempt, type: 'tracks', tracks: next }));
    },
    subscribe(listener) {
      listeners.add(listener);
      listener({ attempt: 0, type: 'surface', change: 'created' });
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { engine, seeks, selections, selectionDelaysMs };
}

interface Timers {
  later(fn: () => void, ms: number): () => void;
  active(): number;
}

function realTimers(): Timers {
  const pending = new Set<ReturnType<typeof setTimeout>>();
  return {
    later(fn, ms) {
      const id = setTimeout(() => {
        pending.delete(id);
        fn();
      }, ms);
      pending.add(id);
      return () => {
        pending.delete(id);
        clearTimeout(id);
      };
    },
    active: () => pending.size,
  };
}

async function sweep(opts: EngineOpts = {}, itemTimeoutMs = 200): Promise<DesktopCorpusReport> {
  const { engine } = makeEngine(opts);
  const run = createCorpusRun({
    engine,
    base: BASE,
    account: 'demo',
    now: () => performance.now(),
    later: realTimers().later,
    holdMs: 3,
    itemTimeoutMs,
  });
  const report = await run.start();
  run.dispose();
  return report;
}

const reasons = (report: DesktopCorpusReport): Record<string, string> =>
  Object.fromEntries(report.failed.map((f) => [f.id, f.reason]));

describe('createCorpusRun', () => {
  it('passes all 29 items, switches the tracks it asks for and seeks the VOD HLS item', async () => {
    const { engine, seeks, selections } = makeEngine();
    const run = createCorpusRun({
      engine,
      base: BASE,
      account: 'demo',
      now: () => performance.now(),
      later: realTimers().later,
      holdMs: 3,
      itemTimeoutMs: 200,
    });
    const report = await run.start();
    run.dispose();
    expect(report).toEqual({
      total: 29,
      passed: 29,
      failed: [],
      surfaceCreated: 1,
      staleEventsApplied: 0,
    });
    expect(seeks).toEqual([30_000]);
    expect(selections.filter((s) => s === 'audio:a:1')).toHaveLength(3);
    expect(selections.filter((s) => s === 'subtitle:s:1')).toHaveLength(5);
    expect(corpusLine(report)).toMatch(/^ELV_GATE_CORPUS \{.*\}$/);
  });

  it('fails the empty item when it ends or fails with another error', async () => {
    const ended = await sweep({ empty: 'ended' });
    expect(ended.passed).toBe(28);
    expect(reasons(ended)).toEqual({ 'vod-200001-empty': 'expected failed, settled on ended' });
    const other = await sweep({ empty: 'unsupported' });
    expect(reasons(other)).toEqual({
      'vod-200001-empty': 'expected playback/network, got playback/unsupported-format',
    });
  });

  it('fails every track item when the media reports no tracks', async () => {
    const report = await sweep({ tracks: 'none' });
    expect(report.passed).toBe(24);
    expect(reasons(report)).toEqual({
      'live-1010': 'no audio tracks',
      'live-1010-hls': 'no subtitle tracks',
      'vod-200010': 'no audio tracks',
      'vod-200011': 'no audio tracks',
      'vod-200010-hls': 'no subtitle tracks',
    });
  });

  it('fails every track item when the requested language is missing instead of picking the first track', async () => {
    const report = await sweep({ tracks: 'other-languages' });
    expect(Object.keys(reasons(report))).toEqual(TRACK_ITEMS);
    expect(reasons(report)['live-1010']).toBe('no audio track for eng');
    expect(reasons(report)['live-1010-hls']).toBe('no subtitle track for tur');
  });

  it('fails every track item when the engine never switches to the picked track', async () => {
    const report = await sweep({ tracks: 'unswitched' });
    expect(Object.keys(reasons(report))).toEqual(TRACK_ITEMS);
    expect(reasons(report)['vod-200010']).toBe('audio track a:1 not selected');
    expect(reasons(report)['vod-200010-hls']).toBe('subtitle track s:1 not selected');
  });

  it('fails playable items, audio-only ones included, without a clock anchor', async () => {
    const report = await sweep({ clock: 'none' }, 60);
    expect(report.passed).toBe(1);
    expect(reasons(report)['live-1006']).toBe('no clock anchor');
    expect(reasons(report)['vod-200006']).toBe('no clock anchor');
    expect(reasons(report)['live-1001']).toBe('no clock anchor');
  });

  it('fails playable items whose clock does not advance', async () => {
    const report = await sweep({ clock: 'frozen' });
    expect(report.passed).toBe(1);
    expect(reasons(report)['live-1006']).toBe('clock not advancing');
    expect(reasons(report)['vod-200001']).toBe('clock not advancing');
  });

  it('drains holdMs before firing track selection to avoid loopback HTTP overlap', async () => {
    const { engine, selectionDelaysMs } = makeEngine();
    const run = createCorpusRun({
      engine,
      base: BASE,
      account: 'demo',
      now: () => performance.now(),
      later: realTimers().later,
      holdMs: 25,
      itemTimeoutMs: 300,
    });
    const report = await run.start();
    run.dispose();
    expect(report.passed).toBe(29);
    expect(selectionDelaysMs.length).toBeGreaterThan(0);
    for (const delay of selectionDelaysMs) expect(delay).toBeGreaterThanOrEqual(18);
  });

  it('waits past a rate-0 seek discontinuity anchor for rate > 0, and fails if rate stays 0', async () => {
    const resumed = await sweep({ seekResumeDelayMs: 35 }, 300);
    expect(resumed.passed).toBe(29);

    const stuck = await sweep({ seekStuckZeroRate: true }, 100);
    expect(reasons(stuck)).toEqual({
      'vod-200010-hls': 'seek to 30000 ms not confirmed (clock at 30000 ms, rate 0)',
    });
  });

  it('fails a seek that lands far past the target', async () => {
    const report = await sweep({ seekLandsAt: (target) => target + 60_000 });
    expect(reasons(report)).toEqual({
      'vod-200010-hls': 'seek to 30000 ms not confirmed (clock at 90000 ms, rate 1)',
    });
  });

  it('fails a seek fast when the media ends', async () => {
    const report = await sweep({ seekEnds: true }, 10_000);
    expect(reasons(report)).toEqual({
      'vod-200010-hls': 'seek to 30000 ms failed (settled on ended)',
    });
  });

  it('dispose resolves a pending wait and leaves no timer behind', async () => {
    const { engine } = makeEngine({ neverPlays: true });
    const timers = realTimers();
    const run = createCorpusRun({
      engine,
      base: BASE,
      account: 'demo',
      now: () => performance.now(),
      later: timers.later,
      holdMs: 3,
      itemTimeoutMs: 60_000,
    });
    const started = run.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    run.dispose();
    const report = await started;
    expect(report.passed).toBe(0);
    expect(timers.active()).toBe(0);
  });

  it('dispose during a hold resolves the sleep and leaves no timer behind', async () => {
    const { engine } = makeEngine();
    const timers = realTimers();
    const run = createCorpusRun({
      engine,
      base: BASE,
      account: 'demo',
      now: () => performance.now(),
      later: timers.later,
      holdMs: 60_000,
      itemTimeoutMs: 200,
    });
    const started = run.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    run.dispose();
    await started;
    expect(timers.active()).toBe(0);
  });
});

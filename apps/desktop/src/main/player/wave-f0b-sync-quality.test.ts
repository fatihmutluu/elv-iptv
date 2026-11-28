import type { EngineEvent, MediaTracks } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_CAPABILITIES,
  isPlayerCommandMessage,
  PLAYER_CHANNELS,
} from '../../shared/player-ipc.ts';
import { createMpvEngine, type MpvEngine, type MpvEngineDeps } from './engine.ts';
import { type IpcMainLike, registerPlayerIpc, type WebContentsLike } from './ipc.ts';
import type { MpvClient } from './mpv/client.ts';
import { createFakeMpv, type FakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import { LAUNCH_OPTIONS } from './mpv/options.ts';
import { OBSERVED_PROPERTIES, TRACK_PROPERTIES } from './mpv/session-constants.ts';
import {
  inspectMpvTracks,
  parseMpvDelayMs,
  parseSecondarySubtitleTrackCommand,
  parseVideoQualityCommand,
} from './mpv/track-snapshot.ts';
import type { VideoPresenter } from './presenter/types.ts';

const URL_HLS = 'http://sim.test/live/demo/demo/master.m3u8';
const URL_NEXT = 'http://sim.test/live/demo/demo/next.ts';

const HLS_MULTI_VARIANT_SCRIPT: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  {
    afterMs: 2,
    property: 'track-list',
    value: [
      {
        id: 1,
        type: 'video',
        'demux-w': 1280,
        'demux-h': 720,
        'hls-bitrate': 3_000_000,
        'demux-fps': 30,
        codec: 'h264',
        selected: true,
      },
      {
        id: 2,
        type: 'video',
        'demux-w': 1920,
        'demux-h': 1080,
        'hls-bitrate': 6_000_000,
        'demux-fps': 60,
        codec: 'h264',
        selected: false,
      },
      {
        id: 3,
        type: 'video',
        'demux-w': 854,
        'demux-h': 480,
        'demux-bitrate': 1_200_000,
        codec: 'h264',
        selected: false,
      },
      {
        id: 4,
        type: 'video',
        albumart: true,
        'demux-w': 600,
        'demux-h': 600,
        codec: 'mjpeg',
        selected: false,
      },
      { id: 1, type: 'audio', lang: 'eng', title: 'English', codec: 'aac', selected: true },
      { id: 1, type: 'sub', lang: 'eng', title: 'English', codec: 'webvtt', selected: true },
      { id: 2, type: 'sub', lang: 'tur', title: 'Turkish', codec: 'webvtt', selected: false },
    ],
  },
  { afterMs: 2, property: 'aid', value: 1 },
  { afterMs: 2, property: 'sid', value: 1 },
  { afterMs: 2, property: 'secondary-sid', value: false },
  { afterMs: 2, property: 'audio-delay', value: null },
  { afterMs: 2, property: 'sub-delay', value: Number.NaN },
  { afterMs: 4, event: 'file-loaded' },
  { afterMs: 5, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 8, property: 'time-pos', value: 1.0 },
  { afterMs: 8, event: 'playback-restart' },
];

const NEXT_STREAM_SCRIPT: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  {
    afterMs: 2,
    property: 'track-list',
    value: [
      { id: 1, type: 'video', 'demux-w': 1920, 'demux-h': 1080, codec: 'h264', selected: true },
      { id: 1, type: 'audio', lang: 'eng', codec: 'aac', selected: true },
      { id: 1, type: 'sub', lang: 'eng', codec: 'subrip', selected: true },
      { id: 2, type: 'sub', lang: 'tur', codec: 'subrip', selected: false },
    ],
  },
  { afterMs: 4, event: 'file-loaded' },
  { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
  { afterMs: 8, property: 'time-pos', value: 1.0 },
  { afterMs: 8, event: 'playback-restart' },
];

const timers: MpvEngineDeps['timers'] = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function stubPresenter(onAttach: (client: MpvClient) => void): VideoPresenter {
  return {
    kind: 'child-window',
    coversArea: true,
    prepare: async () => ['--wid=4660'],
    attach: onAttach,
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    onEvent: () => () => undefined,
    dispose: () => undefined,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setupEngine() {
  const fake: FakeMpv = createFakeMpv({
    scripts: { [URL_HLS]: HLS_MULTI_VARIANT_SCRIPT, [URL_NEXT]: NEXT_STREAM_SCRIPT },
    transport: 'socket',
  });
  let client: MpvClient | undefined;
  const engine = createMpvEngine({
    spawn: (args, signal) => fake.spawn(args, signal),
    presenter: stubPresenter((c) => {
      client = c;
    }),
    baseArgs: LAUNCH_OPTIONS,
    loadMode: 'replace',
    now: () => Date.now(),
    timers,
    onUi: () => undefined,
  });
  const events: EngineEvent[] = [];
  engine.subscribe((event) => events.push(event));
  cleanups.push(async () => {
    engine.release();
    await fake.dispose();
  });
  await vi.waitFor(() => {
    expect(fake.sent).toContainEqual(['request_log_messages', 'v']);
    expect(client).toBeDefined();
  });
  return { fake, engine, events, getClient: () => client };
}

const latestTracks = (events: readonly EngineEvent[]): MediaTracks | undefined => {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ev = events[i];
    if (ev?.type === 'tracks') return ev.tracks;
  }
  return undefined;
};

describe('Wave F0B desktop mpv observation, snapshot, and options (#59, #239)', () => {
  it('observes sub-delay, audio-delay, and secondary-sid and resets them on next file', () => {
    expect(OBSERVED_PROPERTIES).toContain('sub-delay');
    expect(OBSERVED_PROPERTIES).toContain('audio-delay');
    expect(OBSERVED_PROPERTIES).toContain('secondary-sid');
    expect(TRACK_PROPERTIES.has('secondary-sid')).toBe(true);

    const resetArg = LAUNCH_OPTIONS.find((arg) => arg.startsWith('--reset-on-next-file='));
    expect(resetArg).toBeDefined();
    const resetProps = new Set(resetArg?.slice('--reset-on-next-file='.length).split(','));
    expect(resetProps.has('audio-delay')).toBe(true);
    expect(resetProps.has('sub-delay')).toBe(true);
    expect(resetProps.has('secondary-sid')).toBe(true);
  });

  it('converts observed mpv delay seconds to clamped ms and ignores null/non-finite values', () => {
    expect(parseMpvDelayMs(0.25)).toBe(250);
    expect(parseMpvDelayMs(-1.5)).toBe(-1500);
    expect(parseMpvDelayMs(0)).toBe(0);
    expect(parseMpvDelayMs(45)).toBe(30_000);
    expect(parseMpvDelayMs(-99)).toBe(-30_000);
    expect(parseMpvDelayMs(null)).toBeUndefined();
    expect(parseMpvDelayMs(undefined)).toBeUndefined();
    expect(parseMpvDelayMs(Number.NaN)).toBeUndefined();
    expect(parseMpvDelayMs(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(parseMpvDelayMs('0.5')).toBeUndefined();
  });

  it('extracts sorted deduplicated videoQualities (skipping albumart) and enforces primary !== secondary', () => {
    const trackList = [
      {
        id: 1,
        type: 'video',
        'demux-w': 1280,
        'demux-h': 720,
        'hls-bitrate': 3_000_000,
        'demux-fps': 30,
        codec: 'h264',
      },
      {
        id: 2,
        type: 'video',
        'demux-w': 1920,
        'demux-h': 1080,
        'hls-bitrate': 6_000_000,
        'demux-fps': 60,
        codec: 'h264',
      },
      {
        id: 3,
        type: 'video',
        'demux-w': 1920,
        'demux-h': 1080,
        'hls-bitrate': 6_000_000,
        'demux-fps': 30,
        codec: 'h264',
      },
      { id: 4, type: 'video', 'demux-bitrate': 900_000, codec: 'hevc' },
      { id: 5, type: 'video', codec: 'vp9' },
      { id: 6, type: 'video', albumart: true, 'demux-w': 500, 'demux-h': 500 },
      { id: 1, type: 'sub', lang: 'eng', title: 'English' },
      { id: 2, type: 'sub', lang: 'tur', title: 'Turkish' },
    ];

    const autoSnap = inspectMpvTracks(trackList, 'auto', 1, 2, null);
    expect(autoSnap.selectedSubtitleId).toBe('s:1');
    expect(autoSnap.selectedSecondarySubtitleId).toBe('s:2');
    expect(autoSnap.selectedVideoQualityId).toBeNull();
    expect(autoSnap.videoQualities).toEqual([
      { id: '2', label: '1080p', width: 1920, height: 1080, bitrateBps: 6_000_000, fps: 60 },
      { id: '1', label: '720p', width: 1280, height: 720, bitrateBps: 3_000_000, fps: 30 },
      { id: '4', label: '900 kbps', bitrateBps: 900_000 },
      { id: '5', label: 'VP9' },
    ]);

    const collisionSnap = inspectMpvTracks(trackList, 'auto', 1, 1, '1');
    expect(collisionSnap.selectedSubtitleId).toBe('s:1');
    expect(collisionSnap.selectedSecondarySubtitleId).toBeUndefined();
    expect(collisionSnap.selectedVideoQualityId).toBe('1');
  });

  it('validates secondary subtitle and video quality mpv command builders', () => {
    expect(parseSecondarySubtitleTrackCommand('s:2')).toEqual(['set_property', 'secondary-sid', 2]);
    expect(parseSecondarySubtitleTrackCommand(null)).toEqual([
      'set_property',
      'secondary-sid',
      'no',
    ]);
    expect(parseSecondarySubtitleTrackCommand('a:1')).toBeUndefined();
    expect(parseSecondarySubtitleTrackCommand('s:0')).toBeUndefined();

    expect(parseVideoQualityCommand('2')).toEqual(['set_property', 'vid', 2]);
    expect(parseVideoQualityCommand(null)).toEqual(['set_property', 'vid', 'auto']);
    expect(parseVideoQualityCommand('0')).toBeUndefined();
    expect(parseVideoQualityCommand('v:2')).toBeUndefined();
  });
});

describe('Wave F0B MpvEngine live delay, secondary-sid, and video quality (#59, #239)', () => {
  it('converts ms delays to seconds, clamps to +-30s, guards secondary-sid, and switches vid/auto', async () => {
    const { fake, engine, events, getClient } = await setupEngine();
    engine.load({ attempt: 1, url: URL_HLS, headers: {}, kind: 'live' });

    await vi.waitFor(() => {
      const tracks = latestTracks(events);
      expect(tracks?.videoQualities?.map((q) => q.id)).toEqual(['2', '1', '3']);
      expect(tracks?.selectedVideoQualityId).toBeNull();
    });

    // Audio & subtitle delay via PlayerEngine (attempt, delayMs) contract
    engine.setAudioDelay(2, 250);
    engine.setAudioDelay(2, 45_000);
    engine.setSubtitleDelay(2, -750);
    engine.setSubtitleDelay(2, -50_000);
    await vi.waitFor(() => {
      expect(fake.sent).toContainEqual(['set_property', 'audio-delay', 0.25]);
      expect(fake.sent).toContainEqual(['set_property', 'audio-delay', 30]);
      expect(fake.sent).toContainEqual(['set_property', 'sub-delay', -0.75]);
      expect(fake.sent).toContainEqual(['set_property', 'sub-delay', -30]);
    });

    // Secondary subtitle guard: rejecting same track as primary ('s:1')
    engine.selectSecondarySubtitleTrack?.(3, 's:1');
    engine.selectSecondarySubtitleTrack?.(3, 's:2');
    await vi.waitFor(() => {
      expect(fake.sent).toContainEqual(['set_property', 'secondary-sid', 2]);
      expect(latestTracks(events)?.selectedSecondarySubtitleId).toBe('s:2');
    });
    expect(fake.sent).not.toContainEqual(['set_property', 'secondary-sid', 1]);

    // Manual video quality selection and return to Auto
    engine.selectVideoQuality?.(4, '2');
    await vi.waitFor(() => {
      expect(fake.sent).toContainEqual(['set_property', 'vid', 2]);
      expect(latestTracks(events)?.selectedVideoQualityId).toBe('2');
    });

    engine.selectVideoQuality?.(5, null);
    await vi.waitFor(() => {
      expect(fake.sent).toContainEqual(['set_property', 'vid', 'auto']);
      expect(latestTracks(events)?.selectedVideoQualityId).toBeNull();
    });

    // Zapping to next stream resets audio-delay, sub-delay, and secondary-sid via --reset-on-next-file
    engine.load({ attempt: 6, url: URL_NEXT, headers: {}, kind: 'live' });
    await vi.waitFor(() => {
      expect(latestTracks(events)?.videoQualities).toBeUndefined();
    });
    const client = getClient();
    expect((await client?.command(['get_property', 'audio-delay']))?.data).toBe(0);
    expect((await client?.command(['get_property', 'sub-delay']))?.data).toBe(0);
    expect((await client?.command(['get_property', 'secondary-sid']))?.data).toBe('no');
  });

  it('re-applies live audio/subtitle delays and manual video quality after retry() despite --reset-on-next-file', async () => {
    const { fake, engine, events, getClient } = await setupEngine();
    engine.load({ attempt: 1, url: URL_HLS, headers: {}, kind: 'live' });

    await vi.waitFor(() => {
      expect(latestTracks(events)?.videoQualities?.map((q) => q.id)).toEqual(['2', '1', '3']);
    });

    engine.setAudioDelay(1, 350);
    engine.setSubtitleDelay(1, -200);
    engine.selectVideoQuality?.(1, '2');
    await vi.waitFor(() => {
      expect(fake.sent).toContainEqual(['set_property', 'audio-delay', 0.35]);
      expect(fake.sent).toContainEqual(['set_property', 'sub-delay', -0.2]);
      expect(fake.sent).toContainEqual(['set_property', 'vid', 2]);
    });

    const sentCountBeforeRetry = fake.sent.length;
    engine.retry(2);

    await vi.waitFor(() => {
      const afterRetry = fake.sent.slice(sentCountBeforeRetry);
      expect(afterRetry).toContainEqual(['set_property', 'audio-delay', 0.35]);
      expect(afterRetry).toContainEqual(['set_property', 'sub-delay', -0.2]);
      expect(afterRetry).toContainEqual(['set_property', 'vid', 2]);
    });

    const client = getClient();
    await vi.waitFor(async () => {
      expect((await client?.command(['get_property', 'audio-delay']))?.data).toBe(0.35);
      expect((await client?.command(['get_property', 'sub-delay']))?.data).toBe(-0.2);
      expect((await client?.command(['get_property', 'vid']))?.data).toBe(2);
      expect(latestTracks(events)?.selectedVideoQualityId).toBe('2');
    });
  });
});

describe('Wave F0B IPC validation and dispatch (#59, #239)', () => {
  it('validates and dispatches selectSecondarySubtitleTrack, selectVideoQuality, and attempt-tagged delays', async () => {
    const valid = [
      { engineId: 'e1', command: { name: 'selectSecondarySubtitleTrack', attempt: 1, id: 's:2' } },
      { engineId: 'e1', command: { name: 'selectSecondarySubtitleTrack', attempt: 2, id: null } },
      { engineId: 'e1', command: { name: 'selectVideoQuality', attempt: 3, id: '2' } },
      { engineId: 'e1', command: { name: 'selectVideoQuality', attempt: 4, id: null } },
      { engineId: 'e1', command: { name: 'setAudioDelay', attempt: 5, delaySec: 0.25 } },
      { engineId: 'e1', command: { name: 'setSubtitleDelay', attempt: 6, delaySec: -0.5 } },
    ];
    for (const msg of valid) expect(isPlayerCommandMessage(msg)).toBe(true);

    const invalid = [
      { engineId: 'e1', command: { name: 'selectSecondarySubtitleTrack', attempt: 1, id: 'a:1' } },
      { engineId: 'e1', command: { name: 'selectSecondarySubtitleTrack', attempt: -1, id: null } },
      { engineId: 'e1', command: { name: 'selectVideoQuality', attempt: 1, id: '0' } },
      { engineId: 'e1', command: { name: 'selectVideoQuality', attempt: 1, id: '1080p' } },
      { engineId: 'e1', command: { name: 'setAudioDelay', attempt: -1, delaySec: 0.25 } },
      { engineId: 'e1', command: { name: 'setSubtitleDelay', attempt: 1, delaySec: 31 } },
    ];
    for (const msg of invalid) expect(isPlayerCommandMessage(msg)).toBe(false);

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain: IpcMainLike = {
      handle: (ch, fn) => void handlers.set(ch, fn as (...args: unknown[]) => unknown),
      on: (ch, fn) => void listeners.set(ch, fn as (...args: unknown[]) => unknown),
      removeHandler: (ch) => void handlers.delete(ch),
      removeListener: (ch) => void listeners.delete(ch),
    };
    const owner: WebContentsLike = {
      id: 1,
      isDestroyed: () => false,
      send: () => undefined,
      once: () => undefined,
      on: () => undefined,
    };
    const calls: unknown[][] = [];
    const stubEngine: MpvEngine = {
      capabilities: DESKTOP_CAPABILITIES,
      spawns: 0,
      maxHoldMs: 0,
      loadMode: 'replace',
      presenterKind: 'canvas',
      lastArea: undefined,
      start: () => undefined,
      setArea: () => undefined,
      toggleFullscreen: () => undefined,
      toggleMute: () => undefined,
      setVolume: () => undefined,
      setAudioDelay: (...args: unknown[]) => void calls.push(['setAudioDelay', ...args]),
      setSubtitleDelay: (...args: unknown[]) => void calls.push(['setSubtitleDelay', ...args]),
      setAudioDevice: () => undefined,
      setDeinterlace: () => undefined,
      setDeinterlaceMode: () => undefined,
      setPitchLock: () => undefined,
      setAudioNormalization: () => undefined,
      queueNext: () => undefined,
      clearQueue: () => undefined,
      onQueueAdvanced: () => () => undefined,
      setHwdec: () => undefined,
      setResizeMode: () => undefined,
      setFilterSdh: () => undefined,
      setSubtitleFontFamily: () => undefined,
      load: () => undefined,
      retry: () => undefined,
      play: () => undefined,
      pause: () => undefined,
      seek: () => undefined,
      selectSecondarySubtitleTrack: (attempt, id) =>
        void calls.push(['selectSecondarySubtitleTrack', attempt, id]),
      selectVideoQuality: (attempt, id) => void calls.push(['selectVideoQuality', attempt, id]),
      stop: () => undefined,
      recreate: () => undefined,
      release: () => undefined,
      subscribe: () => () => undefined,
    };

    const dispose = registerPlayerIpc({
      ipcMain,
      createEngine: async () => stubEngine,
      now: () => 0,
      log: () => undefined,
    });
    const openFn = handlers.get(PLAYER_CHANNELS.open);
    if (!openFn) throw new Error('expected open handler');
    const senderFrame: { url: string; top?: unknown } = { url: 'app://elv/index.html' };
    senderFrame.top = senderFrame;
    const { engineId } = (await openFn({ sender: owner, senderFrame })) as { engineId: string };
    const cmdFn = listeners.get(PLAYER_CHANNELS.command);
    for (const msg of valid) cmdFn?.({ sender: owner, senderFrame }, { ...msg, engineId });
    dispose();

    expect(calls).toEqual([
      ['selectSecondarySubtitleTrack', 1, 's:2'],
      ['selectSecondarySubtitleTrack', 2, null],
      ['selectVideoQuality', 3, '2'],
      ['selectVideoQuality', 4, null],
      ['setAudioDelay', 5, 250],
      ['setSubtitleDelay', 6, -500],
    ]);
  });
});

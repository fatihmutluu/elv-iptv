import type { EngineEvent, MediaTracks, PlayerEngine } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_CAPABILITIES } from '../../shared/player-ipc.ts';
import { createMpvEngine, type MpvEngineDeps } from './engine.ts';
import { createFakeMpv, type FakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import type { VideoPresenter } from './presenter/types.ts';

const URL_MULTI = 'http://sim.test/movie/demo/demo/200011.mkv';

const MULTI_TRACK_VOD: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  {
    afterMs: 2,
    property: 'track-list',
    value: [
      { id: 1, type: 'video', codec: 'h264', selected: true },
      {
        id: 1,
        type: 'audio',
        lang: 'tur',
        title: 'Turkish',
        codec: 'aac',
        'demux-channel-count': 2,
        default: true,
        selected: true,
      },
      {
        id: 2,
        type: 'audio',
        lang: 'eng',
        title: 'English',
        codec: 'aac',
        'demux-channel-count': 2,
        selected: false,
      },
      { id: 1, type: 'sub', lang: 'tur', title: 'Turkish SRT', codec: 'subrip', selected: true },
      { id: 2, type: 'sub', lang: 'eng', title: 'English SRT', codec: 'subrip', selected: false },
    ],
  },
  { afterMs: 2, property: 'aid', value: 1 },
  { afterMs: 2, property: 'sid', value: 1 },
  { afterMs: 4, event: 'file-loaded' },
  { afterMs: 5, property: 'duration', value: 60 },
  { afterMs: 5, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 8, property: 'time-pos', value: 5.0 },
  { afterMs: 8, event: 'playback-restart' },
];

const timers: MpvEngineDeps['timers'] = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function stubPresenter(): VideoPresenter {
  return {
    kind: 'child-window',
    coversArea: true,
    prepare: async () => ['--wid=4660'],
    attach: () => undefined,
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    onEvent: () => () => undefined,
    dispose: () => undefined,
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(scripts: Record<string, FakeMpvScript> = { [URL_MULTI]: MULTI_TRACK_VOD }) {
  const fake: FakeMpv = createFakeMpv({ scripts, transport: 'socket' });
  const engine: PlayerEngine = createMpvEngine({
    spawn: (args, signal) => fake.spawn(args, signal),
    presenter: stubPresenter(),
    baseArgs: ['--no-config', '--idle=yes'],
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
  await vi.waitFor(() => expect(fake.sent).toContainEqual(['request_log_messages', 'v']));
  return { fake, engine, events };
}

const tracksEvents = (
  events: readonly EngineEvent[],
): Array<{ attempt: number; tracks: MediaTracks }> =>
  events.flatMap((e) => (e.type === 'tracks' ? [{ attempt: e.attempt, tracks: e.tracks }] : []));

describe('MpvEngine audio and subtitle track selection', () => {
  it('reports audioTrackSelection and subtitleTrackSelection capabilities', () => {
    expect(DESKTOP_CAPABILITIES.audioTrackSelection).toBe(true);
    expect(DESKTOP_CAPABILITIES.subtitleTrackSelection).toBe(true);
  });

  it('emits deduplicated tracks events and switches aid and sid (including Off)', async () => {
    const { fake, engine, events } = await setup();
    engine.load({ attempt: 1, url: URL_MULTI, headers: {}, kind: 'vod' });

    await vi.waitFor(() =>
      expect(tracksEvents(events).at(-1)?.tracks).toMatchObject({
        selectedAudioId: 'a:1',
        selectedSubtitleId: 's:1',
      }),
    );

    engine.selectAudioTrack?.(2, 'a:2');
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['set_property', 'aid', 2]));
    await vi.waitFor(() =>
      expect(tracksEvents(events).at(-1)).toMatchObject({
        attempt: 2,
        tracks: { selectedAudioId: 'a:2' },
      }),
    );

    engine.selectSubtitleTrack?.(3, null);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['set_property', 'sid', 'no']));
    await vi.waitFor(() =>
      expect(tracksEvents(events).at(-1)).toMatchObject({
        attempt: 3,
        tracks: { selectedAudioId: 'a:2', selectedSubtitleId: null },
      }),
    );
  });

  it('re-applies chosen audio and subtitle tracks across retry and LoadCommand.options reloads', async () => {
    const { fake, engine, events } = await setup();
    engine.load({ attempt: 1, url: URL_MULTI, headers: {}, kind: 'vod' });
    await vi.waitFor(() =>
      expect(
        events.some((e) => e.attempt === 1 && e.type === 'state' && e.state === 'playing'),
      ).toBe(true),
    );

    engine.selectAudioTrack?.(2, 'a:2');
    engine.selectSubtitleTrack?.(2, null);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['set_property', 'sid', 'no']));

    const beforeRetry = fake.sent.length;
    engine.retry(3);
    await vi.waitFor(() =>
      expect(
        events.some((e) => e.attempt === 3 && e.type === 'state' && e.state === 'playing'),
      ).toBe(true),
    );
    const retryCommands = fake.sent.slice(beforeRetry);
    expect(retryCommands).toContainEqual(['set_property', 'aid', 2]);
    expect(retryCommands).toContainEqual(['set_property', 'sid', 'no']);
    expect(tracksEvents(events).at(-1)).toMatchObject({
      attempt: 3,
      tracks: { selectedAudioId: 'a:2', selectedSubtitleId: null },
    });

    // Also honors explicit LoadCommand.options on service-driven recovery reload
    const beforeReload = fake.sent.length;
    engine.load({
      attempt: 4,
      url: URL_MULTI,
      headers: {},
      kind: 'vod',
      startMs: 5_000,
      options: { audioTrackId: 'a:2', subtitleTrackId: 's:2' },
    });
    await vi.waitFor(() =>
      expect(tracksEvents(events).at(-1)).toMatchObject({
        attempt: 4,
        tracks: { selectedAudioId: 'a:2', selectedSubtitleId: 's:2' },
      }),
    );
    const reloadCommands = fake.sent.slice(beforeReload);
    expect(reloadCommands).toContainEqual(['set_property', 'aid', 2]);
    expect(reloadCommands).toContainEqual(['set_property', 'sid', 2]);
  });
});

import type { EngineEvent, MediaTracks, PlayerEngine } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESKTOP_CAPABILITIES } from '../../shared/player-ipc.ts';
import { createMpvEngine, type MpvEngineDeps } from './engine.ts';
import type { MpvClient } from './mpv/client.ts';
import { createFakeMpv, type FakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import { LAUNCH_OPTIONS } from './mpv/options.ts';
import type { VideoPresenter } from './presenter/types.ts';

const URL_MULTI = 'http://sim.test/movie/demo/demo/200011.mkv';
const URL_CH_B = 'http://sim.test/live/demo/demo/1002.ts';

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

async function setup(
  scripts: Record<string, FakeMpvScript> = { [URL_MULTI]: MULTI_TRACK_VOD },
  baseArgs: readonly string[] = LAUNCH_OPTIONS,
) {
  const fake: FakeMpv = createFakeMpv({ scripts, transport: 'socket' });
  let client: MpvClient | undefined;
  const engine: PlayerEngine = createMpvEngine({
    spawn: (args, signal) => fake.spawn(args, signal),
    presenter: stubPresenter((c) => {
      client = c;
    }),
    baseArgs,
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
  await client?.command(['get_property', 'pause']);
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
    await vi.waitFor(() => {
      const retryCommands = fake.sent.slice(beforeRetry);
      expect(retryCommands).toContainEqual(['set_property', 'aid', 2]);
      expect(retryCommands).toContainEqual(['set_property', 'sid', 'no']);
      expect(tracksEvents(events).at(-1)).toMatchObject({
        attempt: 3,
        tracks: { selectedAudioId: 'a:2', selectedSubtitleId: null },
      });
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

  it('never leaks a:2 or sid="no" from Channel A to Channel B thanks to --reset-on-next-file', async () => {
    const channelBScript: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      {
        afterMs: 2,
        property: 'track-list',
        value: [
          { id: 1, type: 'video', codec: 'h264', selected: true },
          { id: 1, type: 'audio', lang: 'tur', title: 'ChB Audio 1', selected: true },
          { id: 2, type: 'audio', lang: 'eng', title: 'ChB Audio 2', selected: false },
          { id: 1, type: 'sub', lang: 'tur', title: 'ChB Sub 1', selected: true },
        ],
      },
      { afterMs: 4, event: 'file-loaded' },
      { afterMs: 5, property: 'video-params', value: { w: 1280, h: 720 } },
      { afterMs: 8, event: 'playback-restart' },
    ];

    // 1. Prove FakeMpv leaks aid/sid when --reset-on-next-file is omitted:
    const leaky = await setup({ [URL_MULTI]: MULTI_TRACK_VOD, [URL_CH_B]: channelBScript }, [
      '--no-config',
      '--idle=yes',
    ]);
    leaky.engine.load({ attempt: 1, url: URL_MULTI, headers: {}, kind: 'live' });
    await vi.waitFor(() => expect(tracksEvents(leaky.events)).toHaveLength(1));
    leaky.engine.selectAudioTrack?.(2, 'a:2');
    leaky.engine.selectSubtitleTrack?.(2, null);
    await vi.waitFor(() => expect(leaky.fake.sent).toContainEqual(['set_property', 'sid', 'no']));

    leaky.engine.load({ attempt: 3, url: URL_CH_B, headers: {}, kind: 'live' });
    await vi.waitFor(() =>
      expect(tracksEvents(leaky.events).some((e) => e.attempt === 3)).toBe(true),
    );
    expect(tracksEvents(leaky.events).at(-1)?.tracks).toMatchObject({
      selectedAudioId: 'a:2',
      selectedSubtitleId: null,
    });

    // 2. Prove LAUNCH_OPTIONS (--reset-on-next-file=aid,sid,...) resets cleanly for Channel B:
    const clean = await setup({ [URL_MULTI]: MULTI_TRACK_VOD, [URL_CH_B]: channelBScript });
    clean.engine.load({ attempt: 1, url: URL_MULTI, headers: {}, kind: 'live' });
    await vi.waitFor(() => expect(tracksEvents(clean.events)).toHaveLength(1));
    clean.engine.selectAudioTrack?.(2, 'a:2');
    clean.engine.selectSubtitleTrack?.(2, null);
    await vi.waitFor(() => expect(clean.fake.sent).toContainEqual(['set_property', 'sid', 'no']));

    clean.engine.load({ attempt: 3, url: URL_CH_B, headers: {}, kind: 'live' });
    await vi.waitFor(() =>
      expect(tracksEvents(clean.events).some((e) => e.attempt === 3)).toBe(true),
    );
    expect(tracksEvents(clean.events).at(-1)?.tracks).toMatchObject({
      selectedAudioId: 'a:1',
      selectedSubtitleId: 's:1',
    });
  });

  it('does not adopt attempt token when selectAudioTrack or selectSubtitleTrack receives an invalid id', async () => {
    const { engine, events } = await setup();
    engine.load({ attempt: 1, url: URL_MULTI, headers: {}, kind: 'vod' });
    await vi.waitFor(() =>
      expect(
        events.some((e) => e.attempt === 1 && e.type === 'state' && e.state === 'playing'),
      ).toBe(true),
    );

    engine.selectAudioTrack?.(99, 'bad-id');
    engine.selectSubtitleTrack?.(100, 'bad-sub');
    engine.pause(2);
    await vi.waitFor(() =>
      expect(events.some((e) => e.type === 'state' && e.state === 'paused')).toBe(true),
    );
    expect(events.some((e) => e.attempt === 99 || e.attempt === 100)).toBe(false);
  });

  it('purges queued track commands when a superseding load arrives before they run', async () => {
    const channelBScript: FakeMpvScript = [
      { afterMs: 0, event: 'start-file' },
      { afterMs: 4, event: 'file-loaded' },
      { afterMs: 5, property: 'video-params', value: { w: 1280, h: 720 } },
      { afterMs: 8, event: 'playback-restart' },
    ];
    const { fake, engine, events } = await setup({
      [URL_MULTI]: MULTI_TRACK_VOD,
      [URL_CH_B]: channelBScript,
    });
    fake.replyDelayMs = 80;

    engine.load({ attempt: 1, url: URL_MULTI, headers: {}, kind: 'live' });
    engine.selectAudioTrack?.(2, 'a:2');
    engine.load({ attempt: 3, url: URL_CH_B, headers: {}, kind: 'live' });

    await vi.waitFor(() =>
      expect(
        events.some((e) => e.attempt === 3 && e.type === 'state' && e.state === 'playing'),
      ).toBe(true),
    );
    expect(fake.sent).not.toContainEqual(['set_property', 'aid', 2]);
  });

  it('re-initializes audio via ao-reload after debounced audio-device-list change (#110)', async () => {
    const hotplugScript: FakeMpvScript = [
      ...MULTI_TRACK_VOD,
      { afterMs: 10, property: 'audio-device-list', value: [{ name: 'auto' }, { name: 'spk' }] },
      { afterMs: 20, property: 'audio-device-list', value: [{ name: 'auto' }, { name: 'hdmi' }] },
    ];
    const { fake, engine } = await setup({ [URL_MULTI]: hotplugScript });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    engine.load({ attempt: 1, url: URL_MULTI, headers: {}, kind: 'vod' });

    const until = async (check: () => boolean): Promise<void> => {
      for (let i = 0; i < 20000 && !check(); i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      expect(check()).toBe(true);
    };

    await until(() => fake.sent.some((c) => c[0] === 'loadfile'));
    await vi.advanceTimersByTimeAsync(25);
    await until(() => vi.getTimerCount() > 0);
    await vi.advanceTimersByTimeAsync(500);
    await until(() => fake.sent.some((c) => c[0] === 'ao-reload'));
    expect(fake.sent).toContainEqual(['ao-reload']);
  });

  it('resets speed, deinterlace, aspect override and delays on next file in FakeMpv (#434)', async () => {
    const { fake, engine, events } = await setup({
      [URL_MULTI]: MULTI_TRACK_VOD,
      [URL_CH_B]: MULTI_TRACK_VOD,
    });
    const client = await (async () => {
      let c: MpvClient | undefined;
      const e2 = createMpvEngine({
        spawn: (args, signal) => fake.spawn(args, signal),
        presenter: stubPresenter((cl) => {
          c = cl;
        }),
        baseArgs: LAUNCH_OPTIONS,
        loadMode: 'replace',
        now: () => Date.now(),
        timers,
        onUi: () => undefined,
      });
      cleanups.push(async () => e2.release());
      await vi.waitFor(() => expect(c).toBeDefined());
      const ev2: EngineEvent[] = [];
      e2.subscribe((ev) => ev2.push(ev));
      e2.load({ attempt: 1, url: URL_MULTI, headers: {}, kind: 'vod' });
      await vi.waitFor(() =>
        expect(
          ev2.some((e) => e.attempt === 1 && e.type === 'state' && e.state === 'playing'),
        ).toBe(true),
      );
      e2.setSpeed?.(1, 2);
      await c?.command(['set_property', 'deinterlace', 'yes']);
      e2.setAudioDelay(0.5);
      e2.setSubtitleDelay(-0.25);
      await c?.command(['set_property', 'video-aspect-override', '16:9']);
      await vi.waitFor(() =>
        expect(fake.sent).toContainEqual(['set_property', 'sub-delay', -0.25]),
      );

      e2.load({ attempt: 2, url: URL_CH_B, headers: {}, kind: 'vod' });
      await vi.waitFor(() =>
        expect(
          ev2.some((e) => e.attempt === 2 && e.type === 'state' && e.state === 'playing'),
        ).toBe(true),
      );
      return c;
    })();
    void engine;
    void events;

    expect((await client?.command(['get_property', 'speed']))?.data).toBe(1);
    expect((await client?.command(['get_property', 'deinterlace']))?.data).toBe('no');
    expect((await client?.command(['get_property', 'video-aspect-override']))?.data).toBe('-1');
    expect((await client?.command(['get_property', 'audio-delay']))?.data).toBe(0);
    expect((await client?.command(['get_property', 'sub-delay']))?.data).toBe(0);
  });
});

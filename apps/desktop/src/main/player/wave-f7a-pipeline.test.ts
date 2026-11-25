import type { DesktopAudioOutputConfig, DisplaySyncPolicy, EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMpvEngine, type MpvEngineDeps } from './engine.ts';
import { LOUDNORM_FILTER } from './engine-controls.ts';
import { playing, setupEngineTest, sleep } from './engine-test-helpers.ts';
import { AC3_ENCODE_FILTER, AC3_ENCODE_LABEL } from './mpv/audio-output.ts';
import { createFakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import { LAUNCH_OPTIONS } from './mpv/options.ts';
import type { VideoPresenter } from './presenter/types.ts';

const URL_VOD = 'http://sim.test/vod/demo/movie.mkv';
const URL_LIVE = 'http://sim.test/live/demo/1001.ts';

const HOLD_SCRIPT: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 4, property: 'duration', value: 1200 },
  { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
  { afterMs: 6, property: 'time-pos', value: 1 },
  { afterMs: 7, event: 'playback-restart' },
];

const PASSTHROUGH_FAIL_SCRIPT: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 4, property: 'duration', value: 1200 },
  { afterMs: 5, property: 'video-params', value: { w: 1920, h: 1080 } },
  { afterMs: 6, property: 'time-pos', value: 1 },
  { afterMs: 7, event: 'playback-restart' },
  {
    afterMs: 15,
    log: {
      prefix: 'ao/wasapi',
      level: 'error',
      text: 'Device does not support format (AUDCLNT_E_UNSUPPORTED_FORMAT)',
    },
  },
  {
    afterMs: 20,
    log: {
      prefix: 'ao',
      level: 'error',
      text: 'Could not open/initialize audio device -> no sound.',
    },
  },
];

const timers: MpvEngineDeps['timers'] = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

function stubPresenter(): VideoPresenter {
  return {
    kind: 'canvas',
    coversArea: false,
    prepare: async () => [],
    attach: () => undefined,
    setArea: () => undefined,
    toggleFullscreen: () => undefined,
    onEvent: () => () => undefined,
    dispose: () => undefined,
  };
}

describe('Wave F7A #213 & #214: mpv audio passthrough, AC3 encode, PCM fallback, and video-sync', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0).reverse()) await c();
  });

  it('applies audio-spdif, audio-exclusive, audio-channels, and @ac3:lavcac3enc without clobbering af', async () => {
    const { engine, fake, events } = await setupEngineTest(cleanups, {
      scripts: { [URL_VOD]: HOLD_SCRIPT },
    });
    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);

    const passthroughCfg: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3', 'eac3', 'dts'],
      exclusive: true,
      ac3Encode: false,
      channelLayout: 'auto',
    };
    engine.setDesktopAudioOutput?.(passthroughCfg);
    await vi.waitFor(() =>
      expect(fake.sent).toContainEqual(['set_property', 'audio-spdif', 'ac3,eac3,dts']),
    );
    expect(fake.sent).toContainEqual(['set_property', 'audio-exclusive', 'yes']);
    expect(fake.sent).toContainEqual(['set_property', 'audio-channels', 'auto-safe']);
    expect(fake.sent).toContainEqual(['af', 'remove', AC3_ENCODE_LABEL]);

    const ac3Cfg: DesktopAudioOutputConfig = {
      passthrough: false,
      codecs: ['ac3'],
      exclusive: true,
      ac3Encode: true,
      channelLayout: '5.1',
    };
    engine.setDesktopAudioOutput?.(ac3Cfg);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['af', 'add', AC3_ENCODE_FILTER]));
    expect(fake.sent).toContainEqual(['set_property', 'audio-spdif', '']);
    expect(fake.sent).toContainEqual(['set_property', 'audio-exclusive', 'no']);
    expect(fake.sent).toContainEqual(['set_property', 'audio-channels', '5.1']);
    expect(fake.sent.some((c) => c[0] === 'set_property' && c[1] === 'af')).toBe(false);
  });

  it('keeps @elv_loudnorm disabled whenever passthrough or ac3Encode is active and restores when both turn off', async () => {
    const { engine, fake, events } = await setupEngineTest(cleanups, {
      scripts: { [URL_VOD]: HOLD_SCRIPT },
    });
    engine.setAudioNormalization(true);
    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['af', 'add', LOUDNORM_FILTER]));

    // Turning on ac3Encode suppresses @elv_loudnorm
    const beforeAc3 = fake.sent.length;
    engine.setDesktopAudioOutput?.({
      passthrough: false,
      codecs: [],
      exclusive: false,
      ac3Encode: true,
      channelLayout: '5.1',
    });
    await vi.waitFor(() => {
      const slice = fake.sent.slice(beforeAc3);
      expect(slice).toContainEqual(['af', 'remove', '@elv_loudnorm']);
      expect(slice).toContainEqual(['af', 'add', AC3_ENCODE_FILTER]);
    });

    // Turning off ac3Encode restores @elv_loudnorm
    const beforePcm = fake.sent.length;
    engine.setDesktopAudioOutput?.({
      passthrough: false,
      codecs: [],
      exclusive: false,
      ac3Encode: false,
      channelLayout: 'auto',
    });
    await vi.waitFor(() => {
      const slice = fake.sent.slice(beforePcm);
      expect(slice).toContainEqual(['af', 'remove', AC3_ENCODE_LABEL]);
      expect(slice).toContainEqual(['af', 'add', LOUDNORM_FILTER]);
    });
  });

  it('automatically falls back to safe PCM, reloads AO, emits passthroughFallback once, and restores loudnorm on AO error', async () => {
    const {
      engine,
      fake,
      events,
      ui: uiEvents,
    } = await setupEngineTest(cleanups, {
      scripts: { [URL_VOD]: PASSTHROUGH_FAIL_SCRIPT },
    });

    engine.setAudioNormalization(true);
    engine.setDesktopAudioOutput?.({
      passthrough: true,
      codecs: ['ac3', 'eac3', 'truehd'],
      exclusive: true,
      ac3Encode: false,
      channelLayout: 'auto',
    });
    engine.load({ attempt: 1, url: URL_VOD, headers: {}, kind: 'vod' });
    await playing(events, 1);

    await vi.waitFor(() => {
      expect(uiEvents.filter((e) => e.type === 'passthroughFallback')).toHaveLength(1);
    });

    expect(fake.sent).toContainEqual(['set_property', 'audio-spdif', '']);
    expect(fake.sent).toContainEqual(['set_property', 'audio-exclusive', 'no']);
    expect(fake.sent).toContainEqual(['ao-reload']);
    // Loudnorm restores cleanly after fallback to PCM
    await vi.waitFor(() => expect(fake.sent).toContainEqual(['af', 'add', LOUDNORM_FILTER]));

    // Re-sending the exact same failed config (e.g. React effect re-run) stays in PCM fallback
    const beforeRedundant = fake.sent.length;
    engine.setDesktopAudioOutput?.({
      passthrough: true,
      codecs: ['ac3', 'eac3', 'truehd'],
      exclusive: true,
      ac3Encode: false,
      channelLayout: 'auto',
    });
    await sleep(25);
    expect(
      fake.sent
        .slice(beforeRedundant)
        .some((c) => c[0] === 'set_property' && c[1] === 'audio-spdif' && c[2] !== ''),
    ).toBe(false);
    expect(uiEvents.filter((e) => e.type === 'passthroughFallback')).toHaveLength(1);
  });

  it('applies video-sync=display-resample when AFR is active and video-sync=audio when off, persisting across load() and recreate()', async () => {
    const fake = createFakeMpv({
      scripts: { [URL_VOD]: HOLD_SCRIPT, [URL_LIVE]: HOLD_SCRIPT },
      transport: 'socket',
    });
    const engine = createMpvEngine({
      spawn: (args, signal) => fake.spawn(args, signal),
      presenter: stubPresenter(),
      baseArgs: LAUNCH_OPTIONS,
      loadMode: 'replace',
      now: () => Date.now(),
      timers,
      onUi: () => undefined,
      deferStart: true,
    });
    cleanups.push(async () => {
      engine.release();
      await fake.dispose();
    });

    const seamless: DisplaySyncPolicy = { autoFrameRate: 'seamless', autoDynamicRange: true };
    const off: DisplaySyncPolicy = { autoFrameRate: 'off', autoDynamicRange: true };
    const audioCfg: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3', 'dts'],
      exclusive: false,
      ac3Encode: false,
      channelLayout: '7.1',
    };

    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.start();
    engine.load({
      attempt: 1,
      url: URL_VOD,
      headers: {},
      kind: 'vod',
      options: { displaySync: seamless, desktopAudioOutput: audioCfg },
    });
    await playing(events, 1);

    expect(fake.sent).toContainEqual(['set_property', 'video-sync', 'display-resample']);
    expect(fake.sent).toContainEqual(['set_property', 'audio-spdif', 'ac3,dts']);
    expect(fake.sent).toContainEqual(['set_property', 'audio-channels', '7.1']);

    // Live switch to AFR off -> video-sync=audio
    engine.setDisplaySync?.(off);
    await vi.waitFor(() =>
      expect(fake.sent).toContainEqual(['set_property', 'video-sync', 'audio']),
    );

    // Recreate persists latest displaySync and desktopAudioOutput
    const beforeRecreate = fake.sent.length;
    engine.setDisplaySync?.({ autoFrameRate: 'always', autoDynamicRange: false });
    engine.recreate(2);
    await vi.waitFor(() => {
      const after = fake.sent.slice(beforeRecreate);
      expect(after).toContainEqual(['set_property', 'video-sync', 'display-resample']);
      expect(after).toContainEqual(['set_property', 'audio-spdif', 'ac3,dts']);
      expect(after).toContainEqual(['set_property', 'audio-channels', '7.1']);
    });
  });
});

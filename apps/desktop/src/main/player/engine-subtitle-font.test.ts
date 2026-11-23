import type { EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMpvEngine, type MpvEngineDeps } from './engine.ts';
import { mapSubtitleFontFamily } from './engine-controls.ts';
import { createFakeMpv, type FakeMpvScript } from './mpv/fake-mpv.ts';
import { LAUNCH_OPTIONS } from './mpv/options.ts';
import type { VideoPresenter } from './presenter/types.ts';

const URL_STREAM = 'http://sim.test/live/demo/demo/1001.ts';

const STREAM_SCRIPT: FakeMpvScript = [
  { afterMs: 0, event: 'start-file' },
  { afterMs: 3, event: 'file-loaded' },
  { afterMs: 4, property: 'video-params', value: { w: 1280, h: 720 } },
  { afterMs: 6, event: 'playback-restart' },
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

describe('mapSubtitleFontFamily (#163)', () => {
  it('maps accessibility font families to mpv sub-font names', () => {
    expect(mapSubtitleFontFamily('atkinson')).toBe('Atkinson Hyperlegible Next');
    expect(mapSubtitleFontFamily('opendyslexic')).toBe('OpenDyslexic');
    expect(mapSubtitleFontFamily('system')).toBe('sans-serif');
  });
});

describe('MpvEngine desiredSubtitleFont persistence across spawn, load, and respawn (#163)', () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    for (const fn of cleanups.splice(0).reverse()) await fn();
  });

  it('applies setSubtitleFontFamily called before spawn, switches live, resets to system, and persists across recreate()', async () => {
    const fake = createFakeMpv({ scripts: { [URL_STREAM]: STREAM_SCRIPT }, transport: 'socket' });

    let releaseFirstSpawn: (() => void) | undefined;
    let spawnCount = 0;
    const engine = createMpvEngine({
      spawn: async (args, signal) => {
        spawnCount += 1;
        if (spawnCount === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstSpawn = resolve;
          });
        }
        return fake.spawn(args, signal);
      },
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

    engine.start();
    await vi.waitFor(() => expect(releaseFirstSpawn).toBeDefined());
    engine.setSubtitleFontFamily('atkinson');
    releaseFirstSpawn?.();

    await vi.waitFor(() =>
      expect(fake.sent).toContainEqual(['set_property', 'sub-font', 'Atkinson Hyperlegible Next']),
    );

    const events: EngineEvent[] = [];
    engine.subscribe((e) => events.push(e));
    engine.load({ attempt: 1, url: URL_STREAM, headers: {}, kind: 'live' });
    await vi.waitFor(() =>
      expect(
        events.some((e) => e.attempt === 1 && e.type === 'state' && e.state === 'playing'),
      ).toBe(true),
    );

    const beforeRecreate1 = fake.sent.length;
    engine.recreate(2);
    await vi.waitFor(() =>
      expect(fake.sent.slice(beforeRecreate1)).toContainEqual([
        'set_property',
        'sub-font',
        'Atkinson Hyperlegible Next',
      ]),
    );

    const beforeSwitch = fake.sent.length;
    engine.setSubtitleFontFamily('opendyslexic');
    await vi.waitFor(() =>
      expect(fake.sent.slice(beforeSwitch)).toContainEqual([
        'set_property',
        'sub-font',
        'OpenDyslexic',
      ]),
    );

    const beforeRecreate2 = fake.sent.length;
    engine.recreate(3);
    await vi.waitFor(() =>
      expect(fake.sent.slice(beforeRecreate2)).toContainEqual([
        'set_property',
        'sub-font',
        'OpenDyslexic',
      ]),
    );

    const beforeReset = fake.sent.length;
    engine.setSubtitleFontFamily('system');
    await vi.waitFor(() =>
      expect(fake.sent.slice(beforeReset)).toContainEqual([
        'set_property',
        'sub-font',
        'sans-serif',
      ]),
    );
  });

  it('still applies desiredSubtitleFont when load() purges transient queue ops before the command ran', async () => {
    const fake = createFakeMpv({ scripts: { [URL_STREAM]: STREAM_SCRIPT }, transport: 'socket' });

    const engine = createMpvEngine({
      spawn: (args, signal) => fake.spawn(args, signal),
      presenter: stubPresenter(),
      baseArgs: LAUNCH_OPTIONS,
      loadMode: 'replace',
      now: () => Date.now(),
      timers,
      onUi: () => undefined,
    });
    cleanups.push(async () => {
      engine.release();
      await fake.dispose();
    });

    await vi.waitFor(() => expect(fake.sent).toContainEqual(['request_log_messages', 'v']));
    fake.replyDelayMs = 40;

    engine.setVolume(80);
    engine.setSubtitleFontFamily('opendyslexic');
    engine.load({ attempt: 1, url: URL_STREAM, headers: {}, kind: 'live' });

    await vi.waitFor(() =>
      expect(fake.sent).toContainEqual(['set_property', 'sub-font', 'OpenDyslexic']),
    );
  });
});

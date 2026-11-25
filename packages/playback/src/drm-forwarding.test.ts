import { ok } from '@elv/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DrmConfig, LoadCommand, StreamRequest } from './engine';
import { createPlaybackService } from './service';
import { createFakePlayerEngine } from './testing';

function setup(): {
  loads: LoadCommand[];
  service: ReturnType<typeof createPlaybackService>;
} {
  const loads: LoadCommand[] = [];
  const baseEngine = createFakePlayerEngine({
    scripts: {},
    now: () => Date.now(),
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  });
  const engine = {
    ...baseEngine,
    load: (cmd: LoadCommand) => {
      loads.push(cmd);
      baseEngine.load(cmd);
    },
  };
  const service = createPlaybackService({
    engine,
    clock: { now: () => Date.now() },
    timers: {
      setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
      clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
    },
    config: { startTimeoutMs: 8000 },
  });
  return { loads, service };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
});
afterEach(() => vi.useRealTimers());

describe('PlaybackService DRM forwarding (#272)', () => {
  it('forwards stream.drm to engine.load when present', async () => {
    const { loads, service } = setup();
    const drm: DrmConfig = {
      scheme: 'widevine',
      licenseUrl: 'https://drm.example.test/widevine',
      licenseHeaders: { Authorization: 'Bearer synth-token', 'User-Agent': 'ElvDrmTest/1.0' },
      multiSession: true,
    };
    const stream: StreamRequest = {
      url: 'https://cdn.example.test/live/channel.mpd',
      headers: { 'User-Agent': 'ElvStreamTest/1.0' },
      drm,
    };

    service.tune({
      item: 'item-drm-wv',
      accountKey: 'acc',
      kind: 'live',
      resolve: () => Promise.resolve(ok(stream)),
    });
    await flush();

    expect(loads).toHaveLength(1);
    expect(loads[0]?.drm).toEqual(drm);
  });

  it('forwards inline ClearKey drm config to engine.load', async () => {
    const { loads, service } = setup();
    const drm: DrmConfig = {
      scheme: 'clearkey',
      clearKeys: [
        {
          kid: '00112233445566778899aabbccddeeff',
          key: 'ffeeddccbbaa99887766554433221100',
        },
      ],
    };

    service.tune({
      item: 'item-drm-ck',
      accountKey: 'acc',
      kind: 'vod',
      resolve: () =>
        Promise.resolve(
          ok({
            url: 'https://cdn.example.test/vod/movie.mpd',
            headers: {},
            drm,
          }),
        ),
    });
    await flush();

    expect(loads).toHaveLength(1);
    expect(loads[0]?.drm).toEqual(drm);
  });

  it('omits the drm property on engine.load when stream.drm is absent', async () => {
    const { loads, service } = setup();

    service.tune({
      item: 'item-plain',
      accountKey: 'acc',
      kind: 'live',
      resolve: () =>
        Promise.resolve(
          ok({
            url: 'https://cdn.example.test/live/plain.ts',
            headers: {},
          }),
        ),
    });
    await flush();

    expect(loads).toHaveLength(1);
    expect('drm' in (loads[0] ?? {})).toBe(false);
  });
});

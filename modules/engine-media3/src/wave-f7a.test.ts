import type { EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function load() {
  vi.resetModules();
  return import('./index');
}

function fakeWaveF7ANative() {
  const engine = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    setNightModeDrc: vi.fn(),
    setDisplaySync: vi.fn(),
    setAudioDelayByRefreshRate: vi.fn(),
    addListener: vi.fn((_name: string, _listener: (event: EngineEvent) => void) => ({
      remove: vi.fn(),
    })),
  };
  const Engine = vi.fn(function construct() {
    return engine;
  });
  const uptimeMs = vi.fn(() => 0);
  const getDrmCapabilities = vi.fn(() => ({
    widevineSecurityLevel: 'L1',
    clearKeySupported: true,
  }));
  requireOptionalNativeModule.mockReturnValue({
    Engine,
    uptimeMs,
    getDrmCapabilities,
  });
  return { engine, Engine, getDrmCapabilities };
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('Wave F7A Media3 bindings (#115, #116, #199, #272)', () => {
  it('exposes getDrmCapabilities with safe defaults when invalid or absent (#272)', async () => {
    const native = fakeWaveF7ANative();
    const mod = await load();

    expect(mod.getDrmCapabilities()).toEqual({
      widevineSecurityLevel: 'L1',
      clearKeySupported: true,
    });

    native.getDrmCapabilities.mockReturnValueOnce({
      widevineSecurityLevel: 'l3',
      clearKeySupported: false,
    });
    expect(mod.getDrmCapabilities()).toEqual({
      widevineSecurityLevel: 'L3',
      clearKeySupported: false,
    });

    native.getDrmCapabilities.mockReturnValueOnce({
      widevineSecurityLevel: 'weird',
      clearKeySupported: true,
    });
    expect(mod.getDrmCapabilities()).toEqual({
      widevineSecurityLevel: 'unavailable',
      clearKeySupported: true,
    });

    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.getDrmCapabilities()).toEqual({
      widevineSecurityLevel: 'unavailable',
      clearKeySupported: false,
    });
  });

  it('forwards setNightModeDrc, setDisplaySync, and setAudioDelayByRefreshRate until released (#115, #116)', async () => {
    const native = fakeWaveF7ANative();
    const mod = await load();
    const engine = mod.createMedia3Engine();
    if (engine === null) throw new Error('engine expected');

    engine.setNightModeDrc?.('night');
    mod.setMedia3NightModeDrc(engine, 'light');
    mod.setMedia3NightModeDrc(engine, 'invalid' as never);

    engine.setDisplaySync?.({ autoFrameRate: 'always', autoDynamicRange: false });
    mod.setMedia3DisplaySync(engine, { autoFrameRate: 'off' });

    engine.setAudioDelayByRefreshRate?.({
      '23.976': 45,
      '50': -1_500,
      '60': Number.NaN,
    });
    mod.setMedia3AudioDelayByRefreshRate(engine, { '24': 1_200 });

    expect(native.engine.setNightModeDrc).toHaveBeenNthCalledWith(1, 'night');
    expect(native.engine.setNightModeDrc).toHaveBeenNthCalledWith(2, 'light');
    expect(native.engine.setNightModeDrc).toHaveBeenNthCalledWith(3, 'off');
    expect(native.engine.setDisplaySync).toHaveBeenNthCalledWith(1, {
      autoFrameRate: 'always',
      autoDynamicRange: false,
    });
    expect(native.engine.setDisplaySync).toHaveBeenNthCalledWith(2, {
      autoFrameRate: 'off',
      autoDynamicRange: true,
    });
    expect(native.engine.setAudioDelayByRefreshRate).toHaveBeenNthCalledWith(1, {
      '23.976': 45,
      '50': -1_000,
    });
    expect(native.engine.setAudioDelayByRefreshRate).toHaveBeenNthCalledWith(2, { '24': 1_000 });

    // Released engine ignores subsequent calls cleanly
    engine.release();
    engine.setNightModeDrc?.('night');
    engine.setDisplaySync?.({ autoFrameRate: 'always', autoDynamicRange: true });
    engine.setAudioDelayByRefreshRate?.({ '24': 20 });
    mod.setMedia3NightModeDrc(engine, 'night');
    mod.setMedia3DisplaySync(engine, { autoFrameRate: 'always' });
    mod.setMedia3AudioDelayByRefreshRate(engine, { '24': 20 });
    expect(native.engine.setNightModeDrc).toHaveBeenCalledTimes(3);
    expect(native.engine.setDisplaySync).toHaveBeenCalledTimes(2);
    expect(native.engine.setAudioDelayByRefreshRate).toHaveBeenCalledTimes(2);
  });

  it('validates and forwards drm, displaySync, nightModeDrc, and audioDelayByRefreshRateMs on load (#115, #116, #272)', async () => {
    const native = fakeWaveF7ANative();
    const mod = await load();
    const engine = mod.createMedia3Engine();
    if (engine === null) throw new Error('engine expected');

    // 1. Inline ClearKey + AFR + Night DRC + refresh offsets
    engine.load({
      attempt: 1,
      url: 'https://cdn.example.test/live/ch1.mpd',
      headers: {},
      kind: 'live',
      drm: {
        scheme: 'org.w3.clearkey',
        clearKeys: [
          {
            kid: '00112233445566778899aabbccddeeff',
            key: 'ffeeddccbbaa99887766554433221100',
          },
        ],
        multiSession: false,
      },
      options: {
        displaySync: { autoFrameRate: 'always', autoDynamicRange: true },
        nightModeDrc: 'night',
        audioDelayByRefreshRateMs: { '23.976': 40, '50': -20 },
      },
    } as never);

    expect(native.engine.load).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      url: 'https://cdn.example.test/live/ch1.mpd',
      headers: {},
      kind: 'live',
      drm: {
        scheme: 'clearkey',
        clearKeys: [
          {
            kid: '00112233445566778899aabbccddeeff',
            key: 'ffeeddccbbaa99887766554433221100',
          },
        ],
        multiSession: false,
      },
      displaySync: { autoFrameRate: 'always', autoDynamicRange: true },
      nightModeDrc: 'night',
      audioDelayByRefreshRateMs: { '23.976': 40, '50': -20 },
    });

    // 2. Remote Widevine with licenseUrl + headers + multiSession
    engine.load({
      attempt: 2,
      url: 'https://cdn.example.test/vod/movie.mpd',
      headers: {},
      kind: 'vod',
      drm: {
        scheme: 'com.widevine.alpha',
        licenseUrl: 'https://drm.example.test/widevine',
        licenseHeaders: { Authorization: 'Bearer tok' },
        multiSession: true,
      },
    } as never);

    expect(native.engine.load).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      url: 'https://cdn.example.test/vod/movie.mpd',
      headers: {},
      kind: 'vod',
      drm: {
        scheme: 'widevine',
        licenseUrl: 'https://drm.example.test/widevine',
        licenseHeaders: { Authorization: 'Bearer tok' },
        multiSession: true,
      },
    });

    // 3. Disallowed DRM licenseUrl (file://) and invalid clearKeys are stripped safely
    engine.load({
      attempt: 3,
      url: 'https://cdn.example.test/live/ch2.mpd',
      headers: {},
      kind: 'live',
      drm: {
        scheme: 'widevine',
        licenseUrl: 'file:///etc/passwd',
      },
    } as never);

    expect(native.engine.load).toHaveBeenNthCalledWith(3, {
      attempt: 3,
      url: 'https://cdn.example.test/live/ch2.mpd',
      headers: {},
      kind: 'live',
    });
  });
});

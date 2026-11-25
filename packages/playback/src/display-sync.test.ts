import { describe, expect, it, vi } from 'vitest';
import {
  bridgeNativeEngine,
  type DesktopAudioOutputConfig,
  type DisplaySyncPolicy,
  type DrmConfig,
  type NativeEngineHandle,
  type NativeLoadCommand,
  refreshRateBucketKey,
  resolveEffectiveAudioDelayMs,
  STANDARD_FRAME_RATES,
  snapStandardFrameRate,
} from './index';

describe('display-sync (#115, #116, #188, #199, #214)', () => {
  it('exposes the 8 standard cinema and broadcast frame rates', () => {
    expect(STANDARD_FRAME_RATES).toEqual([23.976, 24, 25, 29.97, 30, 50, 59.94, 60]);
  });

  it('snaps raw FPS values to the closest standard frame rate within 0.15 fps tolerance', () => {
    expect(snapStandardFrameRate(24000 / 1001)).toBe(23.976);
    expect(snapStandardFrameRate(23.976)).toBe(23.976);
    expect(snapStandardFrameRate(23.98)).toBe(23.976);
    expect(snapStandardFrameRate(23.99)).toBe(24);
    expect(snapStandardFrameRate(24)).toBe(24);
    expect(snapStandardFrameRate(24.1)).toBe(24);
    expect(snapStandardFrameRate(25.02)).toBe(25);
    expect(snapStandardFrameRate(30000 / 1001)).toBe(29.97);
    expect(snapStandardFrameRate(30)).toBe(30);
    expect(snapStandardFrameRate(49.95)).toBe(50);
    expect(snapStandardFrameRate(60000 / 1001)).toBe(59.94);
    expect(snapStandardFrameRate(60.05)).toBe(60);
  });

  it('rejects non-finite, non-positive, out-of-range, and non-standard frame rates', () => {
    expect(snapStandardFrameRate(Number.NaN)).toBeUndefined();
    expect(snapStandardFrameRate(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(snapStandardFrameRate(Number.NEGATIVE_INFINITY)).toBeUndefined();
    expect(snapStandardFrameRate(0)).toBeUndefined();
    expect(snapStandardFrameRate(-24)).toBeUndefined();
    expect(snapStandardFrameRate(240.1)).toBeUndefined();
    expect(snapStandardFrameRate(48)).toBeUndefined();
    expect(snapStandardFrameRate(120)).toBeUndefined();
    expect(snapStandardFrameRate(23.8)).toBeUndefined();
  });

  it('maps snapped FPS values to canonical RefreshRateBucket strings', () => {
    expect(refreshRateBucketKey(undefined)).toBeUndefined();
    expect(refreshRateBucketKey(Number.NaN)).toBeUndefined();
    expect(refreshRateBucketKey(48)).toBeUndefined();
    expect(refreshRateBucketKey(24000 / 1001)).toBe('23.976');
    expect(refreshRateBucketKey(24)).toBe('24');
    expect(refreshRateBucketKey(25)).toBe('25');
    expect(refreshRateBucketKey(29.97)).toBe('29.97');
    expect(refreshRateBucketKey(30)).toBe('30');
    expect(refreshRateBucketKey(50)).toBe('50');
    expect(refreshRateBucketKey(59.94)).toBe('59.94');
    expect(refreshRateBucketKey(60)).toBe('60');
  });

  it('resolves effective audio delay combining base delay and per-refresh-rate offset clamped to [-30000, 30000]', () => {
    const byRefresh = {
      '23.976': -60,
      '50': 45,
      '60': 1500,
    } as const;

    expect(resolveEffectiveAudioDelayMs(100, 23.976, byRefresh)).toBe(40);
    expect(resolveEffectiveAudioDelayMs(-20, 50.02, byRefresh)).toBe(25);
    expect(resolveEffectiveAudioDelayMs(0, 60, byRefresh)).toBe(1000);
    expect(resolveEffectiveAudioDelayMs(100, 30, byRefresh)).toBe(100);
    expect(resolveEffectiveAudioDelayMs(100, undefined, byRefresh)).toBe(100);
    expect(resolveEffectiveAudioDelayMs(100, 23.976, undefined)).toBe(100);
    expect(resolveEffectiveAudioDelayMs(Number.NaN, 23.976, byRefresh)).toBe(-60);
    expect(resolveEffectiveAudioDelayMs(29_800, 60, byRefresh)).toBe(30_000);
    expect(resolveEffectiveAudioDelayMs(-29_950, 23.976, byRefresh)).toBe(-30_000);
  });

  it('forwards drm, displaySync, nightModeDrc, desktopAudioOutput, and live setters through bridgeNativeEngine', () => {
    const loads: NativeLoadCommand[] = [];
    const setNightModeDrc = vi.fn();
    const setDisplaySync = vi.fn();
    const setDesktopAudioOutput = vi.fn();
    const native: NativeEngineHandle = {
      load: (cmd) => {
        loads.push(cmd);
      },
      retry: () => {},
      play: () => {},
      pause: () => {},
      seek: () => {},
      setNightModeDrc,
      setDisplaySync,
      setDesktopAudioOutput,
      stop: () => {},
      recreate: () => {},
      release: () => {},
      addListener: () => ({ remove: () => {} }),
    };

    const engine = bridgeNativeEngine(native, {
      capabilities: {
        mpegTsOverHttp: true,
        hls: true,
        liveSeek: false,
        softwareAudioFallback: true,
        recreate: true,
        audioTrackSelection: true,
        subtitleTrackSelection: true,
      },
      uptimeMs: () => 1000,
      now: () => 1000,
    });

    const drm: DrmConfig = {
      scheme: 'clearkey',
      clearKeys: [
        { kid: '00112233445566778899aabbccddeeff', key: 'ffeeddccbbaa99887766554433221100' },
      ],
    };
    const displaySync: DisplaySyncPolicy = {
      autoFrameRate: 'seamless',
      autoDynamicRange: true,
    };
    const desktopAudioOutput: DesktopAudioOutputConfig = {
      passthrough: true,
      codecs: ['ac3', 'eac3'],
      exclusive: false,
      ac3Encode: false,
      channelLayout: '5.1',
    };

    engine.load({
      attempt: 1,
      url: 'http://example.invalid/stream.mpd',
      headers: {},
      kind: 'live',
      drm,
      options: {
        displaySync,
        nightModeDrc: 'night',
        desktopAudioOutput,
      },
    });

    expect(loads).toHaveLength(1);
    expect(loads[0]?.drm).toEqual(drm);
    expect(loads[0]?.displaySync).toEqual(displaySync);
    expect(loads[0]?.nightModeDrc).toBe('night');
    expect(loads[0]?.desktopAudioOutput).toEqual(desktopAudioOutput);

    engine.setNightModeDrc?.('light');
    engine.setDisplaySync?.({ autoFrameRate: 'always', autoDynamicRange: false });
    engine.setDesktopAudioOutput?.(desktopAudioOutput);

    expect(setNightModeDrc).toHaveBeenCalledWith('light');
    expect(setDisplaySync).toHaveBeenCalledWith({
      autoFrameRate: 'always',
      autoDynamicRange: false,
    });
    expect(setDesktopAudioOutput).toHaveBeenCalledWith(desktopAudioOutput);
  });
});

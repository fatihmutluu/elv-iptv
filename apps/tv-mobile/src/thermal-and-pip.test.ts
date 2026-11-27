import type { PlayerEngine } from '@elv/playback';
import { describe, expect, it, vi } from 'vitest';
import { createMobileVideoHost, type MobileVideoHostDeps } from './thermal-and-pip';

const fakeEngine = () => ({ tag: 'engine' }) as unknown as PlayerEngine;

function makeDeps(overrides: Partial<MobileVideoHostDeps> = {}): MobileVideoHostDeps {
  return {
    os: 'android',
    isTV: false,
    createEngine: vi.fn(() => fakeEngine()),
    renderSurface: vi.fn(() => null),
    getAndroidDeviceMemoryInfo: vi.fn(() => ({
      isLowRamDevice: false,
      totalMemBytes: 4 * 1024 * 1024 * 1024,
      lowRam: false,
    })),
    configureMedia3MultiView: vi.fn(),
    setOrientationLocked: vi.fn(),
    requestTemporaryOrientation: vi.fn(),
    setMedia3PitchLock: vi.fn(),
    setMedia3MediaMetadata: vi.fn(),
    setMedia3BackgroundAudioEnabled: vi.fn(),
    subscribeMedia3RemoteMediaAction: vi.fn(() => () => {}),
    enterAndroidPictureInPicture: vi.fn(() => true),
    setAndroidAutoEnterPictureInPicture: vi.fn(() => true),
    subscribeAndroidPictureInPicture: vi.fn(() => () => {}),
    setAetherMediaMetadata: vi.fn(),
    setAetherBackgroundAudioEnabled: vi.fn(),
    configureAetherMultiView: vi.fn(),
    subscribeAetherRemoteMediaAction: vi.fn(() => () => {}),
    subscribeAppleHardwareKeys: vi.fn(() => () => {}),
    setAppleEngineMuted: vi.fn(),
    setAppleEngineVolume: vi.fn(),
    enterAetherPictureInPicture: vi.fn(() => true),
    canStartAetherPictureInPicture: vi.fn(() => true),
    setAetherAutoEnterPictureInPicture: vi.fn(() => true),
    subscribeAetherPictureInPicture: vi.fn(() => () => {}),
    panGestures: null,
    ...overrides,
  };
}

describe('createMobileVideoHost (#34, #221, #232)', () => {
  it('wires Android Multi-View options, setMuted, setPrimary, and mobile PiP with sourceRect', () => {
    const engine = fakeEngine();
    const deps = makeDeps({
      os: 'android',
      isTV: false,
      createEngine: vi.fn(() => engine),
    });

    const host = createMobileVideoHost(deps);
    expect(host.supportsMultiView).toBe(true);

    const opened = host.open({ handleAudioFocus: false, multiViewTileCount: 4 });
    expect(opened).not.toBeNull();
    expect(deps.createEngine).toHaveBeenCalledWith({
      handleAudioFocus: false,
      multiViewTileCount: 4,
    });

    opened?.setMuted?.(true);
    expect(deps.configureMedia3MultiView).toHaveBeenCalledWith(engine, {
      handleAudioFocus: false,
      multiViewTileCount: 4,
    });

    opened?.setPrimary?.();
    expect(deps.configureMedia3MultiView).toHaveBeenLastCalledWith(engine, {
      handleAudioFocus: true,
      multiViewTileCount: 4,
    });

    const rect = { left: 10, top: 20, right: 330, bottom: 200 };
    expect(opened?.enterPictureInPicture?.(16, 9, rect)).toBe(true);
    expect(deps.enterAndroidPictureInPicture).toHaveBeenCalledWith(16, 9, rect);

    expect(opened?.setAutoEnterPictureInPicture?.(true, 16, 9, rect)).toBe(true);
    expect(deps.setAndroidAutoEnterPictureInPicture).toHaveBeenCalledWith(true, 16, 9, rect);

    const pipListener = vi.fn();
    opened?.onPictureInPictureChange?.(pipListener);
    expect(deps.subscribeAndroidPictureInPicture).toHaveBeenCalledWith(pipListener);
  });

  it('disables supportsMultiView on low-RAM Android devices and omits PiP on Android TV', () => {
    const deps = makeDeps({
      os: 'android',
      isTV: true,
      getAndroidDeviceMemoryInfo: vi.fn(() => ({
        isLowRamDevice: true,
        totalMemBytes: 1024 * 1024 * 1024,
        lowRam: true,
      })),
    });

    const host = createMobileVideoHost(deps);
    expect(host.supportsMultiView).toBe(false);

    const opened = host.open();
    expect(deps.createEngine).toHaveBeenCalledWith(undefined);
    expect(opened?.enterPictureInPicture).toBeUndefined();
    expect(opened?.setAutoEnterPictureInPicture).toBeUndefined();
    expect(opened?.onPictureInPictureChange).toBeUndefined();
  });

  it('wires Apple iOS/tvOS PiP, setMuted, toggleMute sync, and supportsMultiView', () => {
    const engine = fakeEngine();
    const deps = makeDeps({
      os: 'ios',
      isTV: false,
      createEngine: vi.fn(() => engine),
    });

    const host = createMobileVideoHost(deps);
    expect(host.supportsMultiView).toBe(true);

    const opened = host.open();
    expect(opened).not.toBeNull();

    expect(opened?.canStartPictureInPicture?.()).toBe(true);
    expect(deps.canStartAetherPictureInPicture).toHaveBeenCalledWith(engine);

    expect(opened?.enterPictureInPicture?.()).toBe(true);
    expect(deps.enterAetherPictureInPicture).toHaveBeenCalledWith(engine);

    expect(opened?.setAutoEnterPictureInPicture?.(false)).toBe(true);
    expect(deps.setAetherAutoEnterPictureInPicture).toHaveBeenCalledWith(false, engine);

    const pipListener = vi.fn();
    opened?.onPictureInPictureChange?.(pipListener);
    expect(deps.subscribeAetherPictureInPicture).toHaveBeenCalledWith(pipListener);

    opened?.setMuted?.(true);
    expect(deps.setAppleEngineMuted).toHaveBeenLastCalledWith(engine, true);
    expect(deps.configureAetherMultiView).not.toHaveBeenCalled();
    opened?.toggleMute?.();
    expect(deps.setAppleEngineMuted).toHaveBeenLastCalledWith(engine, false);
  });

  it('wires Apple Multi-View handleAudioFocus, setPrimary, and demotion via setMuted (#34)', () => {
    const engine = fakeEngine();
    const deps = makeDeps({
      os: 'ios',
      isTV: true,
      createEngine: vi.fn(() => engine),
    });

    const host = createMobileVideoHost(deps);
    const opened = host.open({
      replaceExisting: false,
      primary: false,
      handleAudioFocus: false,
      multiViewTileCount: 2,
    });
    expect(opened).not.toBeNull();
    expect(deps.createEngine).toHaveBeenCalledWith({
      handleAudioFocus: false,
      multiViewTileCount: 2,
    });

    // Promoting tile to primary unmutes and claims Aether Now Playing / audio focus
    opened?.setPrimary?.();
    expect(deps.setAppleEngineMuted).toHaveBeenLastCalledWith(engine, false);
    expect(deps.configureAetherMultiView).toHaveBeenLastCalledWith(engine, true);

    // Demoting Multi-View tile via setMuted(true) releases Aether Now Playing / audio focus
    opened?.setMuted?.(true);
    expect(deps.setAppleEngineMuted).toHaveBeenLastCalledWith(engine, true);
    expect(deps.configureAetherMultiView).toHaveBeenLastCalledWith(engine, false);
  });

  it('wires Android setNightModeDrc and setDisplaySync onto OpenVideoEngine (#115, #116, #199)', () => {
    const setNightModeDrc = vi.fn();
    const setDisplaySync = vi.fn();
    const engine = {
      tag: 'engine',
      setNightModeDrc,
      setDisplaySync,
    } as unknown as PlayerEngine;
    const deps = makeDeps({
      os: 'android',
      isTV: true,
      createEngine: vi.fn(() => engine),
    });

    const host = createMobileVideoHost(deps);
    const opened = host.open();
    expect(opened).not.toBeNull();
    expect(opened?.setNightModeDrc).toBeTypeOf('function');
    expect(opened?.setDisplaySync).toBeTypeOf('function');

    opened?.setNightModeDrc?.('night');
    expect(setNightModeDrc).toHaveBeenCalledWith('night');

    const policy = { autoFrameRate: 'always', autoDynamicRange: true } as const;
    opened?.setDisplaySync?.(policy);
    expect(setDisplaySync).toHaveBeenCalledWith(policy);
  });

  it('wires Apple setDisplaySync onto OpenVideoEngine and leaves setNightModeDrc undefined (#116, #188)', () => {
    const setDisplaySync = vi.fn();
    const engine = {
      tag: 'engine',
      setDisplaySync,
    } as unknown as PlayerEngine;
    const deps = makeDeps({
      os: 'ios',
      isTV: true,
      createEngine: vi.fn(() => engine),
    });

    const host = createMobileVideoHost(deps);
    const opened = host.open();
    expect(opened).not.toBeNull();
    expect(opened?.setDisplaySync).toBeTypeOf('function');
    expect(opened?.setNightModeDrc).toBeUndefined();

    const policy = { autoFrameRate: 'seamless', autoDynamicRange: false } as const;
    opened?.setDisplaySync?.(policy);
    expect(setDisplaySync).toHaveBeenCalledWith(policy);
  });

  it('returns null from open when createEngine returns null', () => {
    const deps = makeDeps({ createEngine: vi.fn(() => null) });
    const host = createMobileVideoHost(deps);
    expect(host.open()).toBeNull();
  });

  it('records redacted media_decode_failure and playback_error telemetry only when opted in (#458, #70)', () => {
    let optedIn = false;
    const listeners: Array<(event: unknown) => void> = [];
    const engine = {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as PlayerEngine;
    const recordMediaDecodeFailure = vi.fn();
    const recordPlaybackError = vi.fn();

    const host = createMobileVideoHost(
      makeDeps({
        os: 'android',
        isTV: true,
        createEngine: vi.fn(() => engine),
        telemetry: {
          isOptedIn: () => optedIn,
          recordMediaDecodeFailure,
          recordPlaybackError,
        },
      }),
    );
    host.open();

    // Opted out -> zero telemetry recorded
    for (const l of listeners) {
      l({ attempt: 1, type: 'error', error: { code: 'decoder', detail: 'https://secret.test/x' } });
    }
    expect(recordMediaDecodeFailure).not.toHaveBeenCalled();
    expect(recordPlaybackError).not.toHaveBeenCalled();

    // Opted in -> captures redacted codec/container/hdr without leaking raw detail
    optedIn = true;
    for (const l of listeners) {
      l({ attempt: 2, type: 'clock', anchor: { positionMs: 0, atMs: 0, rate: 1, isLiveTs: true } });
      l({ attempt: 2, type: 'mediaInfo', info: { codec: 'video/hevc', hdr: 'hdr10' } });
      l({
        attempt: 2,
        type: 'tracks',
        tracks: {
          audio: [{ id: 'a1', codec: 'audio/ac3' }],
          subtitles: [],
          selectedAudioId: 'a1',
          selectedSubtitleId: null,
        },
      });
      l({
        attempt: 2,
        type: 'error',
        error: { code: 'decoder', detail: 'MediaCodec fail https://u:p@host.test/1.ts' },
      });
      l({ attempt: 2, type: 'error', error: { code: 'http-509' } });
    }

    expect(recordMediaDecodeFailure).toHaveBeenCalledWith({
      engine: 'media3',
      container: 'mpegts',
      videoCodec: 'hevc',
      audioCodec: 'ac3',
      errorCode: 'decoder',
      hdrFormat: 'hdr10',
      isLive: true,
    });
    expect(recordPlaybackError).toHaveBeenCalledWith({
      engine: 'media3',
      errorCode: 'http-509',
      isLive: true,
    });
  });

  it('records playback_start TTFF and playback_rebuffer on media3 and aether only when opted in (#509)', () => {
    let now = 2_000;
    const listeners: Array<(event: unknown) => void> = [];
    const engine = {
      subscribe: (listener: (event: unknown) => void) => {
        listeners.push(listener);
        return () => {};
      },
    } as unknown as PlayerEngine;
    const recordPlaybackStart = vi.fn();
    const recordPlaybackRebuffer = vi.fn();

    const host = createMobileVideoHost(
      makeDeps({
        os: 'ios',
        isTV: true,
        createEngine: vi.fn(() => engine),
        clock: () => now,
        telemetry: {
          isOptedIn: () => true,
          recordMediaDecodeFailure: vi.fn(),
          recordPlaybackError: vi.fn(),
          recordPlaybackStart,
          recordPlaybackRebuffer,
        },
      }),
    );
    host.open();

    for (const l of listeners) {
      l({ attempt: 1, type: 'state', state: 'opening' });
      l({
        attempt: 1,
        type: 'clock',
        anchor: { positionMs: 0, durationMs: 3_600_000, atMs: 2_050, rate: 1 },
      });
      l({ attempt: 1, type: 'mediaInfo', info: { codec: 'video/hevc' } });
    }
    now = 2_380;
    for (const l of listeners) {
      l({ attempt: 1, type: 'firstFrame', atMs: 2_380 });
      l({ attempt: 1, type: 'state', state: 'playing' });
    }
    expect(recordPlaybackStart).toHaveBeenCalledTimes(1);
    expect(recordPlaybackStart).toHaveBeenCalledWith({
      engine: 'aether',
      ttffMs: 380,
      isLive: false,
      videoCodec: 'hevc',
    });

    now = 6_000;
    for (const l of listeners) {
      l({ attempt: 1, type: 'stall', phase: 'start', atMs: 6_000 });
    }
    now = 6_640;
    for (const l of listeners) {
      l({ attempt: 1, type: 'stall', phase: 'end', atMs: 6_640 });
    }
    expect(recordPlaybackRebuffer).toHaveBeenCalledWith({
      engine: 'aether',
      durationMs: 640,
      isLive: false,
    });
  });
});

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
    opened?.toggleMute?.();
    expect(deps.setAppleEngineMuted).toHaveBeenLastCalledWith(engine, false);
  });

  it('returns null from open when createEngine returns null', () => {
    const deps = makeDeps({ createEngine: vi.fn(() => null) });
    const host = createMobileVideoHost(deps);
    expect(host.open()).toBeNull();
  });
});

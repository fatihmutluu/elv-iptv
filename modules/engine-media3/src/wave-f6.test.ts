import type { EngineEvent } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function load() {
  vi.resetModules();
  return import('./index');
}

function fakeWaveF6Native() {
  const moduleListeners = new Map<string, Set<(payload: unknown) => void>>();
  const moduleRemove = vi.fn();
  const engine = {
    load: vi.fn(),
    retry: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    stop: vi.fn(),
    recreate: vi.fn(),
    release: vi.fn(),
    configureMultiView: vi.fn(),
    addListener: vi.fn((_name: string, _listener: (event: EngineEvent) => void) => ({
      remove: vi.fn(),
    })),
  };
  const Engine = vi.fn(function construct(_options?: unknown) {
    return engine;
  });
  const uptimeMs = vi.fn(() => 0);
  const enterPictureInPicture = vi.fn(() => true);
  const setAutoEnterPictureInPicture = vi.fn(() => true);
  const getThermalState = vi.fn(() => 'serious');
  const getDeviceMemoryInfo = vi.fn(() => ({
    isLowRamDevice: false,
    totalMemBytes: 4 * 1024 * 1024 * 1024,
    lowRam: false,
  }));
  const addListener = vi.fn((eventName: string, listener: (payload: unknown) => void) => {
    let set = moduleListeners.get(eventName);
    if (set === undefined) {
      set = new Set();
      moduleListeners.set(eventName, set);
    }
    set.add(listener);
    return {
      remove: () => {
        moduleRemove(eventName);
        set.delete(listener);
      },
    };
  });
  requireOptionalNativeModule.mockReturnValue({
    Engine,
    uptimeMs,
    enterPictureInPicture,
    setAutoEnterPictureInPicture,
    getThermalState,
    getDeviceMemoryInfo,
    addListener,
  });
  const emitModule = (eventName: string, payload: unknown) => {
    for (const listener of [...(moduleListeners.get(eventName) ?? [])]) listener(payload);
  };
  return {
    engine,
    Engine,
    enterPictureInPicture,
    setAutoEnterPictureInPicture,
    getThermalState,
    getDeviceMemoryInfo,
    moduleRemove,
    emitModule,
  };
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('Wave F6 Media3 native bindings (#34, #221, #232)', () => {
  it('exposes Android thermal state query and subscription with safe defaults (#232)', async () => {
    const native = fakeWaveF6Native();
    const mod = await load();

    expect(mod.getAndroidThermalState()).toBe('serious');
    native.getThermalState.mockReturnValueOnce('unknown-level');
    expect(mod.getAndroidThermalState()).toBe('nominal');

    const states: string[] = [];
    const off = mod.subscribeAndroidThermalState((state) => states.push(state));
    native.emitModule('onThermalStateChanged', { state: 'fair' });
    native.emitModule('onThermalStateChanged', { state: 'serious' });
    native.emitModule('onThermalStateChanged', { state: 'critical' });
    native.emitModule('onThermalStateChanged', 'nominal');
    native.emitModule('onThermalStateChanged', { state: 'invalid' });
    off();
    native.emitModule('onThermalStateChanged', { state: 'critical' });

    expect(states).toEqual(['fair', 'serious', 'critical', 'nominal']);
    expect(native.moduleRemove).toHaveBeenCalledWith('onThermalStateChanged');

    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.getAndroidThermalState()).toBe('nominal');
    expect(() => absent.subscribeAndroidThermalState(() => {})()).not.toThrow();
  });

  it('exposes Android device memory info with safe low-RAM fallback when absent (#232)', async () => {
    const native = fakeWaveF6Native();
    const mod = await load();

    expect(mod.getAndroidDeviceMemoryInfo()).toEqual({
      isLowRamDevice: false,
      totalMemBytes: 4 * 1024 * 1024 * 1024,
      lowRam: false,
    });

    native.getDeviceMemoryInfo.mockReturnValueOnce({
      isLowRamDevice: false,
      totalMemBytes: Number.NaN,
      lowRam: true,
    });
    expect(mod.getAndroidDeviceMemoryInfo()).toEqual({
      isLowRamDevice: false,
      totalMemBytes: 0,
      lowRam: true,
    });

    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.getAndroidDeviceMemoryInfo()).toEqual({
      isLowRamDevice: false,
      totalMemBytes: 0,
      lowRam: false,
    });
  });

  it('forwards optional sourceRect on enterAndroidPictureInPicture and setAndroidAutoEnterPictureInPicture (#34)', async () => {
    const native = fakeWaveF6Native();
    const mod = await load();

    expect(mod.enterAndroidPictureInPicture(16, 9)).toBe(true);
    expect(native.enterPictureInPicture).toHaveBeenNthCalledWith(1, 16, 9);

    expect(
      mod.enterAndroidPictureInPicture(16, 9, { left: 10, top: 20, right: 650, bottom: 380 }),
    ).toBe(true);
    expect(native.enterPictureInPicture).toHaveBeenNthCalledWith(2, 16, 9, 10, 20, 650, 380);

    // Invalid empty rect is omitted cleanly
    expect(
      mod.enterAndroidPictureInPicture(16, 9, { left: 100, top: 20, right: 100, bottom: 380 }),
    ).toBe(true);
    expect(native.enterPictureInPicture).toHaveBeenNthCalledWith(3, 16, 9);

    expect(
      mod.setAndroidAutoEnterPictureInPicture(true, 16, 9, {
        left: 0,
        top: 0,
        right: 1080,
        bottom: 608,
      }),
    ).toBe(true);
    expect(native.setAutoEnterPictureInPicture).toHaveBeenNthCalledWith(
      1,
      true,
      16,
      9,
      0,
      0,
      1080,
      608,
    );

    expect(mod.setAndroidAutoEnterPictureInPicture(false)).toBe(true);
    expect(native.setAutoEnterPictureInPicture).toHaveBeenNthCalledWith(
      2,
      false,
      undefined,
      undefined,
    );

    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.setAndroidAutoEnterPictureInPicture(true, 16, 9)).toBe(false);
  });

  it('forwards Multi-View handleAudioFocus and multiViewTileCount on engine creation and runtime updates (#34, #221)', async () => {
    const native = fakeWaveF6Native();
    const mod = await load();

    // Default creation keeps zero-arg constructor call
    const defaultEngine = mod.createMedia3Engine();
    expect(defaultEngine).not.toBeNull();
    expect(native.Engine).toHaveBeenNthCalledWith(1);

    // Secondary muted tile passes normalized options to native Engine constructor
    const secondary = mod.createMedia3Engine({
      handleAudioFocus: false,
      multiViewTileCount: 9,
    });
    expect(secondary).not.toBeNull();
    expect(native.Engine).toHaveBeenNthCalledWith(2, {
      handleAudioFocus: false,
      multiViewTileCount: 4,
    });

    if (secondary === null) throw new Error('secondary engine expected');
    mod.configureMedia3MultiView(secondary, { handleAudioFocus: true, multiViewTileCount: 2 });
    expect(native.engine.configureMultiView).toHaveBeenCalledWith(true, 2);

    // Released engine ignores Multi-View updates cleanly
    secondary.release();
    mod.configureMedia3MultiView(secondary, { handleAudioFocus: false, multiViewTileCount: 3 });
    expect(native.engine.configureMultiView).toHaveBeenCalledTimes(1);
  });
});

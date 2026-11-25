import type { PlayerEngine } from '@elv/playback';
import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function load() {
  vi.resetModules();
  return import('./index');
}

type ModuleEventName = 'onPictureInPictureChanged' | 'onThermalStateChanged';
type ModuleListener = (payload: unknown) => void;

function fakeNative() {
  const moduleListeners = new Map<ModuleEventName, Set<ModuleListener>>();
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
    addListener: vi.fn(() => ({ remove: vi.fn() })),
  };
  const Engine = vi.fn(function construct() {
    return engine;
  });
  const uptimeMs = vi.fn(() => 0);
  const engineVersion = vi.fn(() => '7.66.1');
  const enterPictureInPicture = vi.fn<(...args: unknown[]) => boolean>(() => true);
  const canStartPictureInPicture = vi.fn<(...args: unknown[]) => boolean>(() => true);
  const setAutoEnterPictureInPicture = vi.fn<(...args: unknown[]) => boolean>(() => true);
  const thermalState = vi.fn<() => unknown>(() => 'nominal');
  const physicalMemoryBytes = vi.fn<() => unknown>(() => 4_294_967_296);
  const addListener = vi.fn((name: ModuleEventName, listener: ModuleListener) => {
    let bucket = moduleListeners.get(name);
    if (bucket === undefined) {
      bucket = new Set();
      moduleListeners.set(name, bucket);
    }
    bucket.add(listener);
    return {
      remove: () => {
        moduleRemove();
        bucket?.delete(listener);
      },
    };
  });

  requireOptionalNativeModule.mockReturnValue({
    Engine,
    uptimeMs,
    engineVersion,
    enterPictureInPicture,
    canStartPictureInPicture,
    setAutoEnterPictureInPicture,
    thermalState,
    physicalMemoryBytes,
    addListener,
  });

  const emitModule = (name: ModuleEventName, payload: unknown) => {
    for (const listener of [...(moduleListeners.get(name) ?? [])]) {
      listener(payload);
    }
  };

  return {
    engine,
    enterPictureInPicture,
    canStartPictureInPicture,
    setAutoEnterPictureInPicture,
    thermalState,
    physicalMemoryBytes,
    addListener,
    moduleRemove,
    emitModule,
  };
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
  vi.restoreAllMocks();
});

describe('Apple Aether Picture-in-Picture bridge (#34)', () => {
  it('returns false and no-ops safely when the native module is absent or throws', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.canStartAetherPictureInPicture()).toBe(false);
    expect(absent.enterAetherPictureInPicture()).toBe(false);
    expect(absent.setAetherAutoEnterPictureInPicture(true)).toBe(false);
    const unsub = absent.subscribeAetherPictureInPicture(vi.fn());
    expect(() => unsub()).not.toThrow();

    const native = fakeNative();
    native.canStartPictureInPicture.mockImplementation(() => {
      throw new Error('bridge error');
    });
    native.enterPictureInPicture.mockImplementation(() => {
      throw new Error('bridge error');
    });
    native.setAutoEnterPictureInPicture.mockImplementation(() => {
      throw new Error('bridge error');
    });
    const mod = await load();
    expect(mod.canStartAetherPictureInPicture()).toBe(false);
    expect(mod.enterAetherPictureInPicture()).toBe(false);
    expect(mod.setAetherAutoEnterPictureInPicture(true)).toBe(false);
  });

  it('forwards PiP capability, entry, and auto-enter calls with optional engine targeting', async () => {
    const native = fakeNative();
    const mod = await load();
    const engine = mod.createAetherEngine();
    if (engine === null) throw new Error('engine expected');

    expect(mod.canStartAetherPictureInPicture()).toBe(true);
    expect(native.canStartPictureInPicture).toHaveBeenLastCalledWith();

    expect(mod.enterAetherPictureInPicture()).toBe(true);
    expect(native.enterPictureInPicture).toHaveBeenLastCalledWith();

    expect(mod.setAetherAutoEnterPictureInPicture(true)).toBe(true);
    expect(native.setAutoEnterPictureInPicture).toHaveBeenLastCalledWith(true);

    expect(mod.canStartAetherPictureInPicture(engine)).toBe(true);
    expect(native.canStartPictureInPicture).toHaveBeenLastCalledWith(native.engine);

    expect(mod.enterAetherPictureInPicture(engine)).toBe(true);
    expect(native.enterPictureInPicture).toHaveBeenLastCalledWith(native.engine);

    expect(mod.setAetherAutoEnterPictureInPicture(false, engine)).toBe(true);
    expect(native.setAutoEnterPictureInPicture).toHaveBeenLastCalledWith(false, native.engine);

    // Raw-TS non-AVPlayer route returns false cleanly without throwing
    native.canStartPictureInPicture.mockReturnValueOnce(false);
    native.enterPictureInPicture.mockReturnValueOnce(false);
    expect(mod.canStartAetherPictureInPicture()).toBe(false);
    expect(mod.enterAetherPictureInPicture()).toBe(false);

    // Foreign or released engine returns false without invoking native
    const foreign = { release() {} } as unknown as PlayerEngine;
    expect(mod.canStartAetherPictureInPicture(foreign)).toBe(false);
    expect(mod.enterAetherPictureInPicture(foreign)).toBe(false);
    expect(mod.setAetherAutoEnterPictureInPicture(true, foreign)).toBe(false);

    engine.release();
    expect(mod.canStartAetherPictureInPicture(engine)).toBe(false);
    expect(mod.enterAetherPictureInPicture(engine)).toBe(false);
    expect(mod.setAetherAutoEnterPictureInPicture(true, engine)).toBe(false);
  });

  it('subscribes to onPictureInPictureChanged and normalizes boolean and object payloads', async () => {
    const native = fakeNative();
    const mod = await load();
    const events: boolean[] = [];
    const unsubscribe = mod.subscribeAetherPictureInPicture((inPip) => events.push(inPip));

    expect(native.addListener).toHaveBeenCalledWith(
      'onPictureInPictureChanged',
      expect.any(Function),
    );
    native.emitModule('onPictureInPictureChanged', { inPip: true });
    native.emitModule('onPictureInPictureChanged', { inPip: false });
    native.emitModule('onPictureInPictureChanged', true);
    native.emitModule('onPictureInPictureChanged', null);
    expect(events).toEqual([true, false, true, false]);

    unsubscribe();
    expect(native.moduleRemove).toHaveBeenCalledTimes(1);
    native.emitModule('onPictureInPictureChanged', { inPip: true });
    expect(events).toHaveLength(4);
  });
});

describe('Apple thermal watchdog and physical memory probe (#232)', () => {
  it('defaults to nominal and 0 bytes safely when native module is absent, throws, or returns invalid values', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const absent = await load();
    expect(absent.getAppleThermalState()).toBe('nominal');
    expect(absent.getApplePhysicalMemoryBytes()).toBe(0);
    const noopUnsub = absent.subscribeAppleThermalState(vi.fn());
    expect(() => noopUnsub()).not.toThrow();

    const native = fakeNative();
    native.thermalState.mockReturnValueOnce('unknown').mockImplementationOnce(() => {
      throw new Error('bridge error');
    });
    native.physicalMemoryBytes
      .mockReturnValueOnce(Number.NaN)
      .mockReturnValueOnce(-128)
      .mockImplementationOnce(() => {
        throw new Error('bridge error');
      });
    const mod = await load();
    expect(mod.getAppleThermalState()).toBe('nominal');
    expect(mod.getAppleThermalState()).toBe('nominal');
    expect(mod.getApplePhysicalMemoryBytes()).toBe(0);
    expect(mod.getApplePhysicalMemoryBytes()).toBe(0);
    expect(mod.getApplePhysicalMemoryBytes()).toBe(0);
  });

  it('reads all valid Apple thermal states and physical memory bytes', async () => {
    const native = fakeNative();
    const mod = await load();

    for (const level of ['nominal', 'fair', 'serious', 'critical'] as const) {
      native.thermalState.mockReturnValueOnce(level);
      expect(mod.getAppleThermalState()).toBe(level);
    }

    native.physicalMemoryBytes.mockReturnValueOnce(3_221_225_472.9);
    expect(mod.getApplePhysicalMemoryBytes()).toBe(3_221_225_472);
  });

  it('validates and forwards onThermalStateChanged updates and cleans up subscriptions', async () => {
    const native = fakeNative();
    const mod = await load();
    const states: string[] = [];
    const unsubscribe = mod.subscribeAppleThermalState((state) => states.push(state));

    expect(native.addListener).toHaveBeenCalledWith('onThermalStateChanged', expect.any(Function));

    native.emitModule('onThermalStateChanged', { state: 'nominal' });
    native.emitModule('onThermalStateChanged', { state: 'fair' });
    native.emitModule('onThermalStateChanged', { state: 'serious' });
    native.emitModule('onThermalStateChanged', { state: 'critical' });
    native.emitModule('onThermalStateChanged', 'serious');
    native.emitModule('onThermalStateChanged', { state: 'overheated' });
    native.emitModule('onThermalStateChanged', { state: 2 });
    native.emitModule('onThermalStateChanged', null);

    expect(states).toEqual(['nominal', 'fair', 'serious', 'critical', 'serious']);

    unsubscribe();
    expect(native.moduleRemove).toHaveBeenCalledTimes(1);
    native.emitModule('onThermalStateChanged', { state: 'critical' });
    expect(states).toHaveLength(5);
  });
});

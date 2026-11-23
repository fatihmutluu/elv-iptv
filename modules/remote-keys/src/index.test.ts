import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteKeyEvent } from './index';

const requireOptionalNativeModule = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule }));

async function loadModule() {
  vi.resetModules();
  return import('./index');
}

async function load() {
  return (await loadModule()).remoteKeys;
}

type NativeEvent =
  | { action: 'down' | 'up'; keyCode: number; canceled: boolean; eventTime: number }
  | { action: 'blur' };

/** A native module double whose `uptimeMs()` reads `clock.now`; `emit` delivers one native `onKey` payload. */
function fakeNative(options: { withPan?: boolean } = {}) {
  const clock = { now: 0 };
  const listeners = new Map<string, (event: unknown) => void>();
  const remove = vi.fn();
  const addListener = vi.fn((name: string, listener: (event: unknown) => void) => {
    listeners.set(name, listener);
    return { remove };
  });
  const uptimeMs = vi.fn(() => clock.now);
  const setPanGestureEnabled = options.withPan ? vi.fn() : undefined;
  requireOptionalNativeModule.mockReturnValue({
    addListener,
    uptimeMs,
    ...(setPanGestureEnabled !== undefined ? { setPanGestureEnabled } : {}),
  });
  return {
    clock,
    addListener,
    remove,
    uptimeMs,
    setPanGestureEnabled,
    emit: (e: NativeEvent) => listeners.get('onKey')?.(e),
    emitPan: (e: unknown) => listeners.get('onPanGesture')?.(e),
  };
}

afterEach(() => requireOptionalNativeModule.mockReset());

describe('remoteKeys', () => {
  it('is null when the native module is absent', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    expect(await load()).toBeNull();
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvRemoteKeys');
  });

  it('subscribes to onKey and removes the subscription', async () => {
    const native = fakeNative();
    const source = await load();
    const subscription = source?.addListener(() => {});
    expect(native.addListener).toHaveBeenCalledWith('onKey', expect.any(Function));
    subscription?.remove();
    expect(native.remove).toHaveBeenCalledTimes(1);
  });

  it('measures the age at JS receipt, so the wait for the JS thread counts', async () => {
    const native = fakeNative();
    const source = await load();
    const events: RemoteKeyEvent[] = [];
    source?.addListener((e) => events.push(e));
    native.clock.now = 1_000;
    native.emit({ action: 'down', keyCode: 20, canceled: false, eventTime: 960 });
    native.clock.now = 1_250;
    native.emit({ action: 'up', keyCode: 20, canceled: true, eventTime: 1_100 });
    expect(events).toEqual([
      { action: 'down', keyCode: 20, canceled: false, ageMs: 40 },
      { action: 'up', keyCode: 20, canceled: true, ageMs: 150 },
    ]);
  });

  it('never reports a negative age', async () => {
    const native = fakeNative();
    const source = await load();
    const events: RemoteKeyEvent[] = [];
    source?.addListener((e) => events.push(e));
    native.clock.now = 500;
    native.emit({ action: 'down', keyCode: 23, canceled: false, eventTime: 505 });
    expect(events).toEqual([{ action: 'down', keyCode: 23, canceled: false, ageMs: 0 }]);
  });

  it('passes blur on unchanged without reading the clock', async () => {
    const native = fakeNative();
    const source = await load();
    const events: RemoteKeyEvent[] = [];
    source?.addListener((e) => events.push(e));
    native.emit({ action: 'blur' });
    expect(events).toEqual([{ action: 'blur' }]);
    expect(native.uptimeMs).not.toHaveBeenCalled();
  });
});

describe('remotePanGestures (#225)', () => {
  it('is null when the native module is absent or lacks setPanGestureEnabled (Android)', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    expect((await loadModule()).remotePanGestures).toBeNull();

    fakeNative({ withPan: false });
    expect((await loadModule()).remotePanGestures).toBeNull();
  });

  it('forwards setEnabled and validated onPanGesture events and cleans up listeners', async () => {
    const native = fakeNative({ withPan: true });
    const { remotePanGestures } = await loadModule();
    expect(remotePanGestures).not.toBeNull();

    remotePanGestures?.setEnabled(true);
    remotePanGestures?.setEnabled(false);
    expect(native.setPanGestureEnabled).toHaveBeenNthCalledWith(1, true);
    expect(native.setPanGestureEnabled).toHaveBeenNthCalledWith(2, false);

    const events: unknown[] = [];
    const sub = remotePanGestures?.addListener((event) => events.push(event));
    expect(native.addListener).toHaveBeenCalledWith('onPanGesture', expect.any(Function));

    native.emitPan({ axis: 'horizontal', phase: 'began', translation: 24, velocity: 180 });
    native.emitPan({ axis: 'horizontal', phase: 'changed', translation: 64, velocity: 220 });
    native.emitPan({ axis: 'vertical', phase: 'ended', translation: -42, velocity: -90 });
    native.emitPan({ axis: 'vertical', phase: 'cancelled', translation: -10, velocity: 0 });
    // Malformed payloads are ignored safely.
    native.emitPan({ axis: 'diagonal', phase: 'began', translation: 20, velocity: 10 });
    native.emitPan({ axis: 'horizontal', phase: 'unknown', translation: 20, velocity: 10 });
    native.emitPan({ axis: 'horizontal', phase: 'changed', translation: Number.NaN, velocity: 10 });
    native.emitPan(null);

    expect(events).toEqual([
      { axis: 'horizontal', phase: 'began', translation: 24, velocity: 180 },
      { axis: 'horizontal', phase: 'changed', translation: 64, velocity: 220 },
      { axis: 'vertical', phase: 'ended', translation: -42, velocity: -90 },
      { axis: 'vertical', phase: 'cancelled', translation: -10, velocity: 0 },
    ]);

    sub?.remove();
    expect(native.remove).toHaveBeenCalledTimes(1);
  });
});

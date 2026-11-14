import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteKeyEvent } from './index';

const requireOptionalNativeModule = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule }));

async function load() {
  vi.resetModules();
  return (await import('./index')).remoteKeys;
}

type NativeEvent =
  | { action: 'down' | 'up'; keyCode: number; canceled: boolean; eventTime: number }
  | { action: 'blur' };

/** A native module double whose `uptimeMs()` reads `clock.now`; `emit` delivers one native `onKey` payload. */
function fakeNative() {
  const clock = { now: 0 };
  let nativeListener: ((event: NativeEvent) => void) | undefined;
  const remove = vi.fn();
  const addListener = vi.fn((_name: string, listener: (event: NativeEvent) => void) => {
    nativeListener = listener;
    return { remove };
  });
  const uptimeMs = vi.fn(() => clock.now);
  requireOptionalNativeModule.mockReturnValue({ addListener, uptimeMs });
  return { clock, addListener, remove, uptimeMs, emit: (e: NativeEvent) => nativeListener?.(e) };
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

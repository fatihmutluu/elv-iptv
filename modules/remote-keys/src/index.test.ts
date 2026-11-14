import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule }));

async function load() {
  vi.resetModules();
  return (await import('./index')).remoteKeys;
}

afterEach(() => requireOptionalNativeModule.mockReset());

describe('remoteKeys', () => {
  it('is null when the native module is absent', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    expect(await load()).toBeNull();
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvRemoteKeys');
  });

  it('subscribes to onKey and removes the subscription', async () => {
    const remove = vi.fn();
    const addListener = vi.fn(() => ({ remove }));
    requireOptionalNativeModule.mockReturnValue({ addListener });
    const source = await load();
    const listener = vi.fn();
    const subscription = source?.addListener(listener);
    expect(addListener).toHaveBeenCalledWith('onKey', listener);
    subscription?.remove();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

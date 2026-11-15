import { afterEach, describe, expect, it, vi } from 'vitest';

const requireOptionalNativeModule = vi.fn();
const requireNativeViewManager = vi.fn();
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule, requireNativeViewManager }));

async function load() {
  vi.resetModules();
  return import('./index');
}

afterEach(() => {
  requireOptionalNativeModule.mockReset();
  requireNativeViewManager.mockReset();
});

describe('aetherEngineVersion', () => {
  it('is null without the native module', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    expect((await load()).aetherEngineVersion()).toBeNull();
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvEngineAether');
  });

  it('returns the native engine version', async () => {
    requireOptionalNativeModule.mockReturnValue({ engineVersion: () => '7.66.1' });
    expect((await load()).aetherEngineVersion()).toBe('7.66.1');
  });
});

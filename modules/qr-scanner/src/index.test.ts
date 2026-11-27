import { afterEach, describe, expect, it, vi } from 'vitest';

const platformState: { OS: string; isTV?: boolean } = { OS: 'android' };
const requireOptionalNativeModule = vi.fn();

vi.mock('expo-modules-core', () => ({
  get Platform() {
    return platformState;
  },
  requireOptionalNativeModule,
}));

async function loadModule() {
  vi.resetModules();
  return import('./index');
}

function fakeNative(
  overrides: Partial<{ isAvailable: () => boolean; scan: () => Promise<string | null> }> = {},
) {
  const isAvailable = vi.fn(overrides.isAvailable ?? (() => true));
  const scan = vi.fn(overrides.scan ?? (async () => 'elviptv://pair?c=12345678&pk=AAA'));
  requireOptionalNativeModule.mockReturnValue({ isAvailable, scan });
  return { isAvailable, scan };
}

afterEach(() => {
  platformState.OS = 'android';
  delete platformState.isTV;
  requireOptionalNativeModule.mockReset();
});

describe('@elv/qr-scanner JS bridge', () => {
  it('returns false/null on web without querying native modules', async () => {
    platformState.OS = 'web';
    fakeNative();
    const mod = await loadModule();

    expect(mod.isQrScannerAvailable()).toBe(false);
    await expect(mod.scanQrCode()).resolves.toBeNull();
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
  });

  it('returns false/null on TV targets without querying native modules', async () => {
    platformState.OS = 'ios';
    platformState.isTV = true;
    fakeNative();
    const mod = await loadModule();

    expect(mod.isQrScannerAvailable()).toBe(false);
    await expect(mod.scanQrCode()).resolves.toBeNull();
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
  });

  it('returns false/null on non-mobile platforms such as macos or windows', async () => {
    platformState.OS = 'macos';
    fakeNative();
    const mod = await loadModule();

    expect(mod.isQrScannerAvailable()).toBe(false);
    await expect(mod.scanQrCode()).resolves.toBeNull();
    expect(requireOptionalNativeModule).not.toHaveBeenCalled();
  });

  it('returns false/null safely when the native module is absent or throws on require', async () => {
    requireOptionalNativeModule.mockReturnValue(null);
    const mod = await loadModule();

    expect(mod.isQrScannerAvailable()).toBe(false);
    await expect(mod.scanQrCode()).resolves.toBeNull();
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvQrScanner');

    requireOptionalNativeModule.mockImplementation(() => {
      throw new Error('Native bridge missing');
    });
    expect(mod.isQrScannerAvailable()).toBe(false);
    await expect(mod.scanQrCode()).resolves.toBeNull();
  });

  it('delegates availability and trims scanned QR payloads on handheld iOS and Android', async () => {
    platformState.OS = 'ios';
    const native = fakeNative({
      isAvailable: () => true,
      scan: async () => '  elviptv://pair?c=87654321&pk=XYZ  \n',
    });
    const mod = await loadModule();

    expect(mod.isQrScannerAvailable()).toBe(true);
    await expect(mod.scanQrCode()).resolves.toBe('elviptv://pair?c=87654321&pk=XYZ');
    expect(requireOptionalNativeModule).toHaveBeenCalledWith('ElvQrScanner');
    expect(native.isAvailable).toHaveBeenCalled();
    expect(native.scan).toHaveBeenCalledTimes(1);
  });

  it('returns null when native reports unavailable, cancels, returns whitespace, or throws', async () => {
    platformState.OS = 'android';
    const nativeUnavailable = fakeNative({ isAvailable: () => false });
    const mod = await loadModule();

    expect(mod.isQrScannerAvailable()).toBe(false);
    await expect(mod.scanQrCode()).resolves.toBeNull();
    expect(nativeUnavailable.scan).not.toHaveBeenCalled();

    fakeNative({ isAvailable: () => true, scan: async () => null });
    await expect(mod.scanQrCode()).resolves.toBeNull();

    fakeNative({ isAvailable: () => true, scan: async () => '   \n\t  ' });
    await expect(mod.scanQrCode()).resolves.toBeNull();

    fakeNative({
      isAvailable: () => {
        throw new Error('camera check error');
      },
    });
    expect(mod.isQrScannerAvailable()).toBe(false);

    fakeNative({
      isAvailable: () => true,
      scan: async () => {
        throw new Error('camera cancelled');
      },
    });
    await expect(mod.scanQrCode()).resolves.toBeNull();
  });
});

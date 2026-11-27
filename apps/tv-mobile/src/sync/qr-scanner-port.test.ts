import { afterEach, describe, expect, it, vi } from 'vitest';

const platformState = { isTV: false };
const qrScannerMocks = vi.hoisted(() => ({
  isQrScannerAvailable: vi.fn<() => boolean>(() => false),
  scanQrCode: vi.fn<() => Promise<string | null>>(async () => null),
}));

vi.mock('react-native', () => ({
  Platform: {
    get isTV() {
      return platformState.isTV;
    },
  },
}));

vi.mock('@elv/qr-scanner', () => ({
  isQrScannerAvailable: () => qrScannerMocks.isQrScannerAvailable(),
  scanQrCode: () => qrScannerMocks.scanQrCode(),
}));

import { createMobileQrScannerPort, createNativeMobileQrScannerBackend } from './qr-scanner-port';

afterEach(() => {
  platformState.isTV = false;
  qrScannerMocks.isQrScannerAvailable.mockReset().mockReturnValue(false);
  qrScannerMocks.scanQrCode.mockReset().mockResolvedValue(null);
});

describe('createMobileQrScannerPort (#510)', () => {
  it('gracefully reports unsupported and resolves null when no native scanner is available', async () => {
    const port = createMobileQrScannerPort();
    expect(port.isSupported()).toBe(false);
    expect(await port.scanQrCode()).toBeNull();
  });

  it('delegates cleanly to an injected native scanner seam', async () => {
    const nativeScan = vi.fn(async () => 'elviptv://pair?c=12345678&pk=AAA');
    const port = createMobileQrScannerPort({
      isAvailable: () => true,
      scan: nativeScan,
    });
    expect(port.isSupported()).toBe(true);
    expect(await port.scanQrCode()).toBe('elviptv://pair?c=12345678&pk=AAA');
    expect(nativeScan).toHaveBeenCalledTimes(1);
  });

  it('always reports unsupported on TV targets even if native module reports available', async () => {
    platformState.isTV = true;
    qrScannerMocks.isQrScannerAvailable.mockReturnValue(true);
    qrScannerMocks.scanQrCode.mockResolvedValue('elviptv://pair?c=12345678&pk=AAA');

    const port = createMobileQrScannerPort(createNativeMobileQrScannerBackend());
    expect(port.isSupported()).toBe(false);
    await expect(port.scanQrCode()).resolves.toBeNull();
    expect(qrScannerMocks.scanQrCode).not.toHaveBeenCalled();
  });

  it('supports handheld targets when native scanner is available and trims scanned payloads', async () => {
    platformState.isTV = false;
    qrScannerMocks.isQrScannerAvailable.mockReturnValue(true);
    qrScannerMocks.scanQrCode.mockResolvedValue('  elviptv://pair?c=12345678&pk=AAA  \n');

    const port = createMobileQrScannerPort(createNativeMobileQrScannerBackend());
    expect(port.isSupported()).toBe(true);
    await expect(port.scanQrCode()).resolves.toBe('elviptv://pair?c=12345678&pk=AAA');
    expect(qrScannerMocks.scanQrCode).toHaveBeenCalledTimes(1);
  });

  it('resolves null on cancellation, whitespace payloads, or native scanner errors', async () => {
    platformState.isTV = false;
    qrScannerMocks.isQrScannerAvailable.mockReturnValue(true);

    const port = createMobileQrScannerPort(createNativeMobileQrScannerBackend());

    qrScannerMocks.scanQrCode.mockResolvedValueOnce(null);
    await expect(port.scanQrCode()).resolves.toBeNull();

    qrScannerMocks.scanQrCode.mockResolvedValueOnce('   \t\n  ');
    await expect(port.scanQrCode()).resolves.toBeNull();

    qrScannerMocks.scanQrCode.mockRejectedValueOnce(new Error('permission denied'));
    await expect(port.scanQrCode()).resolves.toBeNull();

    qrScannerMocks.isQrScannerAvailable.mockImplementationOnce(() => {
      throw new Error('module lookup error');
    });
    expect(port.isSupported()).toBe(false);
  });
});

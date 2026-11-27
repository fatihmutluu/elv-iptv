import { describe, expect, it, vi } from 'vitest';
import { createMobileQrScannerPort } from './qr-scanner-port';

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
});

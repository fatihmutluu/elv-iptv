import type { QrScannerPort } from '@elv/features';
import { isQrScannerAvailable, scanQrCode } from '@elv/qr-scanner';
import { Platform } from 'react-native';

/** Optional native camera scanner backend injected into {@link createMobileQrScannerPort}. */
export interface MobileQrScannerBackend {
  readonly isAvailable: () => boolean;
  readonly scan: () => Promise<string | null>;
}

/**
 * Creates the native {@link MobileQrScannerBackend} backed by `@elv/qr-scanner` (`#510`).
 * Always reports unavailable and resolves `null` on TV targets (`Platform.isTV === true`).
 */
export function createNativeMobileQrScannerBackend(): MobileQrScannerBackend {
  return {
    isAvailable: () => {
      if (Platform.isTV) return false;
      return isQrScannerAvailable();
    },
    scan: async () => {
      if (Platform.isTV) return null;
      return scanQrCode();
    },
  };
}

/**
 * Creates a safe {@link QrScannerPort} seam for phone/tablet pairing (`#510`).
 * Gracefully reports `isSupported() === false` and resolves `null` when no native camera
 * barcode module is installed (e.g. TV builds or builds without a camera dependency).
 */
export function createMobileQrScannerPort(backend?: MobileQrScannerBackend): QrScannerPort {
  return {
    isSupported(): boolean {
      if (backend === undefined) return false;
      try {
        return Boolean(backend.isAvailable());
      } catch {
        return false;
      }
    },
    async scanQrCode(): Promise<string | null> {
      if (backend === undefined || !this.isSupported()) return null;
      try {
        const scanned = await backend.scan();
        return typeof scanned === 'string' && scanned.trim().length > 0 ? scanned.trim() : null;
      } catch {
        return null;
      }
    },
  };
}

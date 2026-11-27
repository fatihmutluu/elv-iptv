import { Platform, requireOptionalNativeModule } from 'expo-modules-core';

interface NativeQrScannerModule {
  isAvailable(): boolean;
  scan(): Promise<string | null>;
}

function getNativeQrScannerModule(): NativeQrScannerModule | null {
  const platform = Platform as { readonly OS: string; readonly isTV?: boolean };
  if (platform.OS === 'web' || platform.isTV === true) {
    return null;
  }
  if (platform.OS !== 'ios' && platform.OS !== 'android') {
    return null;
  }
  try {
    return requireOptionalNativeModule<NativeQrScannerModule>('ElvQrScanner');
  } catch {
    return null;
  }
}

/**
 * Returns `true` when the native `ElvQrScanner` module is linked and camera hardware is available
 * on a handheld iOS/iPadOS or Android phone/tablet device. Always returns `false` on web, Node,
 * desktop, and TV targets (`tvOS`, Android TV, Fire OS).
 */
export function isQrScannerAvailable(): boolean {
  const native = getNativeQrScannerModule();
  if (native === null || typeof native.isAvailable !== 'function') {
    return false;
  }
  try {
    return Boolean(native.isAvailable());
  } catch {
    return false;
  }
}

/**
 * Presents the native in-app camera QR code scanner and resolves with the trimmed QR payload, or
 * `null` if cancelled, denied camera permission, unsupported, or running on TV/web/desktop.
 */
export async function scanQrCode(): Promise<string | null> {
  const native = getNativeQrScannerModule();
  if (
    native === null ||
    typeof native.isAvailable !== 'function' ||
    typeof native.scan !== 'function'
  ) {
    return null;
  }
  try {
    if (!native.isAvailable()) {
      return null;
    }
    const raw = await native.scan();
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

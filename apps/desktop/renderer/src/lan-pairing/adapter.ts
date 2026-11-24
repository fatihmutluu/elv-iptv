import type { LanPairingPort } from '@elv/features';
import type { LanPairingBridge } from '../../../src/shared/lan-pairing-ipc.ts';

/**
 * Adapts the preload's frozen `window.elv.lanPairing` bridge into `@elv/features`'s
 * {@link LanPairingPort} (`#50`). Returns `undefined` when running without Electron preload.
 */
export function createDesktopLanPairingPort(bridge?: LanPairingBridge): LanPairingPort | undefined {
  if (!bridge) return undefined;
  return {
    isSupported: () => true,
    startSession: (opts) => bridge.startSession(opts),
    stopSession: () => bridge.stopSession(),
    onPayloadReceived: (listener) => bridge.onPayloadReceived(listener),
  };
}

import type { PlayerBridge } from '../../src/shared/player-ipc.ts';

declare global {
  interface Window {
    /** Set by the Electron preload; absent in a plain browser. */
    elv?: { readonly player: PlayerBridge; readonly gate?: boolean };
  }
}

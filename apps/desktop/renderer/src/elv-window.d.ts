import type { ArtworkBridge } from '../../src/shared/artwork-ipc.ts';
import type { CatalogBridge } from '../../src/shared/catalog-ipc.ts';
import type { LanPairingBridge } from '../../src/shared/lan-pairing-ipc.ts';
import type { PlayerBridge, PresenterKind } from '../../src/shared/player-ipc.ts';
import type { SourcesBridge } from '../../src/shared/sources-ipc.ts';
import type { WindowBridge } from '../../src/shared/window-ipc.ts';

declare global {
  interface Window {
    /** Set by the Electron preload; absent in a plain browser. */
    elv?: {
      readonly player: PlayerBridge;
      readonly catalog: CatalogBridge;
      readonly artwork?: ArtworkBridge;
      readonly window?: WindowBridge;
      readonly sources?: SourcesBridge;
      readonly lanPairing?: LanPairingBridge;
      readonly gate?: boolean;
      readonly presenter?: PresenterKind | undefined;
    };
  }
}

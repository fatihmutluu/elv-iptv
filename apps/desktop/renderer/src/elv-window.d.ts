import type { ArtworkBridge } from '../../src/shared/artwork-ipc.ts';
import type { CatalogBridge } from '../../src/shared/catalog-ipc.ts';
import type { PlayerBridge } from '../../src/shared/player-ipc.ts';

declare global {
  interface Window {
    /** Set by the Electron preload; absent in a plain browser. */
    elv?: {
      readonly player: PlayerBridge;
      readonly catalog: CatalogBridge;
      readonly artwork?: ArtworkBridge;
      readonly gate?: boolean;
    };
  }
}

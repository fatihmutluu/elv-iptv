import { contextBridge, ipcRenderer, sharedTexture } from 'electron';
import { createArtworkBridge } from './artwork-bridge.ts';
import { createCatalogBridge } from './catalog-bridge.ts';
import { isGateMode, parsePresenterArg } from './gate-flag.ts';
import { createLanPairingBridge } from './lan-pairing-bridge.ts';
import { createPlayerBridge } from './player-bridge.ts';
import { createSourcesBridge } from './sources-bridge.ts';
import { createWindowBridge } from './window-bridge.ts';

contextBridge.exposeInMainWorld(
  'elv',
  Object.freeze({
    player: createPlayerBridge(ipcRenderer, sharedTexture),
    catalog: createCatalogBridge(ipcRenderer),
    artwork: createArtworkBridge(ipcRenderer),
    window: createWindowBridge(ipcRenderer),
    sources: createSourcesBridge(ipcRenderer),
    lanPairing: createLanPairingBridge(ipcRenderer),
    gate: isGateMode(process.argv),
    presenter: parsePresenterArg(process.argv),
  }),
);

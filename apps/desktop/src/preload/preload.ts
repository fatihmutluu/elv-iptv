import { contextBridge, ipcRenderer, sharedTexture } from 'electron';
import { createArtworkBridge } from './artwork-bridge.ts';
import { createCatalogBridge } from './catalog-bridge.ts';
import { isGateMode } from './gate-flag.ts';
import { createPlayerBridge } from './player-bridge.ts';

contextBridge.exposeInMainWorld(
  'elv',
  Object.freeze({
    player: createPlayerBridge(ipcRenderer, sharedTexture),
    catalog: createCatalogBridge(ipcRenderer),
    artwork: createArtworkBridge(ipcRenderer),
    gate: isGateMode(process.argv),
  }),
);

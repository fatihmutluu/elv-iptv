import { contextBridge, ipcRenderer, sharedTexture } from 'electron';
import { createCatalogBridge } from './catalog-bridge.ts';
import { isGateMode } from './gate-flag.ts';
import { createPlayerBridge } from './player-bridge.ts';

contextBridge.exposeInMainWorld(
  'elv',
  Object.freeze({
    player: createPlayerBridge(ipcRenderer, sharedTexture),
    catalog: createCatalogBridge(ipcRenderer),
    gate: isGateMode(process.argv),
  }),
);

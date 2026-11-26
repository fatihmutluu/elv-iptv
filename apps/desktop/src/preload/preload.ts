import { contextBridge, ipcRenderer, sharedTexture } from 'electron';
import { createArtworkBridge } from './artwork-bridge.ts';
import { createCatalogBridge } from './catalog-bridge.ts';
import { createDiagnosticsBridge } from './diagnostics-bridge.ts';
import { createDownloadsBridge } from './downloads-bridge.ts';
import { isGateMode, parsePresenterArg } from './gate-flag.ts';
import { createLanPairingBridge } from './lan-pairing-bridge.ts';
import { createPlayerBridge } from './player-bridge.ts';
import { createSourcesBridge } from './sources-bridge.ts';
import { createSyncBridges } from './sync-bridge.ts';
import { createWindowBridge } from './window-bridge.ts';

const syncBridges = createSyncBridges(ipcRenderer);

contextBridge.exposeInMainWorld(
  'elv',
  Object.freeze({
    player: createPlayerBridge(ipcRenderer, sharedTexture),
    catalog: createCatalogBridge(ipcRenderer),
    artwork: createArtworkBridge(ipcRenderer),
    window: createWindowBridge(ipcRenderer),
    sources: createSourcesBridge(ipcRenderer),
    lanPairing: createLanPairingBridge(ipcRenderer),
    diagnostics: createDiagnosticsBridge(ipcRenderer),
    downloads: createDownloadsBridge(ipcRenderer),
    sync: syncBridges.sync,
    telemetry: syncBridges.telemetry,
    feedback: syncBridges.feedback,
    gate: isGateMode(process.argv),
    presenter: parsePresenterArg(process.argv),
  }),
);

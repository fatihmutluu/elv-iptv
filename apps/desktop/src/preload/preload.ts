import { contextBridge, ipcRenderer } from 'electron';
import { isGateMode } from './gate-flag.ts';
import { createPlayerBridge } from './player-bridge.ts';

contextBridge.exposeInMainWorld(
  'elv',
  Object.freeze({ player: createPlayerBridge(ipcRenderer), gate: isGateMode(process.argv) }),
);

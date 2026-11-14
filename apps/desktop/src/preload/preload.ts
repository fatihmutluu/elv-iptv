import { contextBridge, ipcRenderer } from 'electron';
import { createPlayerBridge } from './player-bridge.ts';

contextBridge.exposeInMainWorld('elv', Object.freeze({ player: createPlayerBridge(ipcRenderer) }));

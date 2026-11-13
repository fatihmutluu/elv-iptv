import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('elv', Object.freeze({}));

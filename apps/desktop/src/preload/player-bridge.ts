import {
  PLAYER_CHANNELS,
  type PlayerBridge,
  type PlayerEventMessage,
  type PlayerOpenReply,
  type PlayerUiMessage,
} from '../shared/player-ipc.ts';

/** The part of Electron's `ipcRenderer` the bridge uses; it never leaves the preload. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

const isOpenReply = (x: unknown): x is PlayerOpenReply =>
  typeof x === 'object' &&
  x !== null &&
  typeof (x as PlayerOpenReply).engineId === 'string' &&
  typeof (x as PlayerOpenReply).mainNowMs === 'number';

function subscribe<T>(
  ipc: IpcRendererLike,
  channel: string,
  listener: (message: T) => void,
): () => void {
  const wrapped = (_event: unknown, message: unknown): void => listener(message as T);
  ipc.on(channel, wrapped);
  return () => {
    ipc.removeListener(channel, wrapped);
  };
}

/**
 * Builds `window.elv.player` over `ipcRenderer`: one function per channel and nothing else, so the renderer gets no
 * raw IPC, no event object and no way to name a channel of its own.
 */
export function createPlayerBridge(ipc: IpcRendererLike): PlayerBridge {
  const bridge: PlayerBridge = {
    async open() {
      const reply = await ipc.invoke(PLAYER_CHANNELS.open);
      if (!isOpenReply(reply)) throw new Error('player:open returned an unexpected reply');
      return { engineId: reply.engineId, mainNowMs: reply.mainNowMs };
    },
    async close(engineId) {
      await ipc.invoke(PLAYER_CHANNELS.close, engineId);
    },
    send(message) {
      ipc.send(PLAYER_CHANNELS.command, message);
    },
    setArea(message) {
      ipc.send(PLAYER_CHANNELS.area, message);
    },
    onEvent: (listener) => subscribe<PlayerEventMessage>(ipc, PLAYER_CHANNELS.event, listener),
    onUi: (listener) => subscribe<PlayerUiMessage>(ipc, PLAYER_CHANNELS.ui, listener),
    reportGate(line) {
      ipc.send(PLAYER_CHANNELS.gateReport, line);
    },
  };
  return Object.freeze(bridge);
}

import {
  isPickedSubtitleTrack,
  PLAYER_CHANNELS,
  type PlayerBridge,
  type PlayerEventMessage,
  type PlayerOpenOptions,
  type PlayerOpenReply,
  type PlayerRemoteMediaActionMessage,
  type PlayerUiMessage,
  type VideoFrameLike,
} from '../shared/player-ipc.ts';

/** The part of Electron's `ipcRenderer` the bridge uses; it never leaves the preload. */
export interface IpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** Minimal subset of Electron's `sharedTexture` API used in the sandboxed preload (`#95`). */
export interface SharedTextureReceiverLike {
  setSharedTextureReceiver(
    cb: (
      data: {
        importedSharedTexture: {
          getVideoFrame(): VideoFrameLike;
          release(): void;
        };
      },
      engineId?: unknown,
    ) => Promise<void> | void,
  ): void;
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
export function createPlayerBridge(
  ipc: IpcRendererLike,
  sharedTex?: SharedTextureReceiverLike,
): PlayerBridge {
  const frameListeners = new Map<string, (frame: VideoFrameLike) => void>();

  if (sharedTex) {
    sharedTex.setSharedTextureReceiver(async ({ importedSharedTexture }, targetEngineId) => {
      try {
        const listener =
          typeof targetEngineId === 'string' ? frameListeners.get(targetEngineId) : undefined;
        if (!listener) return;
        const frame = importedSharedTexture.getVideoFrame();
        try {
          listener(frame);
        } catch {
          try {
            frame.close();
          } catch {
            // ignore frame close failure after listener error
          }
        }
      } finally {
        importedSharedTexture.release();
      }
    });
  }

  const bridge: PlayerBridge = {
    async open(options?: PlayerOpenOptions) {
      const reply =
        options === undefined
          ? await ipc.invoke(PLAYER_CHANNELS.open)
          : await ipc.invoke(PLAYER_CHANNELS.open, options);
      if (!isOpenReply(reply)) throw new Error('player:open returned an unexpected reply');
      return { engineId: reply.engineId, mainNowMs: reply.mainNowMs };
    },
    async close(engineId) {
      await ipc.invoke(PLAYER_CHANNELS.close, engineId);
    },
    async setPrimary(engineId) {
      await ipc.invoke(PLAYER_CHANNELS.setPrimary, engineId);
    },
    send(message) {
      ipc.send(PLAYER_CHANNELS.command, message);
    },
    setArea(message) {
      ipc.send(PLAYER_CHANNELS.area, message);
    },
    onEvent: (listener) => subscribe<PlayerEventMessage>(ipc, PLAYER_CHANNELS.event, listener),
    onUi: (listener) => subscribe<PlayerUiMessage>(ipc, PLAYER_CHANNELS.ui, listener),
    onRemoteMediaAction: (listener) =>
      subscribe<PlayerRemoteMediaActionMessage>(ipc, PLAYER_CHANNELS.remoteMediaAction, listener),
    onFrame(engineId, listener) {
      frameListeners.set(engineId, listener);
      return () => {
        if (frameListeners.get(engineId) === listener) {
          frameListeners.delete(engineId);
        }
      };
    },
    async pickSubtitleFile() {
      const reply = await ipc.invoke(PLAYER_CHANNELS.pickSubtitleFile);
      if (reply === null || reply === undefined) return null;
      if (!isPickedSubtitleTrack(reply)) {
        throw new Error('player:pick-subtitle-file returned an unexpected reply');
      }
      return reply;
    },
    reportGate(line) {
      ipc.send(PLAYER_CHANNELS.gateReport, line);
    },
  };
  return Object.freeze(bridge);
}

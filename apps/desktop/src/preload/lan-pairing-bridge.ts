import {
  isLanPairingPayloadEvent,
  isLanPairingSessionReply,
  isLanPairingStartOptions,
  LAN_PAIRING_CHANNELS,
  type LanPairingBridge,
  type LanPairingPayloadEvent,
  type LanPairingSessionReply,
  type LanPairingStartOptions,
} from '../shared/lan-pairing-ipc.ts';

/** Subset of Electron's `ipcRenderer` used by {@link createLanPairingBridge}. */
export interface LanPairingIpcRendererLike {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, ...args: unknown[]) => void): unknown;
}

/** Builds the frozen `window.elv.lanPairing` bridge inside the sandboxed Electron preload (`#50`). */
export function createLanPairingBridge(ipc: LanPairingIpcRendererLike): LanPairingBridge {
  const bridge: LanPairingBridge = {
    async startSession(opts?: LanPairingStartOptions): Promise<LanPairingSessionReply> {
      if (!isLanPairingStartOptions(opts)) {
        throw new Error('lan-pairing:start received invalid options');
      }
      const reply = await ipc.invoke(LAN_PAIRING_CHANNELS.start, opts);
      if (!isLanPairingSessionReply(reply)) {
        throw new Error('lan-pairing:start returned an unexpected reply');
      }
      return reply;
    },
    async stopSession(): Promise<void> {
      await ipc.invoke(LAN_PAIRING_CHANNELS.stop);
    },
    onPayloadReceived(listener: (payload: LanPairingPayloadEvent) => void): () => void {
      const wrapped = (_event: unknown, payload: unknown): void => {
        if (!isLanPairingPayloadEvent(payload)) return;
        try {
          listener(payload);
        } catch {
          // isolate renderer pairing payload subscribers
        }
      };
      ipc.on(LAN_PAIRING_CHANNELS.payload, wrapped);
      return () => {
        ipc.removeListener(LAN_PAIRING_CHANNELS.payload, wrapped);
      };
    },
  };
  return Object.freeze(bridge);
}

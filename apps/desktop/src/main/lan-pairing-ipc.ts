import {
  isLanPairingStartOptions,
  LAN_PAIRING_CHANNELS,
  type LanPairingSessionReply,
} from '../shared/lan-pairing-ipc.ts';
import { createLanPairingServer, type LanPairingServer } from './lan-pairing-server.ts';
import { assertTrustedSenderFrame, type TrustedSenderEventLike } from './trusted-sender.ts';

type IpcHandler = (
  event: TrustedSenderEventLike & { sender: unknown },
  ...args: unknown[]
) => unknown;

/** Subset of Electron's `ipcMain` needed by {@link registerLanPairingIpc}. */
interface LanPairingIpcMainLike {
  handle(channel: string, listener: IpcHandler): void;
  removeHandler(channel: string): void;
}

interface PairingSenderLike {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once?(event: 'destroyed', listener: () => void): unknown;
  on?(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown;
  on?(event: 'render-process-gone', listener: () => void): unknown;
  removeListener?(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** Collaborators injected into {@link registerLanPairingIpc}. */
export interface LanPairingIpcDeps {
  readonly ipcMain: LanPairingIpcMainLike;
  readonly server?: LanPairingServer;
  readonly devOrigin?: string | null;
  readonly log?: (line: string) => void;
}

/** Handle returned by {@link registerLanPairingIpc} for lifecycle teardown (`before-quit`). */
export interface LanPairingIpcHandle {
  stop(): Promise<void>;
  dispose(): Promise<void>;
}

function isPairingSender(value: unknown): value is PairingSenderLike {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<PairingSenderLike>;
  return typeof candidate.send === 'function' && typeof candidate.isDestroyed === 'function';
}

/**
 * Registers `lan-pairing:start` and `lan-pairing:stop` IPC handlers in Electron main (`#50`),
 * delivering validated payloads strictly to the originating renderer and tearing down the listener
 * if that renderer navigates away, crashes, or closes.
 */
export function registerLanPairingIpc(deps: LanPairingIpcDeps): LanPairingIpcHandle {
  const { ipcMain } = deps;
  const server = deps.server ?? createLanPairingServer();

  let activeSender: PairingSenderLike | undefined;
  let detachSenderListeners: (() => void) | undefined;

  const clearActiveSender = (): void => {
    detachSenderListeners?.();
    detachSenderListeners = undefined;
    activeSender = undefined;
  };

  const attachSender = (sender: unknown): void => {
    clearActiveSender();
    if (!isPairingSender(sender) || sender.isDestroyed()) return;
    activeSender = sender;

    const stopForSender = (): void => {
      if (activeSender === sender) clearActiveSender();
      void server.stop();
    };
    const onNavigation = (details: { isMainFrame: boolean; isSameDocument: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) stopForSender();
    };
    const onGone = (): void => stopForSender();
    const onDestroyed = (): void => stopForSender();

    sender.on?.('did-start-navigation', onNavigation);
    sender.on?.('render-process-gone', onGone);
    sender.once?.('destroyed', onDestroyed);

    detachSenderListeners = () => {
      sender.removeListener?.('did-start-navigation', onNavigation as (...args: unknown[]) => void);
      sender.removeListener?.('render-process-gone', onGone);
      sender.removeListener?.('destroyed', onDestroyed);
    };
  };

  const offPayload = server.onPayload((payload) => {
    const target = activeSender;
    clearActiveSender();
    if (!target || target.isDestroyed()) return;
    target.send(LAN_PAIRING_CHANNELS.payload, payload);
  });

  ipcMain.handle(
    LAN_PAIRING_CHANNELS.start,
    async (event, rawOpts): Promise<LanPairingSessionReply> => {
      assertTrustedSenderFrame(event, LAN_PAIRING_CHANNELS.start, deps.devOrigin, deps.log);
      if (!isLanPairingStartOptions(rawOpts)) {
        throw new Error('lan-pairing:start received invalid options');
      }
      attachSender(event.sender);
      try {
        return await server.start(rawOpts);
      } catch (error) {
        clearActiveSender();
        throw error;
      }
    },
  );

  ipcMain.handle(LAN_PAIRING_CHANNELS.stop, async (event): Promise<void> => {
    assertTrustedSenderFrame(event, LAN_PAIRING_CHANNELS.stop, deps.devOrigin, deps.log);
    clearActiveSender();
    await server.stop();
  });

  const stop = async (): Promise<void> => {
    clearActiveSender();
    await server.stop();
  };

  return {
    stop,
    async dispose(): Promise<void> {
      offPayload();
      ipcMain.removeHandler(LAN_PAIRING_CHANNELS.start);
      ipcMain.removeHandler(LAN_PAIRING_CHANNELS.stop);
      await stop();
    },
  };
}

import {
  isGateReport,
  isPlayerAreaMessage,
  isPlayerCommandMessage,
  PLAYER_CHANNELS,
  type PlayerEventMessage,
  type PlayerOpenReply,
  type PlayerUiEvent,
  type PlayerUiMessage,
} from '../../shared/player-ipc.ts';
import type { MpvEngine } from './engine.ts';

/** The part of Electron's `WebContents` the player IPC uses. */
export interface WebContentsLike {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: 'destroyed', listener: () => void): unknown;
}

type IpcListener = (event: { sender: WebContentsLike }, ...args: unknown[]) => unknown;

/** The part of Electron's `ipcMain` the player IPC uses. */
export interface IpcMainLike {
  handle(channel: string, listener: IpcListener): void;
  on(channel: string, listener: IpcListener): unknown;
  removeHandler(channel: string): void;
  removeListener(channel: string, listener: IpcListener): unknown;
}

/** What `registerPlayerIpc` needs from the app. */
export interface PlayerIpcDeps {
  ipcMain: IpcMainLike;
  /** Builds the engine for a renderer; `onUi` carries its presentation events to that renderer. */
  createEngine(owner: WebContentsLike, onUi: (event: PlayerUiEvent) => void): Promise<MpvEngine>;
  /** The main clock the engine stamps its events with; sent as `mainNowMs` for the renderer's clock offset. */
  now(): number;
  /** Receives drop notices; never a payload (payloads carry stream URLs). */
  log(line: string): void;
  /** Dev gate only: receives each valid `gate:report` line. The channel is not registered without it. */
  gateReport?(line: string): void;
}

interface Entry {
  owner: WebContentsLike;
  engine: MpvEngine;
  unsubscribe(): void;
}

/**
 * Serves the renderer's player proxy: `player:open` creates an engine owned by the calling webContents, commands and
 * area updates reach only that owner's engines, events flow back to the owner only. Every payload is validated; an
 * invalid one is dropped with a log line that names the channel but never the payload. Returns the disposer.
 */
export function registerPlayerIpc(deps: PlayerIpcDeps): () => void {
  const { ipcMain, log } = deps;
  const entries = new Map<string, Entry>();
  const watched = new Set<number>();
  let counter = 0;

  const release = (id: string): void => {
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    entry.unsubscribe();
    entry.engine.release();
  };

  const releaseOwnedBy = (owner: WebContentsLike): void => {
    for (const [id, entry] of [...entries]) if (entry.owner.id === owner.id) release(id);
  };

  const ownedEntry = (sender: WebContentsLike, engineId: string): Entry | undefined => {
    const entry = entries.get(engineId);
    return entry && entry.owner.id === sender.id ? entry : undefined;
  };

  const sendTo = (owner: WebContentsLike, channel: string, message: unknown): void => {
    if (!owner.isDestroyed()) owner.send(channel, message);
  };

  const watch = (owner: WebContentsLike): void => {
    if (watched.has(owner.id)) return;
    watched.add(owner.id);
    owner.once('destroyed', () => {
      watched.delete(owner.id);
      releaseOwnedBy(owner);
    });
  };

  const onOpen: IpcListener = async ({ sender }): Promise<PlayerOpenReply> => {
    watch(sender);
    counter += 1;
    const engineId = `engine-${counter}`;
    const engine = await deps.createEngine(sender, (ui) => {
      const message: PlayerUiMessage = { engineId, ui };
      sendTo(sender, PLAYER_CHANNELS.ui, message);
    });
    if (sender.isDestroyed()) {
      engine.release();
      throw new Error('the window closed while the player was starting');
    }
    const unsubscribe = engine.subscribe((event) => {
      const message: PlayerEventMessage = { engineId, event };
      sendTo(sender, PLAYER_CHANNELS.event, message);
    });
    entries.set(engineId, { owner: sender, engine, unsubscribe });
    return { engineId, mainNowMs: deps.now() };
  };

  const onClose: IpcListener = ({ sender }, engineId) => {
    if (typeof engineId === 'string' && ownedEntry(sender, engineId)) release(engineId);
  };

  const onCommand: IpcListener = ({ sender }, message) => {
    if (!isPlayerCommandMessage(message)) {
      log(`player ipc: dropped an invalid ${PLAYER_CHANNELS.command} message`);
      return;
    }
    const { engineId, command } = message;
    const entry = ownedEntry(sender, engineId);
    if (!entry) {
      log(
        `player ipc: dropped a ${PLAYER_CHANNELS.command} message for an engine the sender does not own`,
      );
      return;
    }
    const { engine } = entry;
    switch (command.name) {
      case 'load':
        engine.load(command.cmd);
        break;
      case 'retry':
      case 'play':
      case 'pause':
      case 'stop':
      case 'recreate':
        engine[command.name](command.attempt);
        break;
      case 'seek':
        engine.seek(command.attempt, command.positionMs);
        break;
      case 'fullscreen':
        engine.toggleFullscreen();
        break;
      case 'release':
        release(engineId);
        break;
    }
  };

  const onArea: IpcListener = ({ sender }, message) => {
    if (!isPlayerAreaMessage(message)) {
      log(`player ipc: dropped an invalid ${PLAYER_CHANNELS.area} message`);
      return;
    }
    const entry = ownedEntry(sender, message.engineId);
    if (!entry) {
      log(
        `player ipc: dropped a ${PLAYER_CHANNELS.area} message for an engine the sender does not own`,
      );
      return;
    }
    entry.engine.setArea(message.area);
  };

  const onGate: IpcListener = (_event, line) => {
    if (isGateReport(line)) deps.gateReport?.(line);
    else log(`player ipc: dropped an invalid ${PLAYER_CHANNELS.gateReport} message`);
  };

  ipcMain.handle(PLAYER_CHANNELS.open, onOpen);
  ipcMain.handle(PLAYER_CHANNELS.close, onClose);
  ipcMain.on(PLAYER_CHANNELS.command, onCommand);
  ipcMain.on(PLAYER_CHANNELS.area, onArea);
  if (deps.gateReport) ipcMain.on(PLAYER_CHANNELS.gateReport, onGate);

  return () => {
    ipcMain.removeHandler(PLAYER_CHANNELS.open);
    ipcMain.removeHandler(PLAYER_CHANNELS.close);
    ipcMain.removeListener(PLAYER_CHANNELS.command, onCommand);
    ipcMain.removeListener(PLAYER_CHANNELS.area, onArea);
    ipcMain.removeListener(PLAYER_CHANNELS.gateReport, onGate);
    for (const id of [...entries.keys()]) release(id);
  };
}

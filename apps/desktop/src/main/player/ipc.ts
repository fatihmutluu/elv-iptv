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
import type { PowerBlocker } from './power-blocker.ts';

/** The part of Electron's `WebContents` the player IPC uses. */
export interface WebContentsLike {
  readonly id: number;
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
  once(event: 'destroyed', listener: () => void): unknown;
  on(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown;
  on(event: 'render-process-gone', listener: () => void): unknown;
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
  /** The main monotonic clock the engine stamps its events with; sent as `mainNowMs` for the renderer's offset. */
  now(): number;
  /** Receives drop notices; never a payload (payloads carry stream URLs). */
  log(line: string): void;
  /** Optional display-sleep guard acquired only while an engine is actively `'playing'`. */
  powerBlocker?: PowerBlocker;
  /**
   * Dev gate only: receives each valid `gate:report` line and the sender's engine (`undefined` when it has none). The
   * channel is not registered without it.
   */
  gateReport?(line: string, engine: MpvEngine | undefined): void;
}

interface Entry {
  owner: WebContentsLike;
  engine: MpvEngine;
  unsubscribe(): void;
}

/**
 * Serves the renderer's player proxy: `player:open` creates the engine owned by the calling webContents (a second open
 * releases the first), commands and area updates reach only that owner's engine, events flow back to the owner only.
 * A main-frame navigation, a renderer crash or the webContents going away releases its engine. Every payload is validated; an
 * invalid one is dropped with a log line that names the channel but never the payload. Returns the disposer.
 */
export function registerPlayerIpc(deps: PlayerIpcDeps): () => void {
  const { ipcMain, log, powerBlocker } = deps;
  const entries = new Map<string, Entry>();
  const watched = new Set<number>();
  const generations = new Map<number, number>();
  let counter = 0;
  let disposed = false;

  const bumpGeneration = (ownerId: number): number => {
    const next = (generations.get(ownerId) ?? 0) + 1;
    generations.set(ownerId, next);
    return next;
  };

  const release = (id: string): void => {
    powerBlocker?.release(id);
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    entry.unsubscribe();
    entry.engine.release();
  };

  const releaseOwnedBy = (owner: WebContentsLike): void => {
    for (const [id, entry] of [...entries]) if (entry.owner.id === owner.id) release(id);
  };

  const invalidateOwner = (owner: WebContentsLike): void => {
    bumpGeneration(owner.id);
    releaseOwnedBy(owner);
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
      invalidateOwner(owner);
      generations.delete(owner.id);
    });
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) invalidateOwner(owner);
    });
    owner.on('render-process-gone', () => invalidateOwner(owner));
  };

  const onOpen: IpcListener = async ({ sender }): Promise<PlayerOpenReply> => {
    if (disposed || sender.isDestroyed()) {
      throw new Error('the window closed while the player was starting');
    }
    const arrivedAtMs = deps.now();
    watch(sender);
    const gen = bumpGeneration(sender.id);
    releaseOwnedBy(sender);
    counter += 1;
    const engineId = `engine-${counter}`;
    let registered = false;
    const isCurrent = (): boolean =>
      !disposed &&
      !sender.isDestroyed() &&
      generations.get(sender.id) === gen &&
      (!registered || entries.has(engineId));
    const engine = await deps.createEngine(sender, (ui) => {
      if (!isCurrent()) return;
      const message: PlayerUiMessage = { engineId, ui };
      sendTo(sender, PLAYER_CHANNELS.ui, message);
    });
    if (!isCurrent()) {
      engine.release();
      throw new Error('the player open was superseded or the window closed while starting');
    }
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === 'state') {
        if (event.state === 'playing') powerBlocker?.acquire(engineId);
        else if (event.state === 'paused' || event.state === 'ended' || event.state === 'opening') {
          powerBlocker?.release(engineId);
        }
      } else if (event.type === 'error') {
        powerBlocker?.release(engineId);
      }
      const message: PlayerEventMessage = { engineId, event };
      sendTo(sender, PLAYER_CHANNELS.event, message);
    });
    entries.set(engineId, { owner: sender, engine, unsubscribe });
    registered = true;
    engine.start();
    return { engineId, mainNowMs: (arrivedAtMs + deps.now()) / 2 };
  };

  const guarded = (channel: string, body: () => void): void => {
    try {
      body();
    } catch {
      log(`player ipc: a ${channel} message failed`);
    }
  };

  const onClose: IpcListener = ({ sender }, engineId) => {
    if (typeof engineId === 'string' && ownedEntry(sender, engineId)) release(engineId);
  };

  const onCommand: IpcListener = ({ sender }, message) =>
    guarded(PLAYER_CHANNELS.command, () => dispatchCommand(sender, message));

  const dispatchCommand = (sender: WebContentsLike, message: unknown): void => {
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
        powerBlocker?.release(engineId);
        engine.load(command.cmd);
        break;
      case 'pause':
      case 'stop':
      case 'recreate':
        powerBlocker?.release(engineId);
        engine[command.name](command.attempt);
        break;
      case 'retry':
      case 'play':
        engine[command.name](command.attempt);
        break;
      case 'seek':
        engine.seek(command.attempt, command.positionMs);
        break;
      case 'selectAudioTrack':
        engine.selectAudioTrack?.(command.attempt, command.id);
        break;
      case 'selectSubtitleTrack':
        engine.selectSubtitleTrack?.(command.attempt, command.id);
        break;
      case 'fullscreen':
        engine.toggleFullscreen();
        break;
      case 'release':
        release(engineId);
        break;
    }
  };

  const onArea: IpcListener = ({ sender }, message) =>
    guarded(PLAYER_CHANNELS.area, () => dispatchArea(sender, message));

  const dispatchArea = (sender: WebContentsLike, message: unknown): void => {
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

  const onGate: IpcListener = ({ sender }, line) => {
    if (isGateReport(line)) {
      const owned = [...entries.values()].find((entry) => entry.owner.id === sender.id);
      deps.gateReport?.(line, owned?.engine);
    } else log(`player ipc: dropped an invalid ${PLAYER_CHANNELS.gateReport} message`);
  };

  ipcMain.handle(PLAYER_CHANNELS.open, onOpen);
  ipcMain.handle(PLAYER_CHANNELS.close, onClose);
  ipcMain.on(PLAYER_CHANNELS.command, onCommand);
  ipcMain.on(PLAYER_CHANNELS.area, onArea);
  if (deps.gateReport) ipcMain.on(PLAYER_CHANNELS.gateReport, onGate);

  return () => {
    disposed = true;
    ipcMain.removeHandler(PLAYER_CHANNELS.open);
    ipcMain.removeHandler(PLAYER_CHANNELS.close);
    ipcMain.removeListener(PLAYER_CHANNELS.command, onCommand);
    ipcMain.removeListener(PLAYER_CHANNELS.area, onArea);
    ipcMain.removeListener(PLAYER_CHANNELS.gateReport, onGate);
    for (const id of [...entries.keys()]) release(id);
    powerBlocker?.releaseAll();
  };
}

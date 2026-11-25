import type { AttemptToken, DisplaySyncPolicy, ExternalSubtitleTrack } from '@elv/playback';
import {
  isEngineId,
  isGateReport,
  isPlayerAreaMessage,
  isPlayerCommandMessage,
  isPlayerOpenOptions,
  MAX_ENGINES_PER_WINDOW,
  PLAYER_CHANNELS,
  type PlayerEventMessage,
  type PlayerOpenOptions,
  type PlayerOpenReply,
  type PlayerUiEvent,
  type PlayerUiMessage,
} from '../../shared/player-ipc.ts';
import type { DesktopMediaBridge, DesktopMediaCommand } from '../media-bridge.ts';
import type { TaskbarAction, TaskbarController } from '../taskbar-controls.ts';
import type { DesktopDisplayRefreshController } from './display-refresh.ts';
import type { MpvEngine } from './engine.ts';
import { dispatchPlayerBridgeCommand } from './ipc-commands.ts';
import {
  DEFAULT_PARKED_ORPHAN_MS,
  type EntrySnapshots,
  type HandoffEntry,
  handleAdoptEngine,
  handleParkEngine,
  recordEntryEventSnapshot,
  recordEntryUiSnapshot,
  syncPrimaryOwnerEffects,
} from './ipc-handoff.ts';
import {
  dispatchDesktopMediaCommand,
  type MediaBridgeState,
  stoppedMediaState,
  type TaskbarState,
} from './ipc-media.ts';
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

/** Optional timer primitives used by `registerPlayerIpc` for buffering stall grace release. */
interface PlayerIpcTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** What `registerPlayerIpc` needs from the app. */
export interface PlayerIpcDeps {
  ipcMain: IpcMainLike;
  /** Builds the engine for a renderer; `onUi` carries its presentation events and `engineId` routes canvas frames. */
  createEngine(
    owner: WebContentsLike,
    onUi: (event: PlayerUiEvent) => void,
    engineId: string,
    getMultiViewTileCount?: () => number,
  ): Promise<MpvEngine>;
  /** The main monotonic clock the engine stamps its events with; sent as `mainNowMs` for the renderer's offset. */
  now(): number;
  /** Receives drop notices; never a payload (payloads carry stream URLs). */
  log(line: string): void;
  /** Optional display-sleep guard acquired only while an engine is actively `'playing'`. */
  powerBlocker?: PowerBlocker;
  /** Grace period (ms) before releasing `powerBlocker` during a continuous `'buffering'` stall (default `30_000`). */
  bufferingReleaseMs?: number;
  /** Optional timer primitives for testing the buffering stall grace timeout. */
  timers?: PlayerIpcTimers;
  /** Optional Windows taskbar progress & thumbar controller factory (`#410`). */
  createTaskbarController?(
    owner: WebContentsLike,
    onAction: (action: TaskbarAction) => void,
  ): TaskbarController | undefined;
  /** Optional active video display aspect ratio sink for windowed aspect-ratio lock (`#332`). */
  onVideoAspectRatioChange?(owner: WebContentsLike, aspectRatio: number | undefined): void;
  /** Optional retarget callback moving a live canvas engine to a new owning window (`Wave P3`). */
  retargetOwner?(engine: MpvEngine, nextOwner: WebContentsLike): boolean;
  /** Orphan timeout (ms) before an unadopted parked engine is released (default `15_000`). */
  parkedOrphanMs?: number;
  /** Optional OS media bridge (Linux MPRIS2 `#238` or macOS MediaPlayer `#301`). */
  mediaBridge?: DesktopMediaBridge;
  /** Optional fullscreen Auto Frame-Rate display refresh controller (`#214`, `#116`). */
  displayRefreshController?: DesktopDisplayRefreshController;
  /** Resolves the active display identifier for an owning renderer `WebContents` (`#214`). */
  getDisplayId?(owner: WebContentsLike): string | undefined;
  /** Optional sandboxed subtitle file picker (`#32`). */
  pickSubtitleFile?(owner: WebContentsLike): Promise<ExternalSubtitleTrack | null>;
  /**
   * Dev gate only: receives each valid `gate:report` line and the sender's engine (`undefined` when it has none). The
   * channel is not registered without it.
   */
  gateReport?(line: string, engine: MpvEngine | undefined): void;
}

const DEFAULT_BUFFERING_RELEASE_MS = 30_000;

interface Entry {
  owner: WebContentsLike;
  engine: MpvEngine;
  attempt: AttemptToken;
  isPrimary: boolean;
  parked: boolean;
  lastAspectRatio: number | undefined;
  lastFps: number | undefined;
  lastFullscreen: boolean;
  lastDisplaySync: DisplaySyncPolicy | undefined;
  snapshots: EntrySnapshots;
  emitUi: (ui: PlayerUiEvent) => void;
  unsubscribe(): void;
  taskbar?: TaskbarController | undefined;
  taskbarState: TaskbarState;
  mediaState: MediaBridgeState;
}

/**
 * Serves the renderer's player proxy: `player:open` creates an engine owned by the calling `webContents`
 * (replacing existing engines by default, or opening up to 4 concurrent Canvas Multi-View tiles when
 * `{ replaceExisting: false }`), `player:set-primary` promotes the active audio/media/taskbar tile,
 * and a main-frame navigation, renderer crash, or window close releases all owned engines.
 */
export function registerPlayerIpc(deps: PlayerIpcDeps): () => void {
  const { ipcMain, log, powerBlocker, mediaBridge, displayRefreshController } = deps;
  const resolveDisplayId = (owner: WebContentsLike): string | undefined =>
    deps.getDisplayId?.(owner);
  const bufferingReleaseMs = Math.max(0, deps.bufferingReleaseMs ?? DEFAULT_BUFFERING_RELEASE_MS);
  const parkedOrphanMs = Math.max(0, deps.parkedOrphanMs ?? DEFAULT_PARKED_ORPHAN_MS);
  const timers: PlayerIpcTimers = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const entries = new Map<string, Entry>();
  const bufferingTimers = new Map<string, unknown>();
  const parkedTimers = new Map<string, unknown>();
  const watched = new Set<number>();
  const ownerGenerations = new Map<number, number>();
  const pendingOpens = new Map<number, Set<string>>();
  let activeMediaEngineId: string | undefined;
  let counter = 0;
  let disposed = false;

  const pushStoppedMediaState = (): void => {
    mediaBridge?.updateState(stoppedMediaState());
  };

  const pushMediaState = (id: string, promote = false): void => {
    if (!mediaBridge) return;
    const entry = entries.get(id);
    if (!entry) return;
    if (
      entry.isPrimary &&
      (promote || activeMediaEngineId === undefined || !entries.has(activeMediaEngineId))
    ) {
      activeMediaEngineId = id;
    }
    if (activeMediaEngineId !== id) return;
    mediaBridge.updateState({ ...entry.mediaState });
  };

  const resolveActiveMediaEntry = (): { id: string; entry: Entry } | undefined => {
    if (activeMediaEngineId !== undefined) {
      const active = entries.get(activeMediaEngineId);
      if (active) return { id: activeMediaEngineId, entry: active };
    }
    let lastPrimary: { id: string; entry: Entry } | undefined;
    for (const [id, entry] of entries) {
      if (entry.isPrimary) lastPrimary = { id, entry };
    }
    if (lastPrimary) activeMediaEngineId = lastPrimary.id;
    return lastPrimary;
  };

  const clearBufferingTimer = (id: string): void => {
    const handle = bufferingTimers.get(id);
    if (handle === undefined) return;
    bufferingTimers.delete(id);
    timers.clearTimeout(handle);
  };

  const armBufferingTimer = (id: string): void => {
    if (!powerBlocker || bufferingTimers.has(id)) return;
    const handle = timers.setTimeout(() => {
      bufferingTimers.delete(id);
      powerBlocker.release(id);
    }, bufferingReleaseMs);
    bufferingTimers.set(id, handle);
  };

  const releasePowerBlocker = (id: string): void => {
    clearBufferingTimer(id);
    powerBlocker?.release(id);
  };

  const bumpOwnerGeneration = (ownerId: number): number => {
    const next = (ownerGenerations.get(ownerId) ?? 0) + 1;
    ownerGenerations.set(ownerId, next);
    pendingOpens.delete(ownerId);
    return next;
  };

  const clearParkedTimer = (id: string): void => {
    const handle = parkedTimers.get(id);
    if (handle === undefined) return;
    parkedTimers.delete(id);
    timers.clearTimeout(handle);
  };

  const armParkedTimer = (id: string): void => {
    clearParkedTimer(id);
    const handle = timers.setTimeout(() => {
      parkedTimers.delete(id);
      const current = entries.get(id);
      if (current?.parked) {
        log('player ipc: releasing orphaned parked engine after timeout');
        release(id);
      }
    }, parkedOrphanMs);
    parkedTimers.set(id, handle);
  };

  const countOwnedBy = (ownerId: number): number => {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.owner.id === ownerId && !entry.parked) count += 1;
    }
    return count;
  };

  const syncTaskbar = (taskbar: TaskbarController | undefined, s: TaskbarState): void => {
    taskbar?.updatePlayback({
      active: s.active,
      isVod: s.isVod,
      paused: s.paused,
      positionMs: s.positionMs,
      durationMs: s.durationMs,
      canStep: !s.isVod,
    });
  };

  const demoteOwnerPrimaries = (ownerId: number, exceptId?: string): void => {
    for (const [id, other] of entries) {
      if (other.owner.id !== ownerId || id === exceptId || !other.isPrimary) continue;
      other.isPrimary = false;
      other.taskbar?.clear();
      other.taskbar = undefined;
      displayRefreshController?.setPlaybackActive(id, false, resolveDisplayId(other.owner));
    }
  };

  const release = (id: string): void => {
    clearParkedTimer(id);
    releasePowerBlocker(id);
    displayRefreshController?.restoreForEngine(id);
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    if (entry.isPrimary && !entry.parked) {
      deps.onVideoAspectRatioChange?.(entry.owner, undefined);
    }
    entry.taskbar?.clear();
    entry.taskbar = undefined;
    entry.unsubscribe();
    entry.engine.release();
    if (activeMediaEngineId === id) {
      activeMediaEngineId = undefined;
      const next = resolveActiveMediaEntry();
      if (next) pushMediaState(next.id, true);
      else pushStoppedMediaState();
    }
  };

  const releaseOwnedBy = (owner: WebContentsLike): void => {
    for (const [id, entry] of [...entries]) {
      if (entry.owner.id === owner.id && !entry.parked) release(id);
    }
  };

  const invalidateOwner = (owner: WebContentsLike): void => {
    bumpOwnerGeneration(owner.id);
    releaseOwnedBy(owner);
  };

  const ownedEntry = (sender: WebContentsLike, engineId: string): Entry | undefined => {
    const entry = entries.get(engineId);
    return entry && !entry.parked && entry.owner.id === sender.id ? entry : undefined;
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
      ownerGenerations.delete(owner.id);
    });
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) invalidateOwner(owner);
    });
    owner.on('render-process-gone', () => invalidateOwner(owner));
  };

  const onOpen: IpcListener = async ({ sender }, rawOptions): Promise<PlayerOpenReply> => {
    if (disposed || sender.isDestroyed()) {
      throw new Error('the window closed while the player was starting');
    }
    let options: PlayerOpenOptions | undefined;
    if (rawOptions !== undefined) {
      if (!isPlayerOpenOptions(rawOptions)) {
        log(`player ipc: dropped an invalid ${PLAYER_CHANNELS.open} payload`);
        throw new Error('invalid player:open options');
      }
      options = rawOptions;
    }
    const replaceExisting = options?.replaceExisting ?? true;
    const primary = options?.primary ?? true;

    const arrivedAtMs = deps.now();
    watch(sender);

    let gen: number;
    if (replaceExisting) {
      gen = bumpOwnerGeneration(sender.id);
      releaseOwnedBy(sender);
    } else {
      gen = ownerGenerations.get(sender.id) ?? 0;
      const inFlight = pendingOpens.get(sender.id)?.size ?? 0;
      if (countOwnedBy(sender.id) + inFlight >= MAX_ENGINES_PER_WINDOW) {
        throw new Error(
          `maximum concurrent player engines (${MAX_ENGINES_PER_WINDOW}) reached for this window`,
        );
      }
    }

    counter += 1;
    const engineId = `engine-${counter}`;
    let pendingSet = pendingOpens.get(sender.id);
    if (!pendingSet) {
      pendingSet = new Set<string>();
      pendingOpens.set(sender.id, pendingSet);
    }
    pendingSet.add(engineId);

    let registered = false;
    let initialFullscreen = false;
    const preSnapshots: EntrySnapshots = {};
    const isCurrent = (): boolean => {
      if (disposed) return false;
      if (!registered) {
        return !sender.isDestroyed() && (ownerGenerations.get(sender.id) ?? 0) === gen;
      }
      return entries.has(engineId);
    };
    const emitUi = (ui: PlayerUiEvent): void => {
      if (!isCurrent()) return;
      const currentEntry = entries.get(engineId);
      recordEntryUiSnapshot(currentEntry ? currentEntry.snapshots : preSnapshots, ui);
      const targetOwner = currentEntry ? currentEntry.owner : sender;
      if (ui.type === 'fullscreen-changed') {
        initialFullscreen = ui.fullscreen;
        if (currentEntry) {
          currentEntry.lastFullscreen = ui.fullscreen;
          if (currentEntry.isPrimary && !currentEntry.parked) {
            displayRefreshController?.setFullscreen(
              engineId,
              ui.fullscreen,
              resolveDisplayId(targetOwner),
            );
          }
        } else if (primary) {
          displayRefreshController?.setFullscreen(
            engineId,
            ui.fullscreen,
            resolveDisplayId(targetOwner),
          );
        }
      }
      if (currentEntry?.parked) return;
      const message: PlayerUiMessage = { engineId, ui };
      sendTo(targetOwner, PLAYER_CHANNELS.ui, message);
    };

    let engine: MpvEngine;
    const getMultiViewTileCount = (): number => {
      const ownerId = entries.get(engineId)?.owner.id ?? sender.id;
      return Math.max(1, countOwnedBy(ownerId) + (pendingOpens.get(ownerId)?.size ?? 0));
    };
    try {
      engine = await deps.createEngine(sender, emitUi, engineId, getMultiViewTileCount);
    } finally {
      if (pendingOpens.get(sender.id) === pendingSet) {
        pendingSet.delete(engineId);
        if (pendingSet.size === 0) pendingOpens.delete(sender.id);
      }
    }

    if (!isCurrent()) {
      engine.release();
      throw new Error('the player open was superseded or the window closed while starting');
    }

    if (primary) {
      demoteOwnerPrimaries(sender.id, engineId);
    }

    const taskbar = primary
      ? deps.createTaskbarController?.(sender, (action) => emitUi({ type: 'key', key: action }))
      : undefined;
    const taskbarState: TaskbarState = {
      active: false,
      isVod: false,
      paused: false,
      positionMs: 0,
      durationMs: 0,
    };
    const mediaState: MediaBridgeState = {
      status: 'Stopped',
      isNavigating: false,
      kind: 'live',
      positionUs: 0,
      durationUs: 0,
      rate: 1,
      volume: 1,
      metadata: null,
    };

    const entry: Entry = {
      owner: sender,
      engine,
      attempt: 0,
      isPrimary: primary,
      parked: false,
      lastAspectRatio: undefined,
      lastFps: undefined,
      lastFullscreen: initialFullscreen,
      lastDisplaySync: undefined,
      snapshots: preSnapshots,
      emitUi,
      unsubscribe: () => undefined,
      ...(taskbar === undefined ? {} : { taskbar }),
      taskbarState,
      mediaState,
    };

    entry.unsubscribe = engine.subscribe((event) => {
      recordEntryEventSnapshot(entry.snapshots, event);
      const activePrimary = entry.isPrimary && !entry.parked;
      if (event.type === 'state') {
        if (event.state === 'playing') {
          clearBufferingTimer(engineId);
          powerBlocker?.acquire(engineId);
          taskbarState.active = true;
          taskbarState.paused = false;
          if (activePrimary) {
            syncTaskbar(entry.taskbar, taskbarState);
            displayRefreshController?.setPlaybackActive(
              engineId,
              true,
              resolveDisplayId(entry.owner),
            );
          }
          mediaState.status = 'Playing';
          mediaState.isNavigating = false;
          pushMediaState(engineId, entry.isPrimary);
        } else if (event.state === 'buffering') {
          armBufferingTimer(engineId);
        } else if (
          event.state === 'paused' ||
          event.state === 'ended' ||
          event.state === 'opening'
        ) {
          releasePowerBlocker(engineId);
          if (event.state === 'paused') {
            taskbarState.active = true;
            taskbarState.paused = true;
            if (activePrimary) syncTaskbar(entry.taskbar, taskbarState);
            mediaState.status = 'Paused';
            mediaState.isNavigating = false;
            pushMediaState(engineId, entry.isPrimary);
          } else if (event.state === 'ended') {
            taskbarState.active = false;
            taskbarState.paused = false;
            entry.lastAspectRatio = undefined;
            entry.lastFps = undefined;
            if (activePrimary) {
              entry.taskbar?.clear();
              deps.onVideoAspectRatioChange?.(entry.owner, undefined);
              displayRefreshController?.setPlaybackActive(
                engineId,
                false,
                resolveDisplayId(entry.owner),
              );
            }
            mediaState.status = 'Stopped';
            mediaState.isNavigating = false;
            mediaState.positionUs = 0;
            mediaState.durationUs = 0;
            pushMediaState(engineId);
          } else if (event.state === 'opening') {
            mediaState.isNavigating = true;
            pushMediaState(engineId);
          }
        } else {
          clearBufferingTimer(engineId);
        }
      } else if (event.type === 'clock') {
        taskbarState.positionMs = event.anchor.positionMs;
        if (event.anchor.durationMs !== undefined) {
          taskbarState.durationMs = event.anchor.durationMs;
        }
        if (activePrimary && taskbarState.active) syncTaskbar(entry.taskbar, taskbarState);
        mediaState.positionUs = Math.max(0, Math.round(event.anchor.positionMs * 1000));
        if (event.anchor.durationMs !== undefined) {
          mediaState.durationUs = Math.max(0, Math.round(event.anchor.durationMs * 1000));
        }
        if (Number.isFinite(event.anchor.rate) && event.anchor.rate > 0) {
          mediaState.rate = event.anchor.rate;
        }
        pushMediaState(engineId);
      } else if (event.type === 'mediaInfo') {
        if (
          typeof event.info.aspectRatio === 'number' &&
          Number.isFinite(event.info.aspectRatio) &&
          event.info.aspectRatio > 0
        ) {
          entry.lastAspectRatio = event.info.aspectRatio;
          if (activePrimary) {
            deps.onVideoAspectRatioChange?.(entry.owner, event.info.aspectRatio);
          }
        }
        if (
          typeof event.info.fps === 'number' &&
          Number.isFinite(event.info.fps) &&
          event.info.fps > 0
        ) {
          entry.lastFps = event.info.fps;
          if (activePrimary) {
            displayRefreshController?.setContentFps(
              engineId,
              event.info.fps,
              resolveDisplayId(entry.owner),
            );
          }
        }
      } else if (event.type === 'error') {
        releasePowerBlocker(engineId);
        taskbarState.active = false;
        taskbarState.paused = false;
        entry.lastAspectRatio = undefined;
        entry.lastFps = undefined;
        if (activePrimary) {
          entry.taskbar?.clear();
          deps.onVideoAspectRatioChange?.(entry.owner, undefined);
          displayRefreshController?.setPlaybackActive(
            engineId,
            false,
            resolveDisplayId(entry.owner),
          );
        }
        mediaState.status = 'Stopped';
        mediaState.isNavigating = false;
        pushMediaState(engineId);
      }
      if (!entry.parked) {
        const message: PlayerEventMessage = { engineId, event };
        sendTo(entry.owner, PLAYER_CHANNELS.event, message);
      }
    });

    entries.set(engineId, entry);
    if (primary) activeMediaEngineId = engineId;
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

  const syncPrimary = (engineId: string, entry: HandoffEntry<WebContentsLike>): void =>
    syncPrimaryOwnerEffects(engineId, entry, {
      ...(deps.createTaskbarController
        ? { createTaskbarController: deps.createTaskbarController }
        : {}),
      syncTaskbar,
      ...(deps.onVideoAspectRatioChange
        ? { onVideoAspectRatioChange: deps.onVideoAspectRatioChange }
        : {}),
      ...(displayRefreshController ? { displayRefreshController } : {}),
      resolveDisplayId,
      promoteMedia: (id) => {
        activeMediaEngineId = id;
        pushMediaState(id, true);
      },
    });

  const onClose: IpcListener = ({ sender }, engineId) => {
    if (typeof engineId === 'string' && ownedEntry(sender, engineId)) release(engineId);
  };

  const onPark: IpcListener = ({ sender }, engineId): boolean =>
    handleParkEngine(sender, engineId, {
      disposed,
      hasRetargetOwner: deps.retargetOwner !== undefined,
      log,
      ownedEntry,
      ...(deps.onVideoAspectRatioChange
        ? { onVideoAspectRatioChange: deps.onVideoAspectRatioChange }
        : {}),
      ...(displayRefreshController ? { displayRefreshController } : {}),
      armParkedTimer,
    });

  const onAdopt: IpcListener = ({ sender }, engineId): PlayerOpenReply | null =>
    handleAdoptEngine(sender, engineId, {
      disposed,
      now: deps.now,
      log,
      getEntry: (id) => entries.get(id),
      clearParkedTimer,
      armParkedTimer,
      ...(deps.retargetOwner ? { retargetOwner: deps.retargetOwner } : {}),
      releaseOwnedBy,
      watch,
      syncPrimary,
      sendTo,
    });

  const onSetPrimary: IpcListener = ({ sender }, engineId) => {
    if (!isEngineId(engineId)) {
      log(`player ipc: dropped an invalid ${PLAYER_CHANNELS.setPrimary} message`);
      return;
    }
    const entry = ownedEntry(sender, engineId);
    if (!entry) {
      log(
        `player ipc: dropped a ${PLAYER_CHANNELS.setPrimary} message for an engine the sender does not own`,
      );
      return;
    }
    demoteOwnerPrimaries(sender.id, engineId);
    entry.isPrimary = true;
    syncPrimary(engineId, entry);
  };

  const onPickSubtitleFile: IpcListener = async ({ sender }) => {
    if (disposed || sender.isDestroyed() || !deps.pickSubtitleFile) return null;
    try {
      return await deps.pickSubtitleFile(sender);
    } catch {
      log(`player ipc: a ${PLAYER_CHANNELS.pickSubtitleFile} request failed`);
      return null;
    }
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
    dispatchPlayerBridgeCommand(engineId, entry, command, {
      ...(mediaBridge === undefined ? {} : { mediaBridge }),
      ...(displayRefreshController === undefined ? {} : { displayRefreshController }),
      resolveDisplayId,
      releasePowerBlocker,
      ...(deps.onVideoAspectRatioChange === undefined
        ? {}
        : { onVideoAspectRatioChange: deps.onVideoAspectRatioChange }),
      pushMediaState,
      isActiveMediaEngine: (id) => activeMediaEngineId === id,
      releaseEngine: release,
    });
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

  const handleMediaCommand = (cmd: DesktopMediaCommand): void => {
    if (disposed) return;
    const active = resolveActiveMediaEntry();
    if (!active) return;
    dispatchDesktopMediaCommand(cmd, active, {
      ...(mediaBridge === undefined ? {} : { mediaBridge }),
      releasePowerBlocker,
      ...(deps.onVideoAspectRatioChange === undefined
        ? {}
        : { onVideoAspectRatioChange: deps.onVideoAspectRatioChange }),
      pushMediaState,
      sendTo,
    });
  };

  const offMediaCommand = mediaBridge?.onCommand(handleMediaCommand);

  ipcMain.handle(PLAYER_CHANNELS.open, onOpen);
  ipcMain.handle(PLAYER_CHANNELS.close, onClose);
  ipcMain.handle(PLAYER_CHANNELS.park, onPark);
  ipcMain.handle(PLAYER_CHANNELS.adopt, onAdopt);
  ipcMain.handle(PLAYER_CHANNELS.setPrimary, onSetPrimary);
  ipcMain.handle(PLAYER_CHANNELS.pickSubtitleFile, onPickSubtitleFile);
  ipcMain.on(PLAYER_CHANNELS.command, onCommand);
  ipcMain.on(PLAYER_CHANNELS.area, onArea);
  if (deps.gateReport) ipcMain.on(PLAYER_CHANNELS.gateReport, onGate);

  return () => {
    disposed = true;
    offMediaCommand?.();
    ipcMain.removeHandler(PLAYER_CHANNELS.open);
    ipcMain.removeHandler(PLAYER_CHANNELS.close);
    ipcMain.removeHandler(PLAYER_CHANNELS.park);
    ipcMain.removeHandler(PLAYER_CHANNELS.adopt);
    ipcMain.removeHandler(PLAYER_CHANNELS.setPrimary);
    ipcMain.removeHandler(PLAYER_CHANNELS.pickSubtitleFile);
    ipcMain.removeListener(PLAYER_CHANNELS.command, onCommand);
    ipcMain.removeListener(PLAYER_CHANNELS.area, onArea);
    ipcMain.removeListener(PLAYER_CHANNELS.gateReport, onGate);
    for (const id of [...parkedTimers.keys()]) clearParkedTimer(id);
    for (const id of [...bufferingTimers.keys()]) clearBufferingTimer(id);
    for (const id of [...entries.keys()]) release(id);
    displayRefreshController?.restoreAll();
    powerBlocker?.releaseAll();
  };
}

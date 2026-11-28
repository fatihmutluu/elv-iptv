import type { AttemptToken, DisplaySyncPolicy, ExternalSubtitleTrack } from '@elv/playback';
import {
  isEngineId,
  isGateReport,
  isPlayerAreaMessage,
  isPlayerCommandMessage,
  isPlayerOpenOptions,
  isSetScrubbingRequest,
  MAX_ENGINES_PER_WINDOW,
  PLAYER_CHANNELS,
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
import { handlePlayerEngineEvent, replayClaimedStandby } from './ipc-events.ts';
import {
  DEFAULT_PARKED_ORPHAN_MS,
  type EntrySnapshots,
  type HandoffEntry,
  handleAdoptEngine,
  handleParkEngine,
  recordEntryUiSnapshot,
  syncPrimaryOwnerEffects,
} from './ipc-handoff.ts';
import {
  dispatchDesktopMediaCommand,
  type MediaBridgeState,
  stoppedMediaState,
  type TaskbarState,
} from './ipc-media.ts';
import {
  createPlayerPowerBlockerController,
  type PowerBlockerTimers,
} from './ipc-power-blocker.ts';
import { createPlayerWarmUpController, type StandbyClaim } from './ipc-warmup.ts';
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
  /** Grace period (ms) before releasing `powerBlocker` when a `'playing'` engine's clock freezes (default `60_000`). */
  frozenClockReleaseMs?: number;
  /** Optional query returning whether the owning window is currently minimized or hidden. */
  isWindowMinimized?(owner: WebContentsLike): boolean;
  /** Optional subscription notified when the owning window minimizes/hides (`true`) or restores/shows (`false`). */
  onWindowVisibilityChange?(
    owner: WebContentsLike,
    listener: (minimized: boolean) => void,
  ): () => void;
  /** Optional hook receiving a callback to pre-warm a standby `'canvas'` engine after first paint. */
  bindWarmUp?(warmUp: (owner: WebContentsLike) => void): void;
  /** Idle TTL (ms) before an unclaimed pre-warmed engine is auto-released (default `180_000`). */
  warmUpIdleTtlMs?: number;
  /** Optional timer primitives for testing power-blocker, warm-up, and parked-engine timeouts. */
  timers?: PowerBlockerTimers;
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
  /** Optional app-private managed downloads directory for scoped `file://` playback allowlist. */
  downloadsRoot?: string;
  /**
   * Dev gate only: receives each valid `gate:report` line and the sender's engine (`undefined` when it has none). The
   * channel is not registered without it.
   */
  gateReport?(line: string, engine: MpvEngine | undefined): void;
}

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
  const parkedOrphanMs = Math.max(0, deps.parkedOrphanMs ?? DEFAULT_PARKED_ORPHAN_MS);
  const timers: PowerBlockerTimers = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const powerCtl = createPlayerPowerBlockerController<WebContentsLike>({
    ...(powerBlocker === undefined ? {} : { powerBlocker }),
    ...(deps.bufferingReleaseMs === undefined
      ? {}
      : { bufferingReleaseMs: deps.bufferingReleaseMs }),
    ...(deps.frozenClockReleaseMs === undefined
      ? {}
      : { frozenClockReleaseMs: deps.frozenClockReleaseMs }),
    ...(deps.isWindowMinimized === undefined ? {} : { isWindowMinimized: deps.isWindowMinimized }),
    ...(deps.onWindowVisibilityChange === undefined
      ? {}
      : { onWindowVisibilityChange: deps.onWindowVisibilityChange }),
    timers,
  });
  const entries = new Map<string, Entry>();
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

  const releasePowerBlocker = (id: string): void => {
    powerCtl.release(id);
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
    powerCtl.unregisterEngine(id);
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
    warmUpCtl.discardOwner(owner.id);
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
      powerCtl.unwatchOwner(owner.id);
      invalidateOwner(owner);
      ownerGenerations.delete(owner.id);
    });
    owner.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) invalidateOwner(owner);
    });
    owner.on('render-process-gone', () => invalidateOwner(owner));
  };

  const warmUpCtl = createPlayerWarmUpController<WebContentsLike>({
    createEngine: deps.createEngine,
    nextEngineId: () => {
      counter += 1;
      return `engine-${counter}`;
    },
    getOwnerGeneration: (ownerId) => ownerGenerations.get(ownerId) ?? 0,
    hasActiveOrPendingEngine: (ownerId) =>
      countOwnedBy(ownerId) > 0 || (pendingOpens.get(ownerId)?.size ?? 0) > 0,
    getMultiViewTileCountForEngine: (engineId, fallbackOwnerId) => {
      const ownerId = entries.get(engineId)?.owner.id ?? fallbackOwnerId;
      return Math.max(1, countOwnedBy(ownerId) + (pendingOpens.get(ownerId)?.size ?? 0));
    },
    watchOwner: watch,
    ...(deps.isWindowMinimized === undefined ? {} : { isWindowMinimized: deps.isWindowMinimized }),
    isDisposed: () => disposed,
    timers,
    ...(deps.warmUpIdleTtlMs === undefined ? {} : { idleTtlMs: deps.warmUpIdleTtlMs }),
  });

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
    let standby: StandbyClaim<WebContentsLike> | undefined;
    if (replaceExisting) {
      if (primary && countOwnedBy(sender.id) === 0) standby = warmUpCtl.take(sender.id);
      else warmUpCtl.discardOwner(sender.id);
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
      if (primary && countOwnedBy(sender.id) === 0 && inFlight === 0) {
        standby = warmUpCtl.take(sender.id);
      } else {
        warmUpCtl.discardOwner(sender.id);
      }
    }

    let engineId = standby?.engineId ?? `engine-${++counter}`;
    let pendingSet = pendingOpens.get(sender.id);
    if (!pendingSet) {
      pendingSet = new Set<string>();
      pendingOpens.set(sender.id, pendingSet);
    }
    pendingSet.add(engineId);

    let registered = false;
    let initialFullscreen = false;
    let preSnapshots: EntrySnapshots = {};
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

    let engine: MpvEngine | undefined;
    let claimedStandby: StandbyClaim<WebContentsLike> | undefined;
    const getMultiViewTileCount = (): number => {
      const ownerId = entries.get(engineId)?.owner.id ?? sender.id;
      return Math.max(1, countOwnedBy(ownerId) + (pendingOpens.get(ownerId)?.size ?? 0));
    };
    try {
      if (standby) {
        const ready = await standby.waitReady();
        if (ready) {
          engine = ready;
          claimedStandby = standby;
          preSnapshots = standby.snapshots;
          initialFullscreen = standby.initialFullscreen;
        }
      }
      if (!engine && isCurrent()) {
        if (standby) {
          pendingSet.delete(engineId);
          engineId = `engine-${++counter}`;
          pendingSet.add(engineId);
        }
        engine = await deps.createEngine(sender, emitUi, engineId, getMultiViewTileCount);
      }
    } finally {
      if (pendingOpens.get(sender.id) === pendingSet) {
        pendingSet.delete(engineId);
        if (pendingSet.size === 0) pendingOpens.delete(sender.id);
      }
    }

    if (!engine || !isCurrent()) {
      engine?.release();
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

    powerCtl.registerEngine(engineId, sender);
    claimedStandby?.detachStandbySubscription();
    entry.unsubscribe = engine.subscribe((event) =>
      handlePlayerEngineEvent(engineId, entry, event, {
        powerCtl,
        ...(displayRefreshController === undefined ? {} : { displayRefreshController }),
        resolveDisplayId,
        ...(deps.onVideoAspectRatioChange === undefined
          ? {}
          : { onVideoAspectRatioChange: deps.onVideoAspectRatioChange }),
        syncTaskbar,
        pushMediaState,
        sendTo,
      }),
    );

    entries.set(engineId, entry);
    if (primary) activeMediaEngineId = engineId;
    registered = true;
    if (claimedStandby) replayClaimedStandby(engineId, sender, claimedStandby, emitUi, sendTo);
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

  const onPark: IpcListener = ({ sender }, engineId): boolean => {
    const ok = handleParkEngine(sender, engineId, {
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
    if (ok && typeof engineId === 'string') powerCtl.setParked(engineId, true);
    return ok;
  };

  const onAdopt: IpcListener = ({ sender }, engineId): PlayerOpenReply | null => {
    const reply = handleAdoptEngine(sender, engineId, {
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
    if (reply) {
      warmUpCtl.discardOwner(sender.id);
      powerCtl.setOwner(reply.engineId, sender);
    }
    return reply;
  };

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

  const onSetScrubbing: IpcListener = ({ sender }, rawRequest) => {
    if (disposed || sender.isDestroyed()) return;
    if (!isSetScrubbingRequest(rawRequest)) {
      log(`player ipc: dropped an invalid ${PLAYER_CHANNELS.setScrubbing} message`);
      return;
    }
    const entry = ownedEntry(sender, rawRequest.engineId);
    if (!entry) {
      log(
        `player ipc: dropped a ${PLAYER_CHANNELS.setScrubbing} message for an engine the sender does not own`,
      );
      return;
    }
    if (rawRequest.attempt > entry.attempt) entry.attempt = rawRequest.attempt;
    guarded(PLAYER_CHANNELS.setScrubbing, () =>
      entry.engine.setScrubbing?.(rawRequest.attempt, rawRequest.scrubbing),
    );
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
      ...(deps.downloadsRoot === undefined ? {} : { downloadsRoot: deps.downloadsRoot }),
      log,
      isEngineAlive: (id) => entries.has(id),
      sendError: (owner, id, attempt, detail) =>
        sendTo(owner, PLAYER_CHANNELS.event, {
          engineId: id,
          event: {
            type: 'error',
            attempt,
            atMs: deps.now(),
            error: { code: 'unsupported-format', detail },
          },
        }),
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
  deps.bindWarmUp?.((owner) => warmUpCtl.warmUp(owner));

  ipcMain.handle(PLAYER_CHANNELS.open, onOpen);
  ipcMain.handle(PLAYER_CHANNELS.close, onClose);
  ipcMain.handle(PLAYER_CHANNELS.park, onPark);
  ipcMain.handle(PLAYER_CHANNELS.adopt, onAdopt);
  ipcMain.handle(PLAYER_CHANNELS.setPrimary, onSetPrimary);
  ipcMain.handle(PLAYER_CHANNELS.setScrubbing, onSetScrubbing);
  ipcMain.handle(PLAYER_CHANNELS.pickSubtitleFile, onPickSubtitleFile);
  ipcMain.on(PLAYER_CHANNELS.command, onCommand);
  ipcMain.on(PLAYER_CHANNELS.area, onArea);
  if (deps.gateReport) ipcMain.on(PLAYER_CHANNELS.gateReport, onGate);

  return () => {
    disposed = true;
    offMediaCommand?.();
    warmUpCtl.dispose();
    ipcMain.removeHandler(PLAYER_CHANNELS.open);
    ipcMain.removeHandler(PLAYER_CHANNELS.close);
    ipcMain.removeHandler(PLAYER_CHANNELS.park);
    ipcMain.removeHandler(PLAYER_CHANNELS.adopt);
    ipcMain.removeHandler(PLAYER_CHANNELS.setPrimary);
    ipcMain.removeHandler(PLAYER_CHANNELS.setScrubbing);
    ipcMain.removeHandler(PLAYER_CHANNELS.pickSubtitleFile);
    ipcMain.removeListener(PLAYER_CHANNELS.command, onCommand);
    ipcMain.removeListener(PLAYER_CHANNELS.area, onArea);
    ipcMain.removeListener(PLAYER_CHANNELS.gateReport, onGate);
    for (const id of [...parkedTimers.keys()]) clearParkedTimer(id);
    for (const id of [...entries.keys()]) release(id);
    displayRefreshController?.restoreAll();
    powerCtl.dispose();
  };
}

import type { AttemptToken, ExternalSubtitleTrack } from '@elv/playback';
import {
  type DesktopMediaMetadata,
  isGateReport,
  isPlayerAreaMessage,
  isPlayerCommandMessage,
  PLAYER_CHANNELS,
  type PlayerEventMessage,
  type PlayerOpenReply,
  type PlayerRemoteMediaActionMessage,
  type PlayerUiEvent,
  type PlayerUiMessage,
  sanitizeDesktopMediaMetadata,
} from '../../shared/player-ipc.ts';
import type {
  DesktopMediaBridge,
  DesktopMediaCommand,
  DesktopMediaPlaybackStatus,
} from '../media-bridge.ts';
import type { TaskbarAction, TaskbarController } from '../taskbar-controls.ts';
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
  /** Optional OS media bridge (Linux MPRIS2 `#238` or macOS MediaPlayer `#301`). */
  mediaBridge?: DesktopMediaBridge;
  /** Optional sandboxed subtitle file picker (`#32`). */
  pickSubtitleFile?(owner: WebContentsLike): Promise<ExternalSubtitleTrack | null>;
  /**
   * Dev gate only: receives each valid `gate:report` line and the sender's engine (`undefined` when it has none). The
   * channel is not registered without it.
   */
  gateReport?(line: string, engine: MpvEngine | undefined): void;
}

const DEFAULT_BUFFERING_RELEASE_MS = 30_000;

interface TaskbarState {
  active: boolean;
  isVod: boolean;
  paused: boolean;
  positionMs: number;
  durationMs: number;
}

interface MediaBridgeState {
  status: DesktopMediaPlaybackStatus;
  isNavigating: boolean;
  kind: 'live' | 'vod';
  positionUs: number;
  durationUs: number;
  rate: number;
  volume: number;
  metadata: DesktopMediaMetadata | null;
}

interface Entry {
  owner: WebContentsLike;
  engine: MpvEngine;
  attempt: AttemptToken;
  unsubscribe(): void;
  taskbar?: TaskbarController;
  taskbarState: TaskbarState;
  mediaState: MediaBridgeState;
}

/**
 * Serves the renderer's player proxy: `player:open` creates the engine owned by the calling webContents (a second open
 * releases the first), commands and area updates reach only that owner's engine, events flow back to the owner only.
 * A main-frame navigation, a renderer crash or the webContents going away releases its engine. Every payload is validated; an
 * invalid one is dropped with a log line that names the channel but never the payload. Returns the disposer.
 */
export function registerPlayerIpc(deps: PlayerIpcDeps): () => void {
  const { ipcMain, log, powerBlocker, mediaBridge } = deps;
  const bufferingReleaseMs = Math.max(0, deps.bufferingReleaseMs ?? DEFAULT_BUFFERING_RELEASE_MS);
  const timers: PlayerIpcTimers = deps.timers ?? {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const entries = new Map<string, Entry>();
  const bufferingTimers = new Map<string, unknown>();
  const watched = new Set<number>();
  const generations = new Map<number, number>();
  let activeMediaEngineId: string | undefined;
  let counter = 0;
  let disposed = false;

  const pushStoppedMediaState = (): void => {
    mediaBridge?.updateState({
      status: 'Stopped',
      isNavigating: false,
      kind: 'live',
      positionUs: 0,
      durationUs: 0,
      rate: 1,
      volume: 1,
      metadata: null,
    });
  };

  const pushMediaState = (id: string, promote = false): void => {
    if (!mediaBridge) return;
    const entry = entries.get(id);
    if (!entry) return;
    if (promote || activeMediaEngineId === undefined || !entries.has(activeMediaEngineId)) {
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
    let last: { id: string; entry: Entry } | undefined;
    for (const [id, entry] of entries) last = { id, entry };
    if (last) activeMediaEngineId = last.id;
    return last;
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

  const bumpGeneration = (ownerId: number): number => {
    const next = (generations.get(ownerId) ?? 0) + 1;
    generations.set(ownerId, next);
    return next;
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

  const release = (id: string): void => {
    releasePowerBlocker(id);
    const entry = entries.get(id);
    if (!entry) return;
    entries.delete(id);
    deps.onVideoAspectRatioChange?.(entry.owner, undefined);
    entry.taskbar?.clear();
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
    const emitUi = (ui: PlayerUiEvent): void => {
      if (!isCurrent()) return;
      const message: PlayerUiMessage = { engineId, ui };
      sendTo(sender, PLAYER_CHANNELS.ui, message);
    };
    const engine = await deps.createEngine(sender, emitUi, engineId);
    if (!isCurrent()) {
      engine.release();
      throw new Error('the player open was superseded or the window closed while starting');
    }
    const taskbar = deps.createTaskbarController?.(sender, (action) =>
      emitUi({ type: 'key', key: action }),
    );
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
    const unsubscribe = engine.subscribe((event) => {
      if (event.type === 'state') {
        if (event.state === 'playing') {
          clearBufferingTimer(engineId);
          powerBlocker?.acquire(engineId);
          taskbarState.active = true;
          taskbarState.paused = false;
          syncTaskbar(taskbar, taskbarState);
          mediaState.status = 'Playing';
          mediaState.isNavigating = false;
          pushMediaState(engineId, true);
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
            syncTaskbar(taskbar, taskbarState);
            mediaState.status = 'Paused';
            mediaState.isNavigating = false;
            pushMediaState(engineId, true);
          } else if (event.state === 'ended') {
            taskbarState.active = false;
            taskbarState.paused = false;
            taskbar?.clear();
            deps.onVideoAspectRatioChange?.(sender, undefined);
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
        if (event.anchor.durationMs !== undefined)
          taskbarState.durationMs = event.anchor.durationMs;
        if (taskbarState.active) syncTaskbar(taskbar, taskbarState);
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
          deps.onVideoAspectRatioChange?.(sender, event.info.aspectRatio);
        }
      } else if (event.type === 'error') {
        releasePowerBlocker(engineId);
        taskbarState.active = false;
        taskbarState.paused = false;
        taskbar?.clear();
        deps.onVideoAspectRatioChange?.(sender, undefined);
        mediaState.status = 'Stopped';
        mediaState.isNavigating = false;
        pushMediaState(engineId);
      }
      const message: PlayerEventMessage = { engineId, event };
      sendTo(sender, PLAYER_CHANNELS.event, message);
    });
    entries.set(engineId, {
      owner: sender,
      engine,
      attempt: 0,
      unsubscribe,
      ...(taskbar === undefined ? {} : { taskbar }),
      taskbarState,
      mediaState,
    });
    activeMediaEngineId = engineId;
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
    const { engine } = entry;
    switch (command.name) {
      case 'load':
        entry.attempt = command.cmd.attempt;
        releasePowerBlocker(engineId);
        deps.onVideoAspectRatioChange?.(sender, undefined);
        entry.taskbarState.isVod = command.cmd.kind === 'vod';
        entry.taskbarState.positionMs = command.cmd.startMs ?? 0;
        entry.taskbarState.durationMs = 0;
        entry.taskbarState.active = false;
        entry.taskbarState.paused = false;
        entry.taskbar?.clear();
        entry.mediaState.status = 'Stopped';
        entry.mediaState.isNavigating = true;
        entry.mediaState.kind = command.cmd.kind;
        entry.mediaState.positionUs = Math.max(0, Math.round((command.cmd.startMs ?? 0) * 1000));
        entry.mediaState.durationUs = 0;
        pushMediaState(engineId, true);
        engine.load(command.cmd);
        break;
      case 'pause':
      case 'stop':
      case 'recreate':
        entry.attempt = command.attempt;
        releasePowerBlocker(engineId);
        if (command.name === 'stop') {
          deps.onVideoAspectRatioChange?.(sender, undefined);
          entry.taskbarState.active = false;
          entry.taskbarState.paused = false;
          entry.taskbar?.clear();
          entry.mediaState.status = 'Stopped';
          entry.mediaState.isNavigating = false;
          entry.mediaState.positionUs = 0;
          entry.mediaState.durationUs = 0;
          pushMediaState(engineId);
        } else if (command.name === 'recreate') {
          deps.onVideoAspectRatioChange?.(sender, undefined);
        }
        engine[command.name](command.attempt);
        break;
      case 'retry':
      case 'play':
        entry.attempt = command.attempt;
        engine[command.name](command.attempt);
        break;
      case 'seek': {
        entry.attempt = command.attempt;
        const posUs = Math.max(0, Math.round(command.positionMs * 1000));
        entry.mediaState.positionUs = posUs;
        if (activeMediaEngineId === engineId) {
          mediaBridge?.notifySeeked?.(posUs);
        }
        pushMediaState(engineId);
        engine.seek(command.attempt, command.positionMs);
        break;
      }
      case 'jumpToLiveEdge':
        entry.attempt = command.attempt;
        engine.jumpToLiveEdge?.(command.attempt);
        break;
      case 'setSpeed':
        entry.attempt = command.attempt;
        entry.mediaState.rate = command.rate;
        pushMediaState(engineId);
        engine.setSpeed?.(command.attempt, command.rate);
        break;
      case 'selectAudioTrack':
        engine.selectAudioTrack?.(command.attempt, command.id);
        break;
      case 'selectSubtitleTrack':
        engine.selectSubtitleTrack?.(command.attempt, command.id);
        break;
      case 'selectSecondarySubtitleTrack':
        engine.selectSecondarySubtitleTrack?.(command.attempt, command.id);
        break;
      case 'addExternalSubtitle':
        engine.addExternalSubtitle?.(command.attempt, command.track);
        break;
      case 'setSubtitleStyle':
        engine.setSubtitleStyle?.(command.style);
        break;
      case 'selectVideoQuality':
        engine.selectVideoQuality?.(command.attempt, command.id);
        break;
      case 'setVolume':
        entry.mediaState.volume = Math.max(0, Math.min(1, command.volume / 100));
        pushMediaState(engineId);
        engine.setVolume(command.volume);
        break;
      case 'setAudioDelay':
        if (command.attempt !== undefined) {
          engine.setAudioDelay(command.attempt, command.delaySec * 1000);
        } else {
          engine.setAudioDelay(command.delaySec);
        }
        break;
      case 'setSubtitleDelay':
        if (command.attempt !== undefined) {
          engine.setSubtitleDelay(command.attempt, command.delaySec * 1000);
        } else {
          engine.setSubtitleDelay(command.delaySec);
        }
        break;
      case 'setAudioDevice':
        engine.setAudioDevice(command.device);
        break;
      case 'setDeinterlace':
        engine.setDeinterlace(command.enabled);
        break;
      case 'setDeinterlaceMode':
        engine.setDeinterlaceMode(command.mode);
        break;
      case 'setPitchLock':
        engine.setPitchLock(command.locked);
        break;
      case 'setAudioNormalization':
        engine.setAudioNormalization(command.enabled);
        break;
      case 'queueNext':
        engine.queueNext(command.request);
        break;
      case 'clearQueue':
        engine.clearQueue();
        break;
      case 'setHwdec':
        engine.setHwdec(command.profile);
        break;
      case 'setResizeMode':
        engine.setResizeMode(command.mode);
        break;
      case 'setFilterSdh':
        engine.setFilterSdh(command.enabled);
        break;
      case 'setSubtitleFontFamily':
        engine.setSubtitleFontFamily(command.family);
        break;
      case 'setMediaMetadata': {
        const sanitized = sanitizeDesktopMediaMetadata(command.metadata);
        entry.mediaState.metadata = sanitized;
        if (sanitized !== null) entry.mediaState.kind = sanitized.kind;
        pushMediaState(engineId, sanitized !== null);
        break;
      }
      case 'fullscreen':
        engine.toggleFullscreen();
        break;
      case 'mute':
        engine.toggleMute();
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

  const handleMediaCommand = (cmd: DesktopMediaCommand): void => {
    if (disposed) return;
    const active = resolveActiveMediaEntry();
    if (!active) return;
    const { id, entry } = active;
    switch (cmd.type) {
      case 'play':
        entry.engine.play(entry.attempt);
        break;
      case 'pause':
        entry.engine.pause(entry.attempt);
        break;
      case 'togglePlayPause':
        if (entry.mediaState.status === 'Playing') entry.engine.pause(entry.attempt);
        else entry.engine.play(entry.attempt);
        break;
      case 'stop':
        releasePowerBlocker(id);
        deps.onVideoAspectRatioChange?.(entry.owner, undefined);
        entry.taskbarState.active = false;
        entry.taskbarState.paused = false;
        entry.taskbar?.clear();
        entry.mediaState.status = 'Stopped';
        entry.mediaState.isNavigating = false;
        entry.mediaState.positionUs = 0;
        entry.mediaState.durationUs = 0;
        pushMediaState(id);
        entry.engine.stop(entry.attempt);
        break;
      case 'next':
      case 'previous': {
        const canStep = entry.mediaState.metadata
          ? entry.mediaState.metadata.canStepTrack
          : entry.mediaState.kind === 'live';
        if (!canStep) break;
        const msg: PlayerRemoteMediaActionMessage = { engineId: id, action: cmd.type };
        sendTo(entry.owner, PLAYER_CHANNELS.remoteMediaAction, msg);
        break;
      }
      case 'seekByUs': {
        if (
          entry.mediaState.kind !== 'vod' ||
          entry.mediaState.durationUs <= 0 ||
          !Number.isFinite(cmd.offsetUs)
        ) {
          break;
        }
        const targetUs = Math.max(
          0,
          Math.min(
            entry.mediaState.durationUs,
            Math.round(entry.mediaState.positionUs + cmd.offsetUs),
          ),
        );
        entry.mediaState.positionUs = targetUs;
        entry.engine.seek(entry.attempt, targetUs / 1000);
        mediaBridge?.notifySeeked?.(targetUs);
        pushMediaState(id);
        break;
      }
      case 'seekToUs': {
        if (
          entry.mediaState.kind !== 'vod' ||
          entry.mediaState.durationUs <= 0 ||
          !Number.isFinite(cmd.positionUs)
        ) {
          break;
        }
        const targetUs = Math.max(
          0,
          Math.min(entry.mediaState.durationUs, Math.round(cmd.positionUs)),
        );
        entry.mediaState.positionUs = targetUs;
        entry.engine.seek(entry.attempt, targetUs / 1000);
        mediaBridge?.notifySeeked?.(targetUs);
        pushMediaState(id);
        break;
      }
      case 'setRate': {
        if (entry.mediaState.kind !== 'vod' || !Number.isFinite(cmd.rate) || cmd.rate <= 0) break;
        const clamped = Math.max(0.25, Math.min(4, cmd.rate));
        entry.mediaState.rate = clamped;
        entry.engine.setSpeed?.(entry.attempt, clamped);
        pushMediaState(id);
        break;
      }
      case 'setVolume': {
        if (!Number.isFinite(cmd.volume)) break;
        const clamped = Math.max(0, Math.min(1, cmd.volume));
        entry.mediaState.volume = clamped;
        entry.engine.setVolume(Math.round(clamped * 100));
        pushMediaState(id);
        break;
      }
    }
  };

  const offMediaCommand = mediaBridge?.onCommand(handleMediaCommand);

  ipcMain.handle(PLAYER_CHANNELS.open, onOpen);
  ipcMain.handle(PLAYER_CHANNELS.close, onClose);
  ipcMain.handle(PLAYER_CHANNELS.pickSubtitleFile, onPickSubtitleFile);
  ipcMain.on(PLAYER_CHANNELS.command, onCommand);
  ipcMain.on(PLAYER_CHANNELS.area, onArea);
  if (deps.gateReport) ipcMain.on(PLAYER_CHANNELS.gateReport, onGate);

  return () => {
    disposed = true;
    offMediaCommand?.();
    ipcMain.removeHandler(PLAYER_CHANNELS.open);
    ipcMain.removeHandler(PLAYER_CHANNELS.close);
    ipcMain.removeHandler(PLAYER_CHANNELS.pickSubtitleFile);
    ipcMain.removeListener(PLAYER_CHANNELS.command, onCommand);
    ipcMain.removeListener(PLAYER_CHANNELS.area, onArea);
    ipcMain.removeListener(PLAYER_CHANNELS.gateReport, onGate);
    for (const id of [...bufferingTimers.keys()]) clearBufferingTimer(id);
    for (const id of [...entries.keys()]) release(id);
    powerBlocker?.releaseAll();
  };
}

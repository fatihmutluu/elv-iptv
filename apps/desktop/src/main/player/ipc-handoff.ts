import type { DisplaySyncPolicy, EngineEvent } from '@elv/playback';
import {
  isEngineId,
  PLAYER_CHANNELS,
  type PlayerEventMessage,
  type PlayerOpenReply,
  type PlayerUiEvent,
  type PlayerUiMessage,
  type PresenterKind,
} from '../../shared/player-ipc.ts';
import type { TaskbarAction, TaskbarController } from '../taskbar-controls.ts';
import type { DesktopDisplayRefreshController } from './display-refresh.ts';
import type { MpvEngine } from './engine.ts';
import type { MediaBridgeState, TaskbarState } from './ipc-media.ts';

/** Orphan timeout (ms) before a parked engine that was never adopted is automatically released. */
export const DEFAULT_PARKED_ORPHAN_MS = 15_000;

/** Latest engine/UI snapshots retained on an IPC entry so an adopting renderer hydrates immediately. */
export interface EntrySnapshots {
  lastPresenterUi?: Extract<PlayerUiEvent, { type: 'presenter' }> | undefined;
  lastAudioDevicesUi?: Extract<PlayerUiEvent, { type: 'audio-devices' }> | undefined;
  lastStateEvent?: Extract<EngineEvent, { type: 'state' }> | undefined;
  lastClockEvent?: Extract<EngineEvent, { type: 'clock' }> | undefined;
  lastTracksEvent?: Extract<EngineEvent, { type: 'tracks' }> | undefined;
  lastMediaInfoEvent?: Extract<EngineEvent, { type: 'mediaInfo' }> | undefined;
  lastChaptersEvent?: Extract<EngineEvent, { type: 'chapters' }> | undefined;
}

/** Minimal `Entry` shape operated on by handoff and primary-owner synchronization helpers. */
export interface HandoffEntry<TOwner> {
  owner: TOwner;
  engine: MpvEngine;
  isPrimary: boolean;
  parked: boolean;
  lastAspectRatio: number | undefined;
  lastFps: number | undefined;
  lastFullscreen: boolean;
  lastDisplaySync: DisplaySyncPolicy | undefined;
  snapshots: EntrySnapshots;
  emitUi: (ui: PlayerUiEvent) => void;
  taskbar?: TaskbarController | undefined;
  taskbarState: TaskbarState;
  mediaState: MediaBridgeState;
}

/** Updates cached UI snapshots as presenter/device events arrive. */
export function recordEntryUiSnapshot(snapshots: EntrySnapshots, ui: PlayerUiEvent): void {
  if (ui.type === 'presenter') snapshots.lastPresenterUi = ui;
  else if (ui.type === 'audio-devices') snapshots.lastAudioDevicesUi = ui;
}

/** Updates cached engine event snapshots as live playback events arrive. */
export function recordEntryEventSnapshot(snapshots: EntrySnapshots, event: EngineEvent): void {
  if (event.type === 'state') {
    snapshots.lastStateEvent = event;
    if (event.state === 'opening' || event.state === 'ended') {
      snapshots.lastClockEvent = undefined;
      snapshots.lastTracksEvent = undefined;
      snapshots.lastMediaInfoEvent = undefined;
      snapshots.lastChaptersEvent = undefined;
    }
  } else if (event.type === 'clock') {
    snapshots.lastClockEvent = event;
  } else if (event.type === 'tracks') {
    snapshots.lastTracksEvent = event;
  } else if (event.type === 'mediaInfo') {
    snapshots.lastMediaInfoEvent = event;
  } else if (event.type === 'chapters') {
    snapshots.lastChaptersEvent = event;
  } else if (event.type === 'error') {
    snapshots.lastClockEvent = undefined;
    snapshots.lastTracksEvent = undefined;
    snapshots.lastMediaInfoEvent = undefined;
    snapshots.lastChaptersEvent = undefined;
  }
}

/** Replays presenter, fullscreen, audio device, and playback state snapshots to an adopting owner. */
function sendAdoptedSnapshotsToOwner(params: {
  readonly engineId: string;
  readonly presenterKind: PresenterKind;
  readonly lastFullscreen: boolean;
  readonly snapshots: EntrySnapshots;
  readonly send: (channel: string, message: unknown) => void;
}): void {
  const { engineId, presenterKind, lastFullscreen, snapshots, send } = params;
  const sendUi = (msg: PlayerUiMessage): void => send(PLAYER_CHANNELS.ui, msg);
  const sendEvent = (msg: PlayerEventMessage): void => send(PLAYER_CHANNELS.event, msg);
  const presenterUi: Extract<PlayerUiEvent, { type: 'presenter' }> = snapshots.lastPresenterUi ?? {
    type: 'presenter',
    kind: presenterKind,
    coversArea: false,
  };
  sendUi({ engineId, ui: presenterUi });
  sendUi({ engineId, ui: { type: 'fullscreen-changed', fullscreen: lastFullscreen } });
  if (snapshots.lastAudioDevicesUi) {
    sendUi({ engineId, ui: snapshots.lastAudioDevicesUi });
  }
  const orderedEvents: Array<EngineEvent | undefined> = [
    snapshots.lastStateEvent,
    snapshots.lastClockEvent,
    snapshots.lastTracksEvent,
    snapshots.lastMediaInfoEvent,
    snapshots.lastChaptersEvent,
  ];
  for (const event of orderedEvents) {
    if (event) sendEvent({ engineId, event });
  }
}

/** Synchronizes taskbar, aspect lock, display refresh, and OS media state for a primary entry. */
export function syncPrimaryOwnerEffects<TOwner>(
  engineId: string,
  entry: HandoffEntry<TOwner>,
  deps: {
    createTaskbarController?: (
      owner: TOwner,
      onAction: (action: TaskbarAction) => void,
    ) => TaskbarController | undefined;
    syncTaskbar: (taskbar: TaskbarController | undefined, state: TaskbarState) => void;
    onVideoAspectRatioChange?: (owner: TOwner, aspectRatio: number | undefined) => void;
    displayRefreshController?: DesktopDisplayRefreshController;
    resolveDisplayId: (owner: TOwner) => string | undefined;
    promoteMedia: (engineId: string) => void;
  },
): void {
  const owner = entry.owner;
  entry.taskbar ??= deps.createTaskbarController?.(owner, (action: TaskbarAction) =>
    entry.emitUi({ type: 'key', key: action }),
  );
  if (entry.taskbarState.active) deps.syncTaskbar(entry.taskbar, entry.taskbarState);
  else entry.taskbar?.clear();
  deps.onVideoAspectRatioChange?.(owner, entry.lastAspectRatio);
  if (deps.displayRefreshController) {
    const displayId = deps.resolveDisplayId(owner);
    if (entry.lastDisplaySync !== undefined) {
      deps.displayRefreshController.setPolicy(engineId, entry.lastDisplaySync);
    }
    deps.displayRefreshController.setFullscreen(engineId, entry.lastFullscreen, displayId);
    deps.displayRefreshController.setContentFps(engineId, entry.lastFps, displayId);
    deps.displayRefreshController.setPlaybackActive(
      engineId,
      entry.mediaState.status === 'Playing',
      displayId,
    );
  }
  deps.promoteMedia(engineId);
}

/** Executes `player:park` validation, cleanup of old window effects, and orphan timer arming. */
export function handleParkEngine<TOwner extends { isDestroyed(): boolean }>(
  sender: TOwner,
  engineId: unknown,
  ctx: {
    disposed: boolean;
    hasRetargetOwner: boolean;
    log: (line: string) => void;
    ownedEntry: (sender: TOwner, engineId: string) => HandoffEntry<TOwner> | undefined;
    onVideoAspectRatioChange?: (owner: TOwner, aspectRatio: number | undefined) => void;
    displayRefreshController?: DesktopDisplayRefreshController;
    armParkedTimer: (engineId: string) => void;
  },
): boolean {
  if (ctx.disposed || sender.isDestroyed()) return false;
  if (!isEngineId(engineId)) {
    ctx.log(`player ipc: dropped an invalid ${PLAYER_CHANNELS.park} message`);
    return false;
  }
  const entry = ctx.ownedEntry(sender, engineId);
  if (!entry) return false;
  const canRetarget =
    entry.engine.presenterKind === 'canvas' &&
    (ctx.hasRetargetOwner || typeof entry.engine.retargetWindow === 'function');
  if (!canRetarget) return false;
  entry.parked = true;
  entry.taskbar?.clear();
  entry.taskbar = undefined;
  if (entry.isPrimary) {
    ctx.onVideoAspectRatioChange?.(entry.owner, undefined);
    ctx.displayRefreshController?.restoreForEngine(engineId);
  }
  ctx.armParkedTimer(engineId);
  return true;
}

/** Executes `player:adopt` validation, window retargeting, ownership transfer, and snapshot replay. */
export function handleAdoptEngine<TOwner extends { isDestroyed(): boolean }>(
  sender: TOwner,
  engineId: unknown,
  ctx: {
    disposed: boolean;
    now: () => number;
    log: (line: string) => void;
    getEntry: (engineId: string) => HandoffEntry<TOwner> | undefined;
    clearParkedTimer: (engineId: string) => void;
    armParkedTimer: (engineId: string) => void;
    retargetOwner?: (engine: MpvEngine, nextOwner: TOwner) => boolean;
    releaseOwnedBy: (owner: TOwner) => void;
    watch: (owner: TOwner) => void;
    syncPrimary: (engineId: string, entry: HandoffEntry<TOwner>) => void;
    sendTo: (owner: TOwner, channel: string, message: unknown) => void;
  },
): PlayerOpenReply | null {
  if (ctx.disposed || sender.isDestroyed()) return null;
  if (!isEngineId(engineId)) {
    ctx.log(`player ipc: dropped an invalid ${PLAYER_CHANNELS.adopt} message`);
    return null;
  }
  const entry = ctx.getEntry(engineId);
  if (!entry || !entry.parked) return null;
  const arrivedAtMs = ctx.now();
  ctx.clearParkedTimer(engineId);
  if (ctx.retargetOwner && !ctx.retargetOwner(entry.engine, sender)) {
    ctx.armParkedTimer(engineId);
    return null;
  }
  ctx.releaseOwnedBy(sender);
  entry.parked = false;
  entry.owner = sender;
  entry.isPrimary = true;
  ctx.watch(sender);
  ctx.syncPrimary(engineId, entry);
  sendAdoptedSnapshotsToOwner({
    engineId,
    presenterKind: entry.engine.presenterKind,
    lastFullscreen: entry.lastFullscreen,
    snapshots: entry.snapshots,
    send: (channel, msg) => ctx.sendTo(sender, channel, msg),
  });
  return { engineId, mainNowMs: (arrivedAtMs + ctx.now()) / 2 };
}

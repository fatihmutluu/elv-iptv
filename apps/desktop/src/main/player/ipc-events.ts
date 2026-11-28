import type { EngineEvent } from '@elv/playback';
import {
  PLAYER_CHANNELS,
  type PlayerEventMessage,
  type PlayerUiEvent,
} from '../../shared/player-ipc.ts';
import type { TaskbarController } from '../taskbar-controls.ts';
import type { DesktopDisplayRefreshController } from './display-refresh.ts';
import { type EntrySnapshots, recordEntryEventSnapshot } from './ipc-handoff.ts';
import type { MediaBridgeState, TaskbarState } from './ipc-media.ts';
import type { PlayerPowerBlockerController } from './ipc-power-blocker.ts';
import type { StandbyClaim } from './ipc-warmup.ts';

/** Mutable IPC entry subset updated by {@link handlePlayerEngineEvent}. */
export interface PlayerEventEntry<TOwner extends { readonly id: number }> {
  owner: TOwner;
  isPrimary: boolean;
  parked: boolean;
  lastAspectRatio: number | undefined;
  lastFps: number | undefined;
  snapshots: EntrySnapshots;
  taskbar?: TaskbarController | undefined;
  readonly taskbarState: TaskbarState;
  readonly mediaState: MediaBridgeState;
}

/** Collaborators invoked when an active `MpvEngine` emits a playback event. */
export interface PlayerEngineEventHooks<TOwner extends { readonly id: number }> {
  readonly powerCtl: PlayerPowerBlockerController<TOwner>;
  readonly displayRefreshController?: DesktopDisplayRefreshController;
  readonly resolveDisplayId: (owner: TOwner) => string | undefined;
  readonly onVideoAspectRatioChange?: (owner: TOwner, aspectRatio: number | undefined) => void;
  readonly syncTaskbar: (taskbar: TaskbarController | undefined, state: TaskbarState) => void;
  readonly pushMediaState: (engineId: string, promote?: boolean) => void;
  readonly sendTo: (owner: TOwner, channel: string, message: unknown) => void;
}

/**
 * Processes one `EngineEvent` emitted by a registered desktop `MpvEngine`:
 * updates snapshots, power-blocker state/clock watchdogs, taskbar, AFR, OS media state,
 * and forwards the event to the owning renderer unless the engine is currently parked.
 */
export function handlePlayerEngineEvent<TOwner extends { readonly id: number }>(
  engineId: string,
  entry: PlayerEventEntry<TOwner>,
  event: EngineEvent,
  hooks: PlayerEngineEventHooks<TOwner>,
): void {
  recordEntryEventSnapshot(entry.snapshots, event);
  const { taskbarState, mediaState } = entry;
  const activePrimary = entry.isPrimary && !entry.parked;

  if (event.type === 'state') {
    hooks.powerCtl.onState(engineId, event.state);
    if (event.state === 'playing') {
      taskbarState.active = true;
      taskbarState.paused = false;
      if (activePrimary) {
        hooks.syncTaskbar(entry.taskbar, taskbarState);
        hooks.displayRefreshController?.setPlaybackActive(
          engineId,
          true,
          hooks.resolveDisplayId(entry.owner),
        );
      }
      mediaState.status = 'Playing';
      mediaState.isNavigating = false;
      hooks.pushMediaState(engineId, entry.isPrimary);
    } else if (event.state === 'paused') {
      taskbarState.active = true;
      taskbarState.paused = true;
      if (activePrimary) hooks.syncTaskbar(entry.taskbar, taskbarState);
      mediaState.status = 'Paused';
      mediaState.isNavigating = false;
      hooks.pushMediaState(engineId, entry.isPrimary);
    } else if (event.state === 'ended') {
      taskbarState.active = false;
      taskbarState.paused = false;
      entry.lastAspectRatio = undefined;
      entry.lastFps = undefined;
      if (activePrimary) {
        entry.taskbar?.clear();
        hooks.onVideoAspectRatioChange?.(entry.owner, undefined);
        hooks.displayRefreshController?.setPlaybackActive(
          engineId,
          false,
          hooks.resolveDisplayId(entry.owner),
        );
      }
      mediaState.status = 'Stopped';
      mediaState.isNavigating = false;
      mediaState.positionUs = 0;
      mediaState.durationUs = 0;
      hooks.pushMediaState(engineId);
    } else if (event.state === 'opening') {
      mediaState.isNavigating = true;
      hooks.pushMediaState(engineId);
    }
  } else if (event.type === 'clock') {
    hooks.powerCtl.onClock(engineId, event.anchor.positionMs);
    taskbarState.positionMs = event.anchor.positionMs;
    if (event.anchor.durationMs !== undefined) {
      taskbarState.durationMs = event.anchor.durationMs;
    }
    if (activePrimary && taskbarState.active) hooks.syncTaskbar(entry.taskbar, taskbarState);
    mediaState.positionUs = Math.max(0, Math.round(event.anchor.positionMs * 1000));
    if (event.anchor.durationMs !== undefined) {
      mediaState.durationUs = Math.max(0, Math.round(event.anchor.durationMs * 1000));
    }
    if (Number.isFinite(event.anchor.rate) && event.anchor.rate > 0) {
      mediaState.rate = event.anchor.rate;
    }
    hooks.pushMediaState(engineId);
  } else if (event.type === 'mediaInfo') {
    if (
      typeof event.info.aspectRatio === 'number' &&
      Number.isFinite(event.info.aspectRatio) &&
      event.info.aspectRatio > 0
    ) {
      entry.lastAspectRatio = event.info.aspectRatio;
      if (activePrimary) hooks.onVideoAspectRatioChange?.(entry.owner, event.info.aspectRatio);
    }
    if (
      typeof event.info.fps === 'number' &&
      Number.isFinite(event.info.fps) &&
      event.info.fps > 0
    ) {
      entry.lastFps = event.info.fps;
      if (activePrimary) {
        hooks.displayRefreshController?.setContentFps(
          engineId,
          event.info.fps,
          hooks.resolveDisplayId(entry.owner),
        );
      }
    }
  } else if (event.type === 'error') {
    hooks.powerCtl.release(engineId);
    taskbarState.active = false;
    taskbarState.paused = false;
    entry.lastAspectRatio = undefined;
    entry.lastFps = undefined;
    if (activePrimary) {
      entry.taskbar?.clear();
      hooks.onVideoAspectRatioChange?.(entry.owner, undefined);
      hooks.displayRefreshController?.setPlaybackActive(
        engineId,
        false,
        hooks.resolveDisplayId(entry.owner),
      );
    }
    mediaState.status = 'Stopped';
    mediaState.isNavigating = false;
    hooks.pushMediaState(engineId);
  }

  if (!entry.parked) {
    const message: PlayerEventMessage = { engineId, event };
    hooks.sendTo(entry.owner, PLAYER_CHANNELS.event, message);
  }
}

/** Attaches the live UI forwarder and replays buffered warm-up UI/surface events to the claiming renderer. */
export function replayClaimedStandby<TOwner>(
  engineId: string,
  sender: TOwner,
  claim: StandbyClaim<TOwner>,
  emitUi: (ui: PlayerUiEvent) => void,
  sendTo: (owner: TOwner, channel: string, message: unknown) => void,
): void {
  claim.attachUiForwarder(emitUi);
  if (claim.snapshots.lastPresenterUi) emitUi(claim.snapshots.lastPresenterUi);
  if (claim.snapshots.lastAudioDevicesUi) emitUi(claim.snapshots.lastAudioDevicesUi);
  if (claim.initialFullscreen) emitUi({ type: 'fullscreen-changed', fullscreen: true });
  for (const buffered of claim.bufferedEvents) {
    sendTo(sender, PLAYER_CHANNELS.event, { engineId, event: buffered });
  }
}

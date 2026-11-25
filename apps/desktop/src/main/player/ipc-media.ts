import type { AttemptToken } from '@elv/playback';
import {
  type DesktopMediaMetadata,
  PLAYER_CHANNELS,
  type PlayerRemoteMediaActionMessage,
} from '../../shared/player-ipc.ts';
import type {
  DesktopMediaBridge,
  DesktopMediaCommand,
  DesktopMediaPlaybackStatus,
  DesktopMediaStateSnapshot,
} from '../media-bridge.ts';
import type { TaskbarController } from '../taskbar-controls.ts';
import type { MpvEngine } from './engine.ts';

/** Per-engine taskbar state tracked by `registerPlayerIpc`. */
export interface TaskbarState {
  active: boolean;
  isVod: boolean;
  paused: boolean;
  positionMs: number;
  durationMs: number;
}

/** Per-engine OS media bridge state tracked by `registerPlayerIpc`. */
export interface MediaBridgeState {
  status: DesktopMediaPlaybackStatus;
  isNavigating: boolean;
  kind: 'live' | 'vod';
  positionUs: number;
  durationUs: number;
  rate: number;
  volume: number;
  metadata: DesktopMediaMetadata | null;
}

/** Subset of a registered player IPC entry consumed by {@link dispatchDesktopMediaCommand}. */
export interface MediaCommandTarget<TOwner> {
  readonly id: string;
  readonly entry: {
    readonly owner: TOwner;
    readonly engine: MpvEngine;
    readonly attempt: AttemptToken;
    readonly isPrimary: boolean;
    readonly taskbar?: TaskbarController;
    readonly taskbarState: TaskbarState;
    readonly mediaState: MediaBridgeState;
  };
}

/** Collaborators for {@link dispatchDesktopMediaCommand}. */
export interface MediaCommandHooks<TOwner> {
  readonly mediaBridge?: DesktopMediaBridge;
  readonly releasePowerBlocker: (id: string) => void;
  readonly onVideoAspectRatioChange?: (owner: TOwner, aspectRatio: number | undefined) => void;
  readonly pushMediaState: (id: string, promote?: boolean) => void;
  readonly sendTo: (owner: TOwner, channel: string, message: unknown) => void;
}

/** Creates a stopped OS media state snapshot pushed when no active engine remains. */
export function stoppedMediaState(): DesktopMediaStateSnapshot {
  return {
    status: 'Stopped',
    isNavigating: false,
    kind: 'live',
    positionUs: 0,
    durationUs: 0,
    rate: 1,
    volume: 1,
    metadata: null,
  };
}

/** Dispatches an inbound OS media bridge command (MPRIS2 / macOS Now Playing) to the active engine. */
export function dispatchDesktopMediaCommand<TOwner>(
  cmd: DesktopMediaCommand,
  active: MediaCommandTarget<TOwner>,
  hooks: MediaCommandHooks<TOwner>,
): void {
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
      hooks.releasePowerBlocker(id);
      if (entry.isPrimary) {
        hooks.onVideoAspectRatioChange?.(entry.owner, undefined);
      }
      entry.taskbarState.active = false;
      entry.taskbarState.paused = false;
      entry.taskbar?.clear();
      entry.mediaState.status = 'Stopped';
      entry.mediaState.isNavigating = false;
      entry.mediaState.positionUs = 0;
      entry.mediaState.durationUs = 0;
      hooks.pushMediaState(id);
      entry.engine.stop(entry.attempt);
      break;
    case 'next':
    case 'previous': {
      const canStep = entry.mediaState.metadata
        ? entry.mediaState.metadata.canStepTrack
        : entry.mediaState.kind === 'live';
      if (!canStep) break;
      const msg: PlayerRemoteMediaActionMessage = { engineId: id, action: cmd.type };
      hooks.sendTo(entry.owner, PLAYER_CHANNELS.remoteMediaAction, msg);
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
      hooks.mediaBridge?.notifySeeked?.(targetUs);
      hooks.pushMediaState(id);
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
      hooks.mediaBridge?.notifySeeked?.(targetUs);
      hooks.pushMediaState(id);
      break;
    }
    case 'setRate': {
      if (entry.mediaState.kind !== 'vod' || !Number.isFinite(cmd.rate) || cmd.rate <= 0) break;
      const clamped = Math.max(0.25, Math.min(4, cmd.rate));
      entry.mediaState.rate = clamped;
      entry.engine.setSpeed?.(entry.attempt, clamped);
      hooks.pushMediaState(id);
      break;
    }
    case 'setVolume': {
      if (!Number.isFinite(cmd.volume)) break;
      const clamped = Math.max(0, Math.min(1, cmd.volume));
      entry.mediaState.volume = clamped;
      entry.engine.setVolume(Math.round(clamped * 100));
      hooks.pushMediaState(id);
      break;
    }
  }
}

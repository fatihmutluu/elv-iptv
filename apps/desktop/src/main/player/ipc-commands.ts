import type { AttemptToken, DisplaySyncPolicy } from '@elv/playback';
import { type BridgeCommand, sanitizeDesktopMediaMetadata } from '../../shared/player-ipc.ts';
import type { DesktopMediaBridge } from '../media-bridge.ts';
import type { TaskbarController } from '../taskbar-controls.ts';
import type { DesktopDisplayRefreshController } from './display-refresh.ts';
import type { MpvEngine } from './engine.ts';
import type { MediaBridgeState, TaskbarState } from './ipc-media.ts';

/** Mutable per-engine IPC entry subset handled by {@link dispatchPlayerBridgeCommand}. */
export interface PlayerCommandEntry<TOwner> {
  readonly owner: TOwner;
  readonly engine: MpvEngine;
  attempt: AttemptToken;
  isPrimary: boolean;
  lastAspectRatio: number | undefined;
  lastFps: number | undefined;
  lastDisplaySync: DisplaySyncPolicy | undefined;
  taskbar?: TaskbarController | undefined;
  readonly taskbarState: TaskbarState;
  readonly mediaState: MediaBridgeState;
}

/** Side-effect hooks invoked while dispatching a validated {@link BridgeCommand}. */
export interface PlayerCommandDispatchHooks<TOwner> {
  readonly mediaBridge?: DesktopMediaBridge;
  readonly displayRefreshController?: DesktopDisplayRefreshController;
  readonly resolveDisplayId: (owner: TOwner) => string | undefined;
  readonly releasePowerBlocker: (engineId: string) => void;
  readonly onVideoAspectRatioChange?: (owner: TOwner, aspectRatio: number | undefined) => void;
  readonly pushMediaState: (engineId: string, promote?: boolean) => void;
  readonly isActiveMediaEngine: (engineId: string) => boolean;
  readonly releaseEngine: (engineId: string) => void;
}

/** Dispatches one validated `player:command` payload onto an owned engine and host integrations. */
export function dispatchPlayerBridgeCommand<TOwner>(
  engineId: string,
  entry: PlayerCommandEntry<TOwner>,
  command: BridgeCommand,
  hooks: PlayerCommandDispatchHooks<TOwner>,
): void {
  const { engine, owner } = entry;
  switch (command.name) {
    case 'load': {
      entry.attempt = command.cmd.attempt;
      entry.lastAspectRatio = undefined;
      entry.lastFps = undefined;
      hooks.releasePowerBlocker(engineId);
      if (command.cmd.options?.displaySync !== undefined) {
        entry.lastDisplaySync = command.cmd.options.displaySync;
      }
      if (entry.isPrimary) {
        hooks.onVideoAspectRatioChange?.(owner, undefined);
        if (command.cmd.options?.displaySync !== undefined) {
          hooks.displayRefreshController?.setPolicy(engineId, command.cmd.options.displaySync);
        }
      }
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
      hooks.pushMediaState(engineId, entry.isPrimary);
      engine.load(command.cmd);
      break;
    }
    case 'pause':
    case 'stop':
    case 'recreate':
      entry.attempt = command.attempt;
      hooks.releasePowerBlocker(engineId);
      if (command.name === 'stop') {
        entry.lastAspectRatio = undefined;
        entry.lastFps = undefined;
        if (entry.isPrimary) {
          hooks.onVideoAspectRatioChange?.(owner, undefined);
          hooks.displayRefreshController?.setPlaybackActive(
            engineId,
            false,
            hooks.resolveDisplayId(owner),
          );
        }
        entry.taskbarState.active = false;
        entry.taskbarState.paused = false;
        entry.taskbar?.clear();
        entry.mediaState.status = 'Stopped';
        entry.mediaState.isNavigating = false;
        entry.mediaState.positionUs = 0;
        entry.mediaState.durationUs = 0;
        hooks.pushMediaState(engineId);
      } else if (command.name === 'recreate') {
        entry.lastAspectRatio = undefined;
        entry.lastFps = undefined;
        if (entry.isPrimary) hooks.onVideoAspectRatioChange?.(owner, undefined);
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
      if (hooks.isActiveMediaEngine(engineId)) {
        hooks.mediaBridge?.notifySeeked?.(posUs);
      }
      hooks.pushMediaState(engineId);
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
      hooks.pushMediaState(engineId);
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
    case 'selectProgram':
      engine.selectProgram?.(command.attempt, command.id);
      break;
    case 'setVolume':
      entry.mediaState.volume = Math.max(0, Math.min(1, command.volume / 100));
      hooks.pushMediaState(engineId);
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
    case 'setDisplaySync':
      entry.lastDisplaySync = command.policy;
      engine.setDisplaySync?.(command.policy);
      if (entry.isPrimary) {
        hooks.displayRefreshController?.setPolicy(engineId, command.policy);
      }
      break;
    case 'setDesktopAudioOutput':
      engine.setDesktopAudioOutput?.(command.config);
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
      hooks.pushMediaState(engineId, entry.isPrimary && sanitized !== null);
      break;
    }
    case 'fullscreen':
      engine.toggleFullscreen();
      break;
    case 'mute':
      engine.toggleMute();
      break;
    case 'setMuted':
      engine.setMuted?.(command.muted);
      break;
    case 'release':
      hooks.releaseEngine(engineId);
      break;
  }
}

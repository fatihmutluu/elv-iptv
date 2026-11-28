import type { SubtitleStyleConfig } from '@elv/domain';
import type { DesktopAudioOutputConfig, DisplaySyncPolicy } from '@elv/playback';
import type { DeinterlaceMode } from '../../../shared/player-ipc.ts';
import { desktopAudioOutputCommands, sameDesktopAudioOutputConfig } from './audio-output.ts';
import type { MpvCommand, MpvReply } from './codec.ts';
import {
  audioNormalizationCommand,
  deinterlaceCommands,
  pitchLockCommand,
  videoSyncCommand,
  videoSyncModeFor,
} from './options.ts';
import { subtitleStyleCommands } from './subtitle-style.ts';

/** Per-session applied setting markers shared between `connect` and `loadSlot`. */
export interface SessionAppliedSettings {
  appliedAudioDevice?: string;
  appliedSubtitleFont?: string;
  appliedDeinterlaceMode?: DeinterlaceMode;
  appliedPitchLock?: boolean;
  appliedAudioNormalization?: boolean;
  appliedVideoSync?: 'audio' | 'display-resample';
  appliedDesktopAudioOutput?: DesktopAudioOutputConfig;
}

/** Hooks providing the current desired settings for a `LiveSession`. */
export interface SessionSettingsHooks {
  getDesiredAudioDevice?(): string | undefined;
  getDesiredSubtitleFont?(): string | undefined;
  getDesiredSubtitleStyle?(): SubtitleStyleConfig | undefined;
  isSecondarySubtitleActive?(): boolean;
  getDesiredDeinterlaceMode?(): DeinterlaceMode | undefined;
  getDesiredPitchLock?(): boolean | undefined;
  getDesiredAudioNormalization?(): boolean | undefined;
  getDesiredDisplaySync?(): DisplaySyncPolicy | undefined;
  getDesiredDesktopAudioOutput?(): DesktopAudioOutputConfig | undefined;
  isSpdifPassthroughActive?(): boolean;
  isAudioNormalizationSuppressed?(): boolean;
}

/** Fire-and-forget initial settings application right after an mpv session connects. */
export function applySessionInitialSettings(
  L: SessionAppliedSettings,
  hooks: SessionSettingsHooks,
  sendCmd: (cmd: MpvCommand) => Promise<MpvReply | undefined>,
): void {
  const desiredAudio = hooks.getDesiredAudioDevice?.();
  if (desiredAudio !== undefined) {
    L.appliedAudioDevice = desiredAudio;
    void sendCmd(['set_property', 'audio-device', desiredAudio]);
  }
  const desiredSubFont = hooks.getDesiredSubtitleFont?.();
  if (desiredSubFont !== undefined) {
    L.appliedSubtitleFont = desiredSubFont;
    void sendCmd(['set_property', 'sub-font', desiredSubFont]);
  }
  const desiredSubStyle = hooks.getDesiredSubtitleStyle?.();
  if (desiredSubStyle !== undefined) {
    for (const cmd of subtitleStyleCommands(
      desiredSubStyle,
      hooks.isSecondarySubtitleActive?.() === true,
    )) {
      void sendCmd(cmd);
    }
  }
  const desiredDeinterlace = hooks.getDesiredDeinterlaceMode?.();
  if (desiredDeinterlace !== undefined) {
    L.appliedDeinterlaceMode = desiredDeinterlace;
    for (const cmd of deinterlaceCommands(desiredDeinterlace)) void sendCmd(cmd);
  }
  const desiredPitchLock = hooks.getDesiredPitchLock?.();
  if (desiredPitchLock !== undefined) {
    L.appliedPitchLock = desiredPitchLock;
    void sendCmd(pitchLockCommand(desiredPitchLock));
  }
  const desiredDisplaySync = hooks.getDesiredDisplaySync?.();
  if (desiredDisplaySync !== undefined) {
    L.appliedVideoSync = videoSyncModeFor(desiredDisplaySync);
    void sendCmd(videoSyncCommand(desiredDisplaySync));
  }
  const desiredDesktopAudio = hooks.getDesiredDesktopAudioOutput?.();
  if (desiredDesktopAudio !== undefined) {
    L.appliedDesktopAudioOutput = desiredDesktopAudio;
    for (const cmd of desktopAudioOutputCommands(desiredDesktopAudio)) void sendCmd(cmd);
  }
  const desiredNorm = hooks.getDesiredAudioNormalization?.();
  if (desiredNorm !== undefined) {
    const suppressed =
      hooks.isAudioNormalizationSuppressed?.() ?? hooks.isSpdifPassthroughActive?.() ?? false;
    const effectiveNorm = desiredNorm && !suppressed;
    L.appliedAudioNormalization = effectiveNorm;
    if (effectiveNorm || !desiredNorm) {
      void sendCmd(audioNormalizationCommand(effectiveNorm));
    }
  }
}

/** Reconciles desired audio/video/filter properties before sending `loadfile`. Returns `false` if superseded. */
export async function syncSlotDesiredSettings(
  L: SessionAppliedSettings,
  hooks: SessionSettingsHooks,
  sendCmd: (cmd: MpvCommand) => Promise<MpvReply | undefined>,
  stillActive: () => boolean,
): Promise<boolean> {
  const desiredAudio = hooks.getDesiredAudioDevice?.();
  if (desiredAudio !== undefined && L.appliedAudioDevice !== desiredAudio) {
    L.appliedAudioDevice = desiredAudio;
    await sendCmd(['set_property', 'audio-device', desiredAudio]);
    if (!stillActive()) return false;
  }
  const desiredSubFont = hooks.getDesiredSubtitleFont?.();
  if (desiredSubFont !== undefined && L.appliedSubtitleFont !== desiredSubFont) {
    L.appliedSubtitleFont = desiredSubFont;
    await sendCmd(['set_property', 'sub-font', desiredSubFont]);
    if (!stillActive()) return false;
  }
  const desiredDeinterlace = hooks.getDesiredDeinterlaceMode?.();
  if (
    desiredDeinterlace !== undefined &&
    (L.appliedDeinterlaceMode !== desiredDeinterlace || desiredDeinterlace !== 'off')
  ) {
    L.appliedDeinterlaceMode = desiredDeinterlace;
    for (const cmd of deinterlaceCommands(desiredDeinterlace)) {
      await sendCmd(cmd);
      if (!stillActive()) return false;
    }
  }
  const desiredPitchLock = hooks.getDesiredPitchLock?.();
  if (desiredPitchLock !== undefined && L.appliedPitchLock !== desiredPitchLock) {
    L.appliedPitchLock = desiredPitchLock;
    await sendCmd(pitchLockCommand(desiredPitchLock));
    if (!stillActive()) return false;
  }
  const desiredDisplaySync = hooks.getDesiredDisplaySync?.();
  if (desiredDisplaySync !== undefined) {
    const targetSync = videoSyncModeFor(desiredDisplaySync);
    if (L.appliedVideoSync !== targetSync) {
      L.appliedVideoSync = targetSync;
      await sendCmd(videoSyncCommand(desiredDisplaySync));
      if (!stillActive()) return false;
    }
  }
  const desiredDesktopAudio = hooks.getDesiredDesktopAudioOutput?.();
  if (
    desiredDesktopAudio !== undefined &&
    !sameDesktopAudioOutputConfig(L.appliedDesktopAudioOutput, desiredDesktopAudio)
  ) {
    L.appliedDesktopAudioOutput = desiredDesktopAudio;
    for (const cmd of desktopAudioOutputCommands(desiredDesktopAudio)) {
      await sendCmd(cmd);
      if (!stillActive()) return false;
    }
  }
  const desiredNorm = hooks.getDesiredAudioNormalization?.();
  if (desiredNorm !== undefined) {
    const suppressed =
      hooks.isAudioNormalizationSuppressed?.() ?? hooks.isSpdifPassthroughActive?.() ?? false;
    const effectiveNorm = desiredNorm && !suppressed;
    if (L.appliedAudioNormalization !== effectiveNorm) {
      L.appliedAudioNormalization = effectiveNorm;
      await sendCmd(audioNormalizationCommand(effectiveNorm));
      if (!stillActive()) return false;
    }
  }
  return true;
}

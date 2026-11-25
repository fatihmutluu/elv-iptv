import {
  AUDIO_PASSTHROUGH_CODECS,
  type AudioPassthroughCodec,
  isAudioChannelLayout,
  isAudioPassthroughCodec,
  isAutoFrameRateMode,
  isNightModeDrcPreset,
} from '@elv/domain';
import type { DesktopAudioOutputConfig, DisplaySyncPolicy } from '@elv/playback';
import { hasOnlyKeys } from './player-ipc-subtitles.ts';

const DISPLAY_SYNC_POLICY_KEYS: ReadonlySet<string> = new Set([
  'autoFrameRate',
  'autoDynamicRange',
]);

const DESKTOP_AUDIO_OUTPUT_KEYS: ReadonlySet<string> = new Set([
  'passthrough',
  'codecs',
  'exclusive',
  'ac3Encode',
  'channelLayout',
]);

/** Allowed keys on a `setDisplaySync` IPC command (`#214`, `#116`). */
export const SET_DISPLAY_SYNC_CMD_KEYS: ReadonlySet<string> = new Set(['name', 'policy']);

/** Allowed keys on a `setDesktopAudioOutput` IPC command (`#213`). */
export const SET_DESKTOP_AUDIO_OUTPUT_CMD_KEYS: ReadonlySet<string> = new Set(['name', 'config']);

const isSafeRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' &&
  x !== null &&
  !Array.isArray(x) &&
  !Object.hasOwn(x, '__proto__') &&
  !Object.hasOwn(x, 'constructor') &&
  !Object.hasOwn(x, 'prototype');

/** Main/preload runtime guard for {@link DisplaySyncPolicy} (`#214`, `#116`). */
export function isDisplaySyncPolicy(x: unknown): x is DisplaySyncPolicy {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, DISPLAY_SYNC_POLICY_KEYS)) return false;
  return isAutoFrameRateMode(x['autoFrameRate']) && typeof x['autoDynamicRange'] === 'boolean';
}

/** Main/preload runtime guard for {@link DesktopAudioOutputConfig} (`#213`). */
export function isDesktopAudioOutputConfig(x: unknown): x is DesktopAudioOutputConfig {
  if (!isSafeRecord(x) || !hasOnlyKeys(x, DESKTOP_AUDIO_OUTPUT_KEYS)) return false;
  if (
    typeof x['passthrough'] !== 'boolean' ||
    typeof x['exclusive'] !== 'boolean' ||
    typeof x['ac3Encode'] !== 'boolean' ||
    !isAudioChannelLayout(x['channelLayout'])
  ) {
    return false;
  }
  const codecs = x['codecs'];
  if (!Array.isArray(codecs) || codecs.length > AUDIO_PASSTHROUGH_CODECS.length) return false;
  const seen = new Set<AudioPassthroughCodec>();
  for (const item of codecs) {
    if (!isAudioPassthroughCodec(item) || seen.has(item)) return false;
    seen.add(item);
  }
  return true;
}

/** Main/preload runtime guard for optional Wave F7A fields on `LoadCommand.options`. */
export function hasValidWaveF7aLoadOptions(options: Record<string, unknown>): boolean {
  return (
    (options['displaySync'] === undefined || isDisplaySyncPolicy(options['displaySync'])) &&
    (options['desktopAudioOutput'] === undefined ||
      isDesktopAudioOutputConfig(options['desktopAudioOutput'])) &&
    (options['nightModeDrc'] === undefined || isNightModeDrcPreset(options['nightModeDrc']))
  );
}

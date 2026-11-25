import {
  type AudioChannelLayout,
  type AudioPassthroughCodec,
  isAudioChannelLayout,
  isAudioPassthroughCodec,
} from '@elv/domain';
import type { DesktopAudioOutputConfig } from '@elv/playback';
import type { MpvCommand } from './codec.ts';

/** Labeled mpv filter identifier for real-time AC3 encoding (`#213`). */
export const AC3_ENCODE_LABEL = '@ac3';

/** Labeled mpv audio filter for real-time 640 kbps AC3 encoding (`#213`). */
export const AC3_ENCODE_FILTER = '@ac3:lavcac3enc=yes:640:3';

const PASSTHROUGH_ERROR_LEVELS: ReadonlySet<string> = new Set(['fatal', 'error']);
const PASSTHROUGH_WARN_OR_HIGHER: ReadonlySet<string> = new Set(['fatal', 'error', 'warn']);

const AO_FAILURE_PATTERNS =
  /(?:failed|could not|cannot|unable|unsupported|in use|exclusive|spdif|passthrough|bitstream|audclnt_e_|fallback|no audio|error)/i;

const PASSTHROUGH_WARN_PATTERNS =
  /(?:audio-spdif|spdif|passthrough|exclusive mode|audio-exclusive|audclnt_e_unsupported_format|audclnt_e_exclusive_mode_not_allowed|audclnt_e_device_in_use|falling back to null|could not open\/initialize audio device|failed to initialize audio driver)/i;

/** Maps a desktop {@link AudioChannelLayout} preference to mpv's `audio-channels` property value (`#213`). */
export function mapAudioChannelLayout(layout: AudioChannelLayout): string {
  switch (layout) {
    case 'auto':
      return 'auto-safe';
    case 'stereo':
      return 'stereo';
    case '5.1':
      return '5.1';
    case '7.1':
      return '7.1';
  }
}

/** Sanitizes and deduplicates a {@link DesktopAudioOutputConfig} against the codec and layout allowlists (`#213`). */
export function normalizeDesktopAudioOutputConfig(
  config: DesktopAudioOutputConfig,
): DesktopAudioOutputConfig {
  const seen = new Set<AudioPassthroughCodec>();
  const codecs: AudioPassthroughCodec[] = [];
  for (const codec of config.codecs) {
    if (!isAudioPassthroughCodec(codec) || seen.has(codec)) continue;
    seen.add(codec);
    codecs.push(codec);
  }
  const channelLayout: AudioChannelLayout = isAudioChannelLayout(config.channelLayout)
    ? config.channelLayout
    : 'auto';
  return {
    passthrough: Boolean(config.passthrough),
    codecs,
    exclusive: Boolean(config.exclusive),
    ac3Encode: Boolean(config.ac3Encode),
    channelLayout,
  };
}

/** Returns whether two normalized {@link DesktopAudioOutputConfig} values are identical (`#213`). */
export function sameDesktopAudioOutputConfig(
  a: DesktopAudioOutputConfig | undefined,
  b: DesktopAudioOutputConfig | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (
    a.passthrough !== b.passthrough ||
    a.exclusive !== b.exclusive ||
    a.ac3Encode !== b.ac3Encode ||
    a.channelLayout !== b.channelLayout ||
    a.codecs.length !== b.codecs.length
  ) {
    return false;
  }
  for (let i = 0; i < a.codecs.length; i += 1) {
    if (a.codecs[i] !== b.codecs[i]) return false;
  }
  return true;
}

/** Returns whether real-time AC3 encoding should be active (`!passthrough && ac3Encode`, `#213`). */
export function isAc3EncodeActive(config: DesktopAudioOutputConfig | undefined): boolean {
  return config !== undefined && !config.passthrough && config.ac3Encode;
}

/**
 * Returns whether `@elv_loudnorm` must be suppressed because bitstream passthrough (`audio-spdif`)
 * or real-time AC3 re-encoding (`lavcac3enc`) is active (`#213`, `#243`).
 */
export function isLoudnormSuppressedByOutput(
  spdifObservedActive: boolean,
  config: DesktopAudioOutputConfig | undefined,
): boolean {
  if (spdifObservedActive) return true;
  if (config === undefined) return false;
  if (config.passthrough && config.codecs.length > 0) return true;
  return isAc3EncodeActive(config);
}

/**
 * Maps a {@link DesktopAudioOutputConfig} into validated mpv property and labeled `af` commands
 * without ever overwriting unrelated audio filters via `set_property af` (`#213`).
 */
export function desktopAudioOutputCommands(
  rawConfig: DesktopAudioOutputConfig,
): readonly MpvCommand[] {
  const config = normalizeDesktopAudioOutputConfig(rawConfig);
  const spdif = config.passthrough ? config.codecs.join(',') : '';
  const exclusive = config.passthrough && config.exclusive ? 'yes' : 'no';
  const channels = mapAudioChannelLayout(config.channelLayout);
  const ac3Cmd: MpvCommand = isAc3EncodeActive(config)
    ? ['af', 'add', AC3_ENCODE_FILTER]
    : ['af', 'remove', AC3_ENCODE_LABEL];
  return [
    ['set_property', 'audio-spdif', spdif],
    ['set_property', 'audio-exclusive', exclusive],
    ['set_property', 'audio-channels', channels],
    ac3Cmd,
  ];
}

/**
 * Builds the safe PCM downgrade commands emitted when AO/passthrough initialization fails,
 * re-opening the audio driver cleanly without silence (`#213`).
 */
export function passthroughFallbackCommands(): readonly MpvCommand[] {
  return [
    ['set_property', 'audio-spdif', ''],
    ['set_property', 'audio-exclusive', 'no'],
    ['af', 'remove', AC3_ENCODE_LABEL],
    ['ao-reload'],
  ];
}

/**
 * Classifies mpv `log-message` entries that indicate an audio output, S/PDIF passthrough,
 * or exclusive-mode initialization failure requiring safe PCM fallback (`#213`).
 */
export function isPassthroughAudioFailureLog(entry: {
  readonly prefix: string;
  readonly level: string;
  readonly text: string;
}): boolean {
  const level = entry.level.trim().toLowerCase();
  if (!PASSTHROUGH_WARN_OR_HIGHER.has(level)) return false;
  const prefix = entry.prefix.trim().toLowerCase();
  const text = entry.text.trim();
  if (text.length === 0) return false;

  if (prefix === 'ad/spdif' || prefix.startsWith('ad/spdif/')) {
    return PASSTHROUGH_ERROR_LEVELS.has(level) || AO_FAILURE_PATTERNS.test(text);
  }
  if (prefix === 'ao' || prefix.startsWith('ao/')) {
    if (PASSTHROUGH_ERROR_LEVELS.has(level) && AO_FAILURE_PATTERNS.test(text)) return true;
    return PASSTHROUGH_WARN_PATTERNS.test(text);
  }
  if (prefix === 'cplayer') {
    return PASSTHROUGH_WARN_PATTERNS.test(text);
  }
  return false;
}

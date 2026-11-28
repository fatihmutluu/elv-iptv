import type { LiveVariantOption } from '@elv/data';
import type { AndroidDecoderMode, SleepTimerAction } from '@elv/domain';
import {
  filterTracksByProgram,
  hasMultiplePrograms,
  type MediaTracks,
  type ProgramInfo,
  type TrackInfo,
} from '@elv/playback';
import type { AudioDeviceInfo } from '../ports/video-host';
import { SUBTITLE_STYLE_FIELDS, type SubtitleStyleField } from './subtitle-style-helpers';
import { buildSubtitleColumnEntries } from './track-picker-nav';

/** Active view inside the streamlined 2-level Player Settings hierarchy (`Wave R4`). */
export type SettingsMenuView =
  | 'root'
  | 'subtitles'
  | 'subtitleSettings'
  | 'audio'
  | 'audioSettings'
  | 'speed'
  | 'videoQuality'
  | 'quality'
  | 'sleepTimer'
  | 'advanced'
  | 'videoDecoder';

/** Focused row state for the Player Settings menu. */
export interface SettingsMenuState {
  readonly view: SettingsMenuView;
  readonly index: number;
}

/** Ordered rows shown on the root level of Player Settings (`Wave R4`). */
export type SettingsRootItem =
  | 'subtitles'
  | 'audio'
  | 'speed'
  | 'videoQuality'
  | 'quality'
  | 'aspect'
  | 'multiView'
  | 'sleepTimer'
  | 'stats'
  | 'advanced';

/** Ordered rows inside the `'advanced'` sub-view (`Wave R4`). */
type AdvancedSettingsItem =
  | 'deinterlace'
  | 'videoDecoder'
  | 'audioNormalization'
  | 'pitchLock'
  | 'autoPlayNextEpisode'
  | 'pip';

/** Stepper actions shown inside Audio/Subtitle sync delay sections (`0` = Reset, `Wave R4`). */
export const SYNC_DELAY_STEP_ACTIONS = [-500, -100, 0, 100, 500] as const;

/** Index of the `Reset (0 ms)` action in {@link SYNC_DELAY_STEP_ACTIONS}. */
export const SYNC_DELAY_RESET_INDEX = 2;

/** Formats a sync delay offset in milliseconds (`0 ms`, `+100 ms`, `-500 ms`). */
export function formatSyncDelayMs(delayMs: number): string {
  const safe = Number.isFinite(delayMs) ? Math.round(delayMs) : 0;
  if (safe === 0) return '0 ms';
  return safe > 0 ? `+${safe} ms` : `${safe} ms`;
}

/** Supported VOD playback speed multipliers (`0.5×` through `2×`). */
export const PLAYBACK_SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Formats a playback speed multiplier as a compact tabular badge (e.g. `1×`, `1.25×`). */
export function formatPlaybackSpeed(rate: number): string {
  return `${rate}×`;
}

/** Returns OS audio output devices excluding the implicit `'auto'` entry (which is always row 0). */
export function normalizeAudioDeviceChoices(
  devices: readonly AudioDeviceInfo[] | undefined,
): readonly AudioDeviceInfo[] {
  if (!devices || devices.length === 0) return [];
  const seen = new Set<string>();
  const out: AudioDeviceInfo[] = [];
  for (const device of devices) {
    const name = device.name.trim();
    if (name === '' || name === 'auto' || seen.has(name)) continue;
    seen.add(name);
    out.push(device);
  }
  return out;
}

/** Canonical baseline top-to-bottom order of root Player Settings rows for Live streams. */
export const SETTINGS_ROOT_ITEMS: readonly SettingsRootItem[] = [
  'subtitles',
  'audio',
  'aspect',
  'stats',
];

/** Optional capability and runtime state context passed to Player Settings navigation helpers. */
export interface SettingsMenuOptions {
  readonly isVod?: boolean;
  readonly playbackSpeed?: number;
  readonly hasAspect?: boolean;
  readonly hasDeinterlace?: boolean;
  readonly hasPitchLock?: boolean;
  readonly hasAudioNormalization?: boolean;
  readonly hasAutoPlayNextEpisode?: boolean;
  readonly hasAudioDevice?: boolean;
  readonly audioDevices?: readonly AudioDeviceInfo[];
  readonly activeAudioDevice?: string;
  readonly hasAudioDelay?: boolean;
  readonly audioDelayMs?: number;
  readonly hasSubtitleDelay?: boolean;
  readonly subtitleDelayMs?: number;
  readonly hasSubtitleStyle?: boolean;
  readonly hasDualSubtitles?: boolean;
  readonly canPickSubtitleFile?: boolean;
  readonly canLoadSubtitleUrl?: boolean;
  readonly hasVideoQuality?: boolean;
  readonly selectedVideoQualityId?: string | null;
  readonly hasQuality?: boolean;
  readonly qualityVariants?: readonly LiveVariantOption[];
  readonly activeQualityKey?: string;
  readonly hasVideoDecoder?: boolean;
  readonly androidDecoderMode?: AndroidDecoderMode;
  readonly hasSleepTimer?: boolean;
  readonly sleepTimerMinutes?: number;
  readonly sleepTimerAction?: SleepTimerAction;
  readonly hasPip?: boolean;
  readonly hasMultiView?: boolean;
}

/** Ordered row descriptor inside the level-1 `'subtitles'` view. */
type SubtitleMenuEntry =
  | { readonly kind: 'primaryOff' }
  | { readonly kind: 'primaryTrack'; readonly track: TrackInfo; readonly trackIndex: number }
  | { readonly kind: 'openSubtitleSettings' };

/** Ordered focusable row descriptor inside the level-2 `'subtitleSettings'` view. */
type SubtitleSettingsEntry =
  | { readonly kind: 'delayStep'; readonly step: number }
  | { readonly kind: 'styleField'; readonly field: SubtitleStyleField }
  | { readonly kind: 'styleReset' }
  | { readonly kind: 'secondaryOff' }
  | {
      readonly kind: 'secondaryTrack';
      readonly track: TrackInfo;
      readonly trackIndex: number;
      readonly disabled: boolean;
    }
  | { readonly kind: 'pickSubtitleFile' }
  | { readonly kind: 'loadSubtitleUrl' };

/** Ordered row descriptor inside the level-1 `'audio'` view. */
type AudioMenuEntry =
  | { readonly kind: 'program'; readonly program: ProgramInfo; readonly programIndex: number }
  | { readonly kind: 'audio'; readonly track: TrackInfo; readonly trackIndex: number }
  | { readonly kind: 'openAudioSettings' };

/** Ordered focusable row descriptor inside the level-2 `'audioSettings'` view. */
export type AudioSettingsEntry =
  | { readonly kind: 'delayStep'; readonly step: number }
  | { readonly kind: 'deviceAuto' }
  | { readonly kind: 'device'; readonly device: AudioDeviceInfo; readonly deviceIndex: number }
  | { readonly kind: 'audioNormalization' }
  | { readonly kind: 'pitchLock' };

/** Result of routing a KeyEvent while Player Settings is open. */
export type SettingsMenuIntent =
  | { readonly kind: 'state'; readonly state: SettingsMenuState }
  | { readonly kind: 'close' }
  | { readonly kind: 'toggleResizeMode' }
  | { readonly kind: 'toggleDeinterlace' }
  | { readonly kind: 'togglePitchLock' }
  | { readonly kind: 'toggleAudioNormalization' }
  | { readonly kind: 'toggleAutoPlayNextEpisode' }
  | { readonly kind: 'enterPip' }
  | { readonly kind: 'enterMultiView' }
  | { readonly kind: 'toggleStats' }
  | { readonly kind: 'program'; readonly id: string }
  | { readonly kind: 'audio'; readonly id: string }
  | { readonly kind: 'audioDelay'; readonly deltaMs: number; readonly reset?: boolean }
  | { readonly kind: 'subtitleDelay'; readonly deltaMs: number; readonly reset?: boolean }
  | { readonly kind: 'audioDevice'; readonly name: string }
  | { readonly kind: 'videoQuality'; readonly id: string | null }
  | { readonly kind: 'quality'; readonly itemKey: string }
  | { readonly kind: 'subtitle'; readonly id: string | null }
  | { readonly kind: 'secondarySubtitle'; readonly id: string | null }
  | { readonly kind: 'pickSubtitleFile' }
  | { readonly kind: 'loadSubtitleUrl' }
  | {
      readonly kind: 'stepSubtitleStyle';
      readonly field: SubtitleStyleField;
      readonly delta: -1 | 1;
    }
  | { readonly kind: 'resetSubtitleStyle' }
  | { readonly kind: 'speed'; readonly rate: number }
  | { readonly kind: 'sleepTimer'; readonly minutes: number }
  | { readonly kind: 'toggleSleepTimerAction' }
  | { readonly kind: 'videoDecoder'; readonly mode: AndroidDecoderMode };

/** @internal Resolves programme-scoped track lists when multiple MPEG-TS programs exist. */
export function effectiveTracksForView(tracks: MediaTracks): MediaTracks {
  return hasMultiplePrograms(tracks) ? filterTracksByProgram(tracks) : tracks;
}

/** @internal True only when at least 2 decoded video quality tiers are selectable. */
export function showVideoQualityItem(tracks: MediaTracks, options?: SettingsMenuOptions): boolean {
  return options?.hasVideoQuality === true && (tracks.videoQualities?.length ?? 0) > 1;
}

/** @internal True only when at least 2 live channel variants are selectable. */
export function showLiveQualityItem(options?: SettingsMenuOptions): boolean {
  return (
    options?.isVod !== true &&
    options?.hasQuality === true &&
    (options.qualityVariants?.length ?? 0) > 1
  );
}

/** Returns whether any second-level `'subtitleSettings'` option is active for the current target. */
export function hasSubtitleSettingsView(
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): boolean {
  const effective = effectiveTracksForView(tracks);
  return (
    options?.hasSubtitleDelay === true ||
    options?.hasSubtitleStyle === true ||
    (options?.hasDualSubtitles === true && effective.subtitles.length >= 1) ||
    options?.canPickSubtitleFile === true ||
    options?.canLoadSubtitleUrl === true
  );
}

/** Returns whether any second-level `'audioSettings'` option is active for the current target. */
export function hasAudioSettingsView(options?: SettingsMenuOptions): boolean {
  return (
    options?.hasAudioDelay === true ||
    options?.hasAudioDevice === true ||
    options?.hasAudioNormalization === true ||
    (options?.isVod === true && options?.hasPitchLock === true)
  );
}

/** Builds ordered items for the `'advanced'` sub-view. */
export function advancedSettingsItems(
  options?: SettingsMenuOptions,
): readonly AdvancedSettingsItem[] {
  const isVod = options?.isVod === true;
  const items: AdvancedSettingsItem[] = [];
  if (options?.hasDeinterlace === true) items.push('deinterlace');
  if (options?.hasVideoDecoder === true) items.push('videoDecoder');
  if (options?.hasAudioNormalization === true) items.push('audioNormalization');
  if (isVod && options?.hasPitchLock === true) items.push('pitchLock');
  if (isVod && options?.hasAutoPlayNextEpisode === true) items.push('autoPlayNextEpisode');
  if (options?.hasPip === true) items.push('pip');
  return items;
}

/** Builds ordered level-1 `'subtitles'` rows (primary tracks + trailing `Subtitle settings` link). */
export function subtitleMenuEntries(
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): readonly SubtitleMenuEntry[] {
  const effective = effectiveTracksForView(tracks);
  const out: SubtitleMenuEntry[] = [{ kind: 'primaryOff' }];
  effective.subtitles.forEach((track, trackIndex) => {
    out.push({ kind: 'primaryTrack', track, trackIndex });
  });
  if (hasSubtitleSettingsView(tracks, options)) {
    out.push({ kind: 'openSubtitleSettings' });
  }
  return out;
}

/** Builds ordered level-2 `'subtitleSettings'` rows (delay, style, dual subtitles, external subs). */
export function subtitleSettingsMenuEntries(
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): readonly SubtitleSettingsEntry[] {
  const out: SubtitleSettingsEntry[] = [];
  if (options?.hasSubtitleDelay === true) {
    for (const step of SYNC_DELAY_STEP_ACTIONS) {
      out.push({ kind: 'delayStep', step });
    }
  }
  if (options?.hasSubtitleStyle === true) {
    for (const field of SUBTITLE_STYLE_FIELDS) {
      out.push({ kind: 'styleField', field });
    }
    out.push({ kind: 'styleReset' });
  }
  const effective = effectiveTracksForView(tracks);
  const col = buildSubtitleColumnEntries(effective, {
    dualSubtitles: options?.hasDualSubtitles === true,
    canPickSubtitleFile: options?.canPickSubtitleFile === true,
    canLoadSubtitleUrl: options?.canLoadSubtitleUrl === true,
  });
  for (const entry of col) {
    if (entry.kind === 'primaryOff' || entry.kind === 'primaryTrack') continue;
    out.push(entry);
  }
  return out;
}

/** Builds ordered level-1 `'audio'` rows (optional MPEG-TS programs, audio tracks, `Audio settings`). */
export function audioMenuEntries(
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): readonly AudioMenuEntry[] {
  const out: AudioMenuEntry[] = [];
  if (hasMultiplePrograms(tracks)) {
    (tracks.programs ?? []).forEach((program, programIndex) => {
      out.push({ kind: 'program', program, programIndex });
    });
  }
  const effective = effectiveTracksForView(tracks);
  effective.audio.forEach((track, trackIndex) => {
    out.push({ kind: 'audio', track, trackIndex });
  });
  if (hasAudioSettingsView(options)) {
    out.push({ kind: 'openAudioSettings' });
  }
  return out;
}

/** Builds ordered level-2 `'audioSettings'` rows (delay, output device, normalization, VOD pitch lock). */
export function audioSettingsMenuEntries(
  options?: SettingsMenuOptions,
): readonly AudioSettingsEntry[] {
  const out: AudioSettingsEntry[] = [];
  if (options?.hasAudioDelay === true) {
    for (const step of SYNC_DELAY_STEP_ACTIONS) {
      out.push({ kind: 'delayStep', step });
    }
  }
  if (options?.hasAudioDevice === true) {
    out.push({ kind: 'deviceAuto' });
    normalizeAudioDeviceChoices(options.audioDevices).forEach((device, deviceIndex) => {
      out.push({ kind: 'device', device, deviceIndex });
    });
  }
  if (options?.hasAudioNormalization === true) {
    out.push({ kind: 'audioNormalization' });
  }
  if (options?.isVod === true && options?.hasPitchLock === true) {
    out.push({ kind: 'pitchLock' });
  }
  return out;
}

/** Builds streamlined top-level Player Settings rows (`Wave R4`). */
export function settingsRootItemsFromOptions(
  options?: SettingsMenuOptions,
  tracks?: MediaTracks,
): readonly SettingsRootItem[] {
  const isVod = options?.isVod === true;
  const items: SettingsRootItem[] = ['subtitles', 'audio'];
  if (isVod) items.push('speed');
  if (
    tracks !== undefined ? showVideoQualityItem(tracks, options) : options?.hasVideoQuality === true
  ) {
    items.push('videoQuality');
  }
  if (showLiveQualityItem(options)) {
    items.push('quality');
  }
  if (options?.hasAspect !== false) items.push('aspect');
  if (options?.hasMultiView === true) items.push('multiView');
  if (options?.hasSleepTimer === true) items.push('sleepTimer');
  items.push('stats');
  if (advancedSettingsItems(options).length > 0) items.push('advanced');
  return items;
}

import type { LiveVariantOption } from '@elv/data';
import { ANDROID_DECODER_MODES, type AndroidDecoderMode, type SleepTimerAction } from '@elv/domain';
import type { KeyEvent } from '@elv/focus-core';
import type { ChapterInfo, MediaTracks } from '@elv/playback';
import type { AudioDeviceInfo } from '../ports/video-host';
import { SLEEP_TIMER_PRESETS_MIN } from './sleep-timer';

/** Active level inside the 2-level Player Settings menu (`root` or a sub-view). */
export type SettingsMenuView =
  | 'root'
  | 'subtitles'
  | 'audio'
  | 'audioDevice'
  | 'quality'
  | 'speed'
  | 'chapters'
  | 'sleepTimer'
  | 'videoDecoder';

/** Focused row state for the 2-level Player Settings menu. */
export interface SettingsMenuState {
  readonly view: SettingsMenuView;
  readonly index: number;
}

/** Ordered rows shown on the root level of the Player Settings menu. */
export type SettingsRootItem =
  | 'subtitles'
  | 'audio'
  | 'audioDevice'
  | 'quality'
  | 'speed'
  | 'chapters'
  | 'sleepTimer'
  | 'videoDecoder'
  | 'aspect'
  | 'timeDisplay'
  | 'info'
  | 'alwaysOnTop'
  | 'deinterlace'
  | 'autoSubtitlesOnSkipBack'
  | 'autoPlayNextEpisode'
  | 'stats';

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

/** Canonical top-to-bottom order of root Player Settings rows for Live streams. */
export const SETTINGS_ROOT_ITEMS: readonly SettingsRootItem[] = [
  'subtitles',
  'audio',
  'aspect',
  'stats',
];

/** Optional VOD, chapter, sleep-timer, and display context passed to Player Settings navigation helpers. */
export interface SettingsMenuOptions {
  readonly isVod?: boolean;
  readonly playbackSpeed?: number;
  readonly hasAspect?: boolean;
  readonly hasDeinterlace?: boolean;
  readonly hasAutoSubtitlesOnSkipBack?: boolean;
  readonly hasAutoPlayNextEpisode?: boolean;
  readonly hasAudioDevice?: boolean;
  readonly audioDevices?: readonly AudioDeviceInfo[];
  readonly activeAudioDevice?: string;
  readonly hasQuality?: boolean;
  readonly qualityVariants?: readonly LiveVariantOption[];
  readonly activeQualityKey?: string;
  readonly hasVideoDecoder?: boolean;
  readonly androidDecoderMode?: AndroidDecoderMode;
  readonly hasChapters?: boolean;
  readonly chapters?: readonly ChapterInfo[];
  readonly hasSleepTimer?: boolean;
  readonly sleepTimerMinutes?: number;
  readonly sleepTimerAction?: SleepTimerAction;
  readonly hasTimeDisplay?: boolean;
  readonly hasInfo?: boolean;
  readonly hasAlwaysOnTop?: boolean;
}

/** Builds ordered root Player Settings rows from a {@link SettingsMenuOptions} bag. */
function settingsRootItemsFromOptions(options?: SettingsMenuOptions): readonly SettingsRootItem[] {
  const items: SettingsRootItem[] = ['subtitles', 'audio'];
  if (options?.hasAudioDevice === true) items.push('audioDevice');
  if (options?.hasQuality === true && (options.qualityVariants?.length ?? 0) > 1) {
    items.push('quality');
  }
  if (options?.isVod === true) items.push('speed');
  if (options?.hasChapters === true && (options.chapters?.length ?? 0) > 0) items.push('chapters');
  if (options?.hasSleepTimer === true) items.push('sleepTimer');
  if (options?.hasVideoDecoder === true) items.push('videoDecoder');
  if (options?.hasAspect !== false) items.push('aspect');
  if (options?.hasTimeDisplay === true) items.push('timeDisplay');
  if (options?.hasInfo === true) items.push('info');
  if (options?.hasAlwaysOnTop === true) items.push('alwaysOnTop');
  if (options?.hasDeinterlace === true) items.push('deinterlace');
  if (options?.hasAutoSubtitlesOnSkipBack === true) items.push('autoSubtitlesOnSkipBack');
  if (options?.hasAutoPlayNextEpisode === true) items.push('autoPlayNextEpisode');
  items.push('stats');
  return items;
}

/** Returns the ordered root Player Settings rows for the active stream kind and host capabilities. */
export function settingsRootItems(
  isVod: boolean,
  hasAspect = true,
  hasDeinterlace = false,
  hasAutoSubtitlesOnSkipBack = false,
  hasAutoPlayNextEpisode = false,
  hasAudioDevice = false,
  hasVideoDecoder = false,
): readonly SettingsRootItem[] {
  return settingsRootItemsFromOptions({
    isVod,
    hasAspect,
    hasDeinterlace,
    hasAutoSubtitlesOnSkipBack,
    hasAutoPlayNextEpisode,
    hasAudioDevice,
    hasVideoDecoder,
  });
}

/** Result of routing a {@link KeyEvent} while the Player Settings menu is open. */
export type SettingsMenuIntent =
  | { readonly kind: 'state'; readonly state: SettingsMenuState }
  | { readonly kind: 'close' }
  | { readonly kind: 'toggleResizeMode' }
  | { readonly kind: 'toggleTimeDisplayMode' }
  | { readonly kind: 'toggleInfo' }
  | { readonly kind: 'toggleAlwaysOnTop' }
  | { readonly kind: 'toggleDeinterlace' }
  | { readonly kind: 'toggleAutoSubtitlesOnSkipBack' }
  | { readonly kind: 'toggleAutoPlayNextEpisode' }
  | { readonly kind: 'toggleStats' }
  | { readonly kind: 'audio'; readonly id: string }
  | { readonly kind: 'audioDevice'; readonly name: string }
  | { readonly kind: 'quality'; readonly itemKey: string }
  | { readonly kind: 'subtitle'; readonly id: string | null }
  | { readonly kind: 'speed'; readonly rate: number }
  | { readonly kind: 'chapter'; readonly startMs: number }
  | { readonly kind: 'sleepTimer'; readonly minutes: number }
  | { readonly kind: 'toggleSleepTimerAction' }
  | { readonly kind: 'videoDecoder'; readonly mode: AndroidDecoderMode };

function selectedAudioIndex(tracks: MediaTracks): number {
  return Math.max(
    0,
    tracks.audio.findIndex((t) => t.id === tracks.selectedAudioId),
  );
}

function selectedAudioDeviceIndex(
  devices: readonly AudioDeviceInfo[] | undefined,
  activeAudioDevice: string | undefined,
): number {
  if (!activeAudioDevice || activeAudioDevice === 'auto') return 0;
  const idx = normalizeAudioDeviceChoices(devices).findIndex((d) => d.name === activeAudioDevice);
  return idx >= 0 ? idx + 1 : 0;
}

function selectedSubtitleIndex(tracks: MediaTracks): number {
  return tracks.subtitles.findIndex((t) => t.id === tracks.selectedSubtitleId) + 1;
}

function selectedSpeedIndex(playbackSpeed: number | undefined): number {
  const rate = playbackSpeed ?? 1;
  const idx = PLAYBACK_SPEED_OPTIONS.indexOf(rate as (typeof PLAYBACK_SPEED_OPTIONS)[number]);
  return idx >= 0 ? idx : PLAYBACK_SPEED_OPTIONS.indexOf(1);
}

function selectedVideoDecoderIndex(mode: AndroidDecoderMode | undefined): number {
  return Math.max(ANDROID_DECODER_MODES.indexOf(mode ?? 'auto'), 0);
}

function selectedSleepTimerIndex(minutes: number | undefined): number {
  const idx = SLEEP_TIMER_PRESETS_MIN.indexOf(
    (minutes ?? 0) as (typeof SLEEP_TIMER_PRESETS_MIN)[number],
  );
  // Row 0 is the action toggle (Stop vs Pause); presets start at index 1
  return idx >= 0 ? idx + 1 : 1;
}

function selectedQualityIndex(
  variants: readonly LiveVariantOption[] | undefined,
  activeKey: string | undefined,
): number {
  if (!variants || variants.length === 0 || !activeKey) return 0;
  return Math.max(
    0,
    variants.findIndex((v) => v.key === activeKey),
  );
}

/** Creates the initial focused state for the given Settings menu view (`root` by default). */
export function initialSettingsMenu(
  view: SettingsMenuView = 'root',
  options?: SettingsMenuOptions,
): SettingsMenuState {
  if (view === 'speed' && options?.playbackSpeed !== undefined) {
    return { view, index: selectedSpeedIndex(options.playbackSpeed) };
  }
  if (view === 'quality') {
    return {
      view,
      index: selectedQualityIndex(options?.qualityVariants, options?.activeQualityKey),
    };
  }
  if (view === 'audioDevice') {
    return {
      view,
      index: selectedAudioDeviceIndex(options?.audioDevices, options?.activeAudioDevice),
    };
  }
  if (view === 'videoDecoder') {
    return { view, index: selectedVideoDecoderIndex(options?.androidDecoderMode) };
  }
  if (view === 'sleepTimer') {
    return { view, index: selectedSleepTimerIndex(options?.sleepTimerMinutes) };
  }
  return { view, index: 0 };
}

/** Number of focusable rows in `view`. */
export function settingsRowCount(
  view: SettingsMenuView,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): number {
  if (view === 'root') return settingsRootItemsFromOptions(options).length;
  if (view === 'subtitles') return tracks.subtitles.length + 1;
  if (view === 'audioDevice') {
    return options?.hasAudioDevice === true
      ? normalizeAudioDeviceChoices(options?.audioDevices).length + 1
      : 0;
  }
  if (view === 'quality') {
    return options?.hasQuality === true ? (options.qualityVariants?.length ?? 0) : 0;
  }
  if (view === 'speed') return options?.isVod === true ? PLAYBACK_SPEED_OPTIONS.length : 0;
  if (view === 'chapters')
    return options?.hasChapters === true ? (options.chapters?.length ?? 0) : 0;
  if (view === 'sleepTimer') {
    return options?.hasSleepTimer === true ? SLEEP_TIMER_PRESETS_MIN.length + 1 : 0;
  }
  if (view === 'videoDecoder') {
    return options?.hasVideoDecoder === true ? ANDROID_DECODER_MODES.length : 0;
  }
  return tracks.audio.length;
}

/** Keeps `state` and `state.index` within valid bounds, returning `state` unchanged when valid. */
export function clampSettingsMenu(
  state: SettingsMenuState,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuState {
  if (state.view === 'speed' && options?.isVod !== true) return { view: 'root', index: 0 };
  if (state.view === 'audioDevice' && options?.hasAudioDevice !== true) {
    return { view: 'root', index: 0 };
  }
  if (
    state.view === 'quality' &&
    (options?.hasQuality !== true || (options.qualityVariants?.length ?? 0) <= 1)
  ) {
    return { view: 'root', index: 0 };
  }
  if (
    state.view === 'chapters' &&
    (options?.hasChapters !== true || (options.chapters?.length ?? 0) === 0)
  ) {
    return { view: 'root', index: 0 };
  }
  if (state.view === 'sleepTimer' && options?.hasSleepTimer !== true) {
    return { view: 'root', index: 0 };
  }
  if (state.view === 'videoDecoder' && options?.hasVideoDecoder !== true) {
    return { view: 'root', index: 0 };
  }
  const count = settingsRowCount(state.view, tracks, options);
  const index = Math.max(0, Math.min(Math.max(0, count - 1), state.index));
  return index === state.index ? state : { view: state.view, index };
}

/** Returns the root-level row index corresponding to `view` using an options bag. */
export function rootIndexForSettingsViewOptions(
  view: Exclude<SettingsMenuView, 'root'>,
  options?: SettingsMenuOptions,
): number {
  return Math.max(settingsRootItemsFromOptions(options).indexOf(view), 0);
}

/** Returns the root-level row index corresponding to `view`. */
export function rootIndexForSettingsView(
  view: Exclude<SettingsMenuView, 'root'>,
  isVod: boolean,
  hasAspect = true,
  hasDeinterlace = false,
  hasAutoSubtitlesOnSkipBack = false,
  hasAutoPlayNextEpisode = false,
  hasAudioDevice = false,
  hasVideoDecoder = false,
): number {
  return rootIndexForSettingsViewOptions(view, {
    isVod,
    hasAspect,
    hasDeinterlace,
    hasAutoSubtitlesOnSkipBack,
    hasAutoPlayNextEpisode,
    hasAudioDevice,
    hasVideoDecoder,
  });
}

function openSubView(
  item: SettingsRootItem,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  if (item === 'subtitles') {
    return { kind: 'state', state: { view: 'subtitles', index: selectedSubtitleIndex(tracks) } };
  }
  if (item === 'audio') {
    return { kind: 'state', state: { view: 'audio', index: selectedAudioIndex(tracks) } };
  }
  if (item === 'audioDevice' && options?.hasAudioDevice === true) {
    return {
      kind: 'state',
      state: {
        view: 'audioDevice',
        index: selectedAudioDeviceIndex(options.audioDevices, options.activeAudioDevice),
      },
    };
  }
  if (
    item === 'quality' &&
    options?.hasQuality === true &&
    (options.qualityVariants?.length ?? 0) > 1
  ) {
    return {
      kind: 'state',
      state: {
        view: 'quality',
        index: selectedQualityIndex(options.qualityVariants, options.activeQualityKey),
      },
    };
  }
  if (item === 'speed' && options?.isVod === true) {
    return {
      kind: 'state',
      state: { view: 'speed', index: selectedSpeedIndex(options.playbackSpeed) },
    };
  }
  if (item === 'chapters' && options?.hasChapters === true && (options.chapters?.length ?? 0) > 0) {
    return { kind: 'state', state: { view: 'chapters', index: 0 } };
  }
  if (item === 'sleepTimer' && options?.hasSleepTimer === true) {
    return {
      kind: 'state',
      state: { view: 'sleepTimer', index: selectedSleepTimerIndex(options.sleepTimerMinutes) },
    };
  }
  if (item === 'videoDecoder' && options?.hasVideoDecoder === true) {
    return {
      kind: 'state',
      state: { view: 'videoDecoder', index: selectedVideoDecoderIndex(options.androidDecoderMode) },
    };
  }
  return null;
}

/** Routes a key event while the 2-level Player Settings menu is open. */
export function routeSettingsMenuKey(
  event: KeyEvent,
  state: SettingsMenuState,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuIntent | null {
  const rootItems = settingsRootItemsFromOptions(options);
  const cur = clampSettingsMenu(state, tracks, options);

  if (event.kind === 'press' && event.key === 'back') {
    return cur.view === 'root'
      ? { kind: 'close' }
      : {
          kind: 'state',
          state: { view: 'root', index: rootIndexForSettingsViewOptions(cur.view, options) },
        };
  }

  if (
    (event.kind === 'press' || event.kind === 'repeat') &&
    (event.key === 'up' || event.key === 'down')
  ) {
    const delta = event.key === 'down' ? 1 : -1;
    return {
      kind: 'state',
      state: clampSettingsMenu({ view: cur.view, index: cur.index + delta }, tracks, options),
    };
  }

  if (event.kind === 'press' && event.key === 'left') {
    return cur.view === 'root'
      ? null
      : {
          kind: 'state',
          state: { view: 'root', index: rootIndexForSettingsViewOptions(cur.view, options) },
        };
  }

  if (event.kind === 'press' && event.key === 'right') {
    if (cur.view !== 'root') return null;
    const item = rootItems[cur.index];
    return item !== undefined ? openSubView(item, tracks, options) : null;
  }

  if (event.kind === 'press' && event.key === 'select') {
    if (cur.view === 'root') {
      const item = rootItems[cur.index];
      if (item === 'aspect') return { kind: 'toggleResizeMode' };
      if (item === 'timeDisplay') return { kind: 'toggleTimeDisplayMode' };
      if (item === 'info') return { kind: 'toggleInfo' };
      if (item === 'alwaysOnTop') return { kind: 'toggleAlwaysOnTop' };
      if (item === 'deinterlace') return { kind: 'toggleDeinterlace' };
      if (item === 'autoSubtitlesOnSkipBack') return { kind: 'toggleAutoSubtitlesOnSkipBack' };
      if (item === 'autoPlayNextEpisode') return { kind: 'toggleAutoPlayNextEpisode' };
      if (item === 'stats') return { kind: 'toggleStats' };
      return item !== undefined ? openSubView(item, tracks, options) : null;
    }
    if (cur.view === 'subtitles') {
      if (cur.index === 0) return { kind: 'subtitle', id: null };
      const track = tracks.subtitles[cur.index - 1];
      return track !== undefined ? { kind: 'subtitle', id: track.id } : null;
    }
    if (cur.view === 'audioDevice') {
      if (cur.index === 0) return { kind: 'audioDevice', name: 'auto' };
      const device = normalizeAudioDeviceChoices(options?.audioDevices)[cur.index - 1];
      return device !== undefined ? { kind: 'audioDevice', name: device.name } : null;
    }
    if (cur.view === 'quality') {
      const variant = options?.qualityVariants?.[cur.index];
      return variant !== undefined ? { kind: 'quality', itemKey: variant.key } : null;
    }
    if (cur.view === 'speed') {
      const rate = PLAYBACK_SPEED_OPTIONS[cur.index];
      return rate !== undefined ? { kind: 'speed', rate } : null;
    }
    if (cur.view === 'chapters') {
      const ch = options?.chapters?.[cur.index];
      return ch !== undefined ? { kind: 'chapter', startMs: ch.startMs } : null;
    }
    if (cur.view === 'sleepTimer') {
      if (cur.index === 0) return { kind: 'toggleSleepTimerAction' };
      const minutes = SLEEP_TIMER_PRESETS_MIN[cur.index - 1];
      return minutes !== undefined ? { kind: 'sleepTimer', minutes } : null;
    }
    if (cur.view === 'videoDecoder') {
      const mode = ANDROID_DECODER_MODES[cur.index];
      return mode !== undefined ? { kind: 'videoDecoder', mode } : null;
    }
    const track = tracks.audio[cur.index];
    return track !== undefined ? { kind: 'audio', id: track.id } : null;
  }

  return null;
}

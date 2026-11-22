import type { KeyEvent } from '@elv/focus-core';
import type { MediaTracks } from '@elv/playback';
import type { AudioDeviceInfo } from '../ports/video-host';

/** Active level inside the 2-level Player Settings menu (`root` or a sub-view). */
export type SettingsMenuView = 'root' | 'subtitles' | 'audio' | 'audioDevice' | 'speed';

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
  | 'speed'
  | 'aspect'
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

/** Returns the ordered root Player Settings rows for the active stream kind and host capabilities. */
export function settingsRootItems(
  isVod: boolean,
  hasAspect = true,
  hasDeinterlace = false,
  hasAutoSubtitlesOnSkipBack = false,
  hasAutoPlayNextEpisode = false,
  hasAudioDevice = false,
): readonly SettingsRootItem[] {
  const items: SettingsRootItem[] = ['subtitles', 'audio'];
  if (hasAudioDevice) items.push('audioDevice');
  if (isVod) items.push('speed');
  if (hasAspect) items.push('aspect');
  if (hasDeinterlace) items.push('deinterlace');
  if (hasAutoSubtitlesOnSkipBack) items.push('autoSubtitlesOnSkipBack');
  if (hasAutoPlayNextEpisode) items.push('autoPlayNextEpisode');
  items.push('stats');
  return items;
}

/** Optional VOD and display context passed to Player Settings navigation helpers. */
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
}

/** Result of routing a {@link KeyEvent} while the Player Settings menu is open. */
export type SettingsMenuIntent =
  | { readonly kind: 'state'; readonly state: SettingsMenuState }
  | { readonly kind: 'close' }
  | { readonly kind: 'toggleResizeMode' }
  | { readonly kind: 'toggleDeinterlace' }
  | { readonly kind: 'toggleAutoSubtitlesOnSkipBack' }
  | { readonly kind: 'toggleAutoPlayNextEpisode' }
  | { readonly kind: 'toggleStats' }
  | { readonly kind: 'audio'; readonly id: string }
  | { readonly kind: 'audioDevice'; readonly name: string }
  | { readonly kind: 'subtitle'; readonly id: string | null }
  | { readonly kind: 'speed'; readonly rate: number };

/** Creates the initial focused state for the given Settings menu view (`root` by default). */
export function initialSettingsMenu(
  view: SettingsMenuView = 'root',
  options?: SettingsMenuOptions,
): SettingsMenuState {
  if (view === 'speed' && options?.playbackSpeed !== undefined) {
    return { view, index: selectedSpeedIndex(options.playbackSpeed) };
  }
  if (view === 'audioDevice') {
    return {
      view,
      index: selectedAudioDeviceIndex(options?.audioDevices, options?.activeAudioDevice),
    };
  }
  return { view, index: 0 };
}

/** Number of focusable rows in `view` (`subtitles` includes row 0 for "Off", `audioDevice` includes row 0 for "System default"). */
export function settingsRowCount(
  view: SettingsMenuView,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): number {
  if (view === 'root') {
    return settingsRootItems(
      options?.isVod === true,
      options?.hasAspect !== false,
      options?.hasDeinterlace === true,
      options?.hasAutoSubtitlesOnSkipBack === true,
      options?.hasAutoPlayNextEpisode === true,
      options?.hasAudioDevice === true,
    ).length;
  }
  if (view === 'subtitles') return tracks.subtitles.length + 1;
  if (view === 'audioDevice') {
    return options?.hasAudioDevice === true
      ? normalizeAudioDeviceChoices(options?.audioDevices).length + 1
      : 0;
  }
  if (view === 'speed') return options?.isVod === true ? PLAYBACK_SPEED_OPTIONS.length : 0;
  return tracks.audio.length;
}

/** Keeps `state` and `state.index` within valid bounds, returning `state` unchanged when valid. */
export function clampSettingsMenu(
  state: SettingsMenuState,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): SettingsMenuState {
  const isVod = options?.isVod === true;
  if (state.view === 'speed' && !isVod) return { view: 'root', index: 0 };
  if (state.view === 'audioDevice' && options?.hasAudioDevice !== true) {
    return { view: 'root', index: 0 };
  }
  const count = settingsRowCount(state.view, tracks, options);
  const max = Math.max(0, count - 1);
  const index = Math.max(0, Math.min(max, state.index));
  return index === state.index ? state : { view: state.view, index };
}

function selectedAudioIndex(tracks: MediaTracks): number {
  const idx = tracks.audio.findIndex((t) => t.id === tracks.selectedAudioId);
  return Math.max(0, idx);
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
  const idx = tracks.subtitles.findIndex((t) => t.id === tracks.selectedSubtitleId);
  return idx + 1;
}

function selectedSpeedIndex(playbackSpeed: number | undefined): number {
  const rate = playbackSpeed ?? 1;
  const idx = PLAYBACK_SPEED_OPTIONS.indexOf(rate as (typeof PLAYBACK_SPEED_OPTIONS)[number]);
  return idx >= 0 ? idx : PLAYBACK_SPEED_OPTIONS.indexOf(1);
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
): number {
  const idx = settingsRootItems(
    isVod,
    hasAspect,
    hasDeinterlace,
    hasAutoSubtitlesOnSkipBack,
    hasAutoPlayNextEpisode,
    hasAudioDevice,
  ).indexOf(view);
  return Math.max(idx, 0);
}

function returnToRoot(
  view: Exclude<SettingsMenuView, 'root'>,
  isVod: boolean,
  hasAspect: boolean,
  hasDeinterlace: boolean,
  hasAutoSubtitlesOnSkipBack: boolean,
  hasAutoPlayNextEpisode: boolean,
  hasAudioDevice: boolean,
): SettingsMenuIntent {
  return {
    kind: 'state',
    state: {
      view: 'root',
      index: rootIndexForSettingsView(
        view,
        isVod,
        hasAspect,
        hasDeinterlace,
        hasAutoSubtitlesOnSkipBack,
        hasAutoPlayNextEpisode,
        hasAudioDevice,
      ),
    },
  };
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
  if (item === 'speed' && options?.isVod === true) {
    return {
      kind: 'state',
      state: { view: 'speed', index: selectedSpeedIndex(options.playbackSpeed) },
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
  const isVod = options?.isVod === true;
  const hasAspect = options?.hasAspect !== false;
  const hasDeinterlace = options?.hasDeinterlace === true;
  const hasAutoSubtitlesOnSkipBack = options?.hasAutoSubtitlesOnSkipBack === true;
  const hasAutoPlayNextEpisode = options?.hasAutoPlayNextEpisode === true;
  const hasAudioDevice = options?.hasAudioDevice === true;
  const rootItems = settingsRootItems(
    isVod,
    hasAspect,
    hasDeinterlace,
    hasAutoSubtitlesOnSkipBack,
    hasAutoPlayNextEpisode,
    hasAudioDevice,
  );
  const cur = clampSettingsMenu(state, tracks, options);

  if (event.kind === 'press' && event.key === 'back') {
    return cur.view === 'root'
      ? { kind: 'close' }
      : returnToRoot(
          cur.view,
          isVod,
          hasAspect,
          hasDeinterlace,
          hasAutoSubtitlesOnSkipBack,
          hasAutoPlayNextEpisode,
          hasAudioDevice,
        );
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
      : returnToRoot(
          cur.view,
          isVod,
          hasAspect,
          hasDeinterlace,
          hasAutoSubtitlesOnSkipBack,
          hasAutoPlayNextEpisode,
          hasAudioDevice,
        );
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
    if (cur.view === 'speed') {
      const rate = PLAYBACK_SPEED_OPTIONS[cur.index];
      return rate !== undefined ? { kind: 'speed', rate } : null;
    }
    const track = tracks.audio[cur.index];
    return track !== undefined ? { kind: 'audio', id: track.id } : null;
  }

  return null;
}

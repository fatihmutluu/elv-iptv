import type { KeyEvent } from '@elv/focus-core';
import type { MediaTracks } from '@elv/playback';

/** Active level inside the 2-level Player Settings menu (`root` or a sub-view). */
export type SettingsMenuView = 'root' | 'subtitles' | 'audio' | 'speed';

/** Focused row state for the 2-level Player Settings menu. */
export interface SettingsMenuState {
  readonly view: SettingsMenuView;
  readonly index: number;
}

/** Ordered rows shown on the root level of the Player Settings menu. */
export type SettingsRootItem = 'subtitles' | 'audio' | 'speed' | 'stats';

/** Supported VOD playback speed multipliers (`0.5×` through `2×`). */
export const PLAYBACK_SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Formats a playback speed multiplier as a compact tabular badge (e.g. `1×`, `1.25×`). */
export function formatPlaybackSpeed(rate: number): string {
  return `${rate}×`;
}

/** Canonical top-to-bottom order of root Player Settings rows for Live streams. */
export const SETTINGS_ROOT_ITEMS: readonly SettingsRootItem[] = ['subtitles', 'audio', 'stats'];

const VOD_ROOT_ITEMS: readonly SettingsRootItem[] = ['subtitles', 'audio', 'speed', 'stats'];

/** Returns the ordered root Player Settings rows for the active stream kind. */
export function settingsRootItems(isVod: boolean): readonly SettingsRootItem[] {
  return isVod ? VOD_ROOT_ITEMS : SETTINGS_ROOT_ITEMS;
}

/** Optional VOD context passed to Player Settings navigation helpers. */
export interface SettingsMenuOptions {
  readonly isVod?: boolean;
  readonly playbackSpeed?: number;
}

/** Result of routing a {@link KeyEvent} while the Player Settings menu is open. */
export type SettingsMenuIntent =
  | { readonly kind: 'state'; readonly state: SettingsMenuState }
  | { readonly kind: 'close' }
  | { readonly kind: 'toggleStats' }
  | { readonly kind: 'audio'; readonly id: string }
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
  return { view, index: 0 };
}

/** Number of focusable rows in `view` (`subtitles` includes row 0 for "Off"). */
export function settingsRowCount(
  view: SettingsMenuView,
  tracks: MediaTracks,
  options?: SettingsMenuOptions,
): number {
  if (view === 'root') return settingsRootItems(options?.isVod === true).length;
  if (view === 'subtitles') return tracks.subtitles.length + 1;
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
  const count = settingsRowCount(state.view, tracks, options);
  const max = Math.max(0, count - 1);
  const index = Math.max(0, Math.min(max, state.index));
  return index === state.index ? state : { view: state.view, index };
}

function selectedAudioIndex(tracks: MediaTracks): number {
  const idx = tracks.audio.findIndex((t) => t.id === tracks.selectedAudioId);
  return Math.max(0, idx);
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
): number {
  const idx = settingsRootItems(isVod).indexOf(view);
  return Math.max(idx, 0);
}

function returnToRoot(view: Exclude<SettingsMenuView, 'root'>, isVod: boolean): SettingsMenuIntent {
  return { kind: 'state', state: { view: 'root', index: rootIndexForSettingsView(view, isVod) } };
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
  const rootItems = settingsRootItems(isVod);
  const cur = clampSettingsMenu(state, tracks, options);

  if (event.kind === 'press' && event.key === 'back') {
    return cur.view === 'root' ? { kind: 'close' } : returnToRoot(cur.view, isVod);
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
    return cur.view === 'root' ? null : returnToRoot(cur.view, isVod);
  }

  if (event.kind === 'press' && event.key === 'right') {
    if (cur.view !== 'root') return null;
    const item = rootItems[cur.index];
    return item !== undefined ? openSubView(item, tracks, options) : null;
  }

  if (event.kind === 'press' && event.key === 'select') {
    if (cur.view === 'root') {
      const item = rootItems[cur.index];
      if (item === 'stats') return { kind: 'toggleStats' };
      return item !== undefined ? openSubView(item, tracks, options) : null;
    }
    if (cur.view === 'subtitles') {
      if (cur.index === 0) return { kind: 'subtitle', id: null };
      const track = tracks.subtitles[cur.index - 1];
      return track !== undefined ? { kind: 'subtitle', id: track.id } : null;
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

import type { KeyEvent } from '@elv/focus-core';
import type { MediaTracks } from '@elv/playback';

/** Active level inside the 2-level Player Settings menu (`root` or a track sub-view). */
export type SettingsMenuView = 'root' | 'subtitles' | 'audio';

/** Focused row state for the 2-level Player Settings menu. */
export interface SettingsMenuState {
  readonly view: SettingsMenuView;
  readonly index: number;
}

/** Ordered rows shown on the root level of the Player Settings menu. */
export type SettingsRootItem = 'subtitles' | 'audio' | 'stats';

/** Canonical top-to-bottom order of root Player Settings rows. */
export const SETTINGS_ROOT_ITEMS: readonly SettingsRootItem[] = ['subtitles', 'audio', 'stats'];

/** Result of routing a {@link KeyEvent} while the Player Settings menu is open. */
export type SettingsMenuIntent =
  | { readonly kind: 'state'; readonly state: SettingsMenuState }
  | { readonly kind: 'close' }
  | { readonly kind: 'toggleStats' }
  | { readonly kind: 'audio'; readonly id: string }
  | { readonly kind: 'subtitle'; readonly id: string | null };

/** Creates the initial focused state for the given Settings menu view (`root` by default). */
export function initialSettingsMenu(view: SettingsMenuView = 'root'): SettingsMenuState {
  return { view, index: 0 };
}

/** Number of focusable rows in `view` (`subtitles` includes row 0 for "Off"). */
export function settingsRowCount(view: SettingsMenuView, tracks: MediaTracks): number {
  if (view === 'root') return SETTINGS_ROOT_ITEMS.length;
  if (view === 'subtitles') return tracks.subtitles.length + 1;
  return tracks.audio.length;
}

/** Keeps `state.index` within valid bounds for `state.view`, returning `state` unchanged when valid. */
export function clampSettingsMenu(
  state: SettingsMenuState,
  tracks: MediaTracks,
): SettingsMenuState {
  const count = settingsRowCount(state.view, tracks);
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

function returnToRoot(view: 'subtitles' | 'audio'): SettingsMenuIntent {
  return { kind: 'state', state: { view: 'root', index: view === 'subtitles' ? 0 : 1 } };
}

function openSubView(item: SettingsRootItem, tracks: MediaTracks): SettingsMenuIntent | null {
  if (item === 'subtitles') {
    return { kind: 'state', state: { view: 'subtitles', index: selectedSubtitleIndex(tracks) } };
  }
  if (item === 'audio') {
    return { kind: 'state', state: { view: 'audio', index: selectedAudioIndex(tracks) } };
  }
  return null;
}

/** Routes a key event while the 2-level Player Settings menu is open. */
export function routeSettingsMenuKey(
  event: KeyEvent,
  state: SettingsMenuState,
  tracks: MediaTracks,
): SettingsMenuIntent | null {
  const cur = clampSettingsMenu(state, tracks);

  if (event.kind === 'press' && event.key === 'back') {
    return cur.view === 'root' ? { kind: 'close' } : returnToRoot(cur.view);
  }

  if (
    (event.kind === 'press' || event.kind === 'repeat') &&
    (event.key === 'up' || event.key === 'down')
  ) {
    const delta = event.key === 'down' ? 1 : -1;
    return {
      kind: 'state',
      state: clampSettingsMenu({ view: cur.view, index: cur.index + delta }, tracks),
    };
  }

  if (event.kind === 'press' && event.key === 'left') {
    return cur.view === 'root' ? null : returnToRoot(cur.view);
  }

  if (event.kind === 'press' && event.key === 'right') {
    if (cur.view !== 'root') return null;
    const item = SETTINGS_ROOT_ITEMS[cur.index];
    return item !== undefined ? openSubView(item, tracks) : null;
  }

  if (event.kind === 'press' && event.key === 'select') {
    if (cur.view === 'root') {
      const item = SETTINGS_ROOT_ITEMS[cur.index];
      if (item === 'stats') return { kind: 'toggleStats' };
      return item !== undefined ? openSubView(item, tracks) : null;
    }
    if (cur.view === 'subtitles') {
      if (cur.index === 0) return { kind: 'subtitle', id: null };
      const track = tracks.subtitles[cur.index - 1];
      return track !== undefined ? { kind: 'subtitle', id: track.id } : null;
    }
    const track = tracks.audio[cur.index];
    return track !== undefined ? { kind: 'audio', id: track.id } : null;
  }

  return null;
}

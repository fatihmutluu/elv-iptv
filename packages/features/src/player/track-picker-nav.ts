import type { KeyEvent } from '@elv/focus-core';
import type { MediaTracks, TrackInfo } from '@elv/playback';

/** Column identifier inside the two-column track picker. */
export type TrackPickerColumn = 'audio' | 'subtitles';

/** Logical D-pad / keyboard cursor inside the track picker; subtitle row 0 is "Off". */
export interface TrackPickerCursor {
  readonly column: TrackPickerColumn;
  readonly index: number;
}

/** Direction key moving a {@link TrackPickerCursor}. */
export type PickerMove = 'up' | 'down' | 'left' | 'right';

/** Optional capability flags extending the subtitles column of `TrackPickerModal` (`#32`, `#402`). */
export interface TrackPickerOptions {
  readonly dualSubtitles?: boolean;
  readonly canPickSubtitleFile?: boolean;
  readonly canLoadSubtitleUrl?: boolean;
}

/** Ordered focusable row descriptor inside the subtitles column of `TrackPickerModal`. */
export type SubtitleColumnEntry =
  | { readonly kind: 'primaryOff' }
  | { readonly kind: 'primaryTrack'; readonly track: TrackInfo; readonly trackIndex: number }
  | { readonly kind: 'secondaryOff' }
  | {
      readonly kind: 'secondaryTrack';
      readonly track: TrackInfo;
      readonly trackIndex: number;
      readonly disabled: boolean;
    }
  | { readonly kind: 'pickSubtitleFile' }
  | { readonly kind: 'loadSubtitleUrl' };

/** Track selection or external subtitle action requested by activating a {@link TrackPickerCursor}. */
export type PickerActivation =
  | { readonly kind: 'audio'; readonly id: string }
  | { readonly kind: 'subtitle'; readonly id: string | null }
  | { readonly kind: 'secondarySubtitle'; readonly id: string | null }
  | { readonly kind: 'pickSubtitleFile' }
  | { readonly kind: 'loadSubtitleUrl' };

/** Builds the ordered focusable rows of the subtitles column (primary, optional secondary, external actions). */
export function buildSubtitleColumnEntries(
  tracks: MediaTracks,
  options?: TrackPickerOptions,
): readonly SubtitleColumnEntry[] {
  const entries: SubtitleColumnEntry[] = [{ kind: 'primaryOff' }];
  tracks.subtitles.forEach((track, trackIndex) => {
    entries.push({ kind: 'primaryTrack', track, trackIndex });
  });
  if (options?.dualSubtitles === true && tracks.subtitles.length >= 1) {
    entries.push({ kind: 'secondaryOff' });
    tracks.subtitles.forEach((track, trackIndex) => {
      entries.push({
        kind: 'secondaryTrack',
        track,
        trackIndex,
        disabled: tracks.selectedSubtitleId !== null && track.id === tracks.selectedSubtitleId,
      });
    });
  }
  if (options?.canPickSubtitleFile === true) {
    entries.push({ kind: 'pickSubtitleFile' });
  }
  if (options?.canLoadSubtitleUrl === true) {
    entries.push({ kind: 'loadSubtitleUrl' });
  }
  return entries;
}

function selectedAudioCursor(tracks: MediaTracks): TrackPickerCursor {
  const idx = tracks.audio.findIndex((t) => t.id === tracks.selectedAudioId);
  return { column: 'audio', index: Math.max(0, idx) };
}

function selectedSubtitleCursor(tracks: MediaTracks): TrackPickerCursor {
  const idx = tracks.subtitles.findIndex((t) => t.id === tracks.selectedSubtitleId);
  return { column: 'subtitles', index: idx + 1 };
}

function rowCount(
  column: TrackPickerColumn,
  tracks: MediaTracks,
  options?: TrackPickerOptions,
): number {
  return column === 'audio'
    ? tracks.audio.length
    : buildSubtitleColumnEntries(tracks, options).length;
}

/** Cursor when the picker opens: honors `preferredColumn` when available, else audio then subtitles. */
export function initialPickerCursor(
  tracks: MediaTracks,
  preferredColumn?: TrackPickerColumn,
): TrackPickerCursor {
  if (preferredColumn === 'subtitles') return selectedSubtitleCursor(tracks);
  if (preferredColumn === 'audio' && tracks.audio.length > 0) return selectedAudioCursor(tracks);
  return tracks.audio.length > 0 ? selectedAudioCursor(tracks) : selectedSubtitleCursor(tracks);
}

/**
 * Keeps `cursor` on a mounted row after `tracks` changed: clamps the index, and moves to the subtitle
 * selection when the audio column disappeared. Returns `cursor` itself when it is still valid.
 */
export function clampPickerCursor(
  cursor: TrackPickerCursor,
  tracks: MediaTracks,
  options?: TrackPickerOptions,
): TrackPickerCursor {
  if (cursor.column === 'audio' && tracks.audio.length === 0) return selectedSubtitleCursor(tracks);
  const max = Math.max(0, rowCount(cursor.column, tracks, options) - 1);
  const index = Math.max(0, Math.min(max, cursor.index));
  return index === cursor.index ? cursor : { column: cursor.column, index };
}

/** Moves the (clamped) cursor; Left/Right jump to the other column's selected row. */
export function movePickerCursor(
  cursor: TrackPickerCursor,
  tracks: MediaTracks,
  move: PickerMove,
  options?: TrackPickerOptions,
): TrackPickerCursor {
  const cur = clampPickerCursor(cursor, tracks, options);
  if (move === 'left') {
    return cur.column === 'audio' || tracks.audio.length === 0 ? cur : selectedAudioCursor(tracks);
  }
  if (move === 'right') return cur.column === 'subtitles' ? cur : selectedSubtitleCursor(tracks);
  const delta = move === 'down' ? 1 : -1;
  return clampPickerCursor({ column: cur.column, index: cur.index + delta }, tracks, options);
}

/** Selection or action for the row under the (clamped) cursor, or `null` when the row is disabled. */
export function activatePickerCursor(
  cursor: TrackPickerCursor,
  tracks: MediaTracks,
  options?: TrackPickerOptions,
): PickerActivation | null {
  const cur = clampPickerCursor(cursor, tracks, options);
  if (cur.column === 'audio') {
    const audio = tracks.audio[cur.index];
    return audio !== undefined ? { kind: 'audio', id: audio.id } : null;
  }
  const entry = buildSubtitleColumnEntries(tracks, options)[cur.index];
  if (entry === undefined) return null;
  if (entry.kind === 'primaryOff') return { kind: 'subtitle', id: null };
  if (entry.kind === 'primaryTrack') return { kind: 'subtitle', id: entry.track.id };
  if (entry.kind === 'secondaryOff') return { kind: 'secondarySubtitle', id: null };
  if (entry.kind === 'secondaryTrack') {
    return entry.disabled ? null : { kind: 'secondarySubtitle', id: entry.track.id };
  }
  if (entry.kind === 'pickSubtitleFile') return { kind: 'pickSubtitleFile' };
  return { kind: 'loadSubtitleUrl' };
}

/** Result of routing a {@link KeyEvent} while `TrackPickerModal` is open. */
export type PickerKeyIntent =
  | { readonly kind: 'move'; readonly cursor: TrackPickerCursor }
  | PickerActivation;

/** Routes an open-picker key event to a cursor move or track activation, or `null` when ignored. */
export function routePickerKey(
  event: KeyEvent,
  cursor: TrackPickerCursor,
  tracks: MediaTracks,
  options?: TrackPickerOptions,
): PickerKeyIntent | null {
  if (
    (event.kind === 'press' && (event.key === 'left' || event.key === 'right')) ||
    ((event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'up' || event.key === 'down'))
  ) {
    return { kind: 'move', cursor: movePickerCursor(cursor, tracks, event.key, options) };
  }
  if (event.kind === 'press' && event.key === 'select') {
    return activatePickerCursor(cursor, tracks, options);
  }
  return null;
}

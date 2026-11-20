import type { KeyEvent } from '@elv/focus-core';
import type { MediaTracks, TrackInfo } from '@elv/playback';

type TrackPickerColumn = 'audio' | 'subtitles';

/** Logical D-pad / keyboard cursor inside the track picker; subtitle row 0 is "Off". */
export interface TrackPickerCursor {
  readonly column: TrackPickerColumn;
  readonly index: number;
}

/** Direction key moving a {@link TrackPickerCursor}. */
export type PickerMove = 'up' | 'down' | 'left' | 'right';

/** Track selection requested by activating a {@link TrackPickerCursor}. */
export type PickerActivation =
  | { readonly kind: 'audio'; readonly id: string }
  | { readonly kind: 'subtitle'; readonly id: string | null };

function selectedAudioCursor(tracks: MediaTracks): TrackPickerCursor {
  const idx = tracks.audio.findIndex((t) => t.id === tracks.selectedAudioId);
  return { column: 'audio', index: Math.max(0, idx) };
}

function selectedSubtitleCursor(tracks: MediaTracks): TrackPickerCursor {
  const idx = tracks.subtitles.findIndex((t) => t.id === tracks.selectedSubtitleId);
  return { column: 'subtitles', index: idx + 1 };
}

function rowCount(column: TrackPickerColumn, tracks: MediaTracks): number {
  return column === 'audio' ? tracks.audio.length : tracks.subtitles.length + 1;
}

/** Cursor when the picker opens: the selected audio track, else the selected subtitle row. */
export function initialPickerCursor(tracks: MediaTracks): TrackPickerCursor {
  return tracks.audio.length > 0 ? selectedAudioCursor(tracks) : selectedSubtitleCursor(tracks);
}

/**
 * Keeps `cursor` on a mounted row after `tracks` changed: clamps the index, and moves to the subtitle
 * selection when the audio column disappeared. Returns `cursor` itself when it is still valid.
 */
export function clampPickerCursor(
  cursor: TrackPickerCursor,
  tracks: MediaTracks,
): TrackPickerCursor {
  if (cursor.column === 'audio' && tracks.audio.length === 0) return selectedSubtitleCursor(tracks);
  const max = rowCount(cursor.column, tracks) - 1;
  const index = Math.max(0, Math.min(max, cursor.index));
  return index === cursor.index ? cursor : { column: cursor.column, index };
}

/** Moves the (clamped) cursor; Left/Right jump to the other column's selected row. */
export function movePickerCursor(
  cursor: TrackPickerCursor,
  tracks: MediaTracks,
  move: PickerMove,
): TrackPickerCursor {
  const cur = clampPickerCursor(cursor, tracks);
  if (move === 'left') {
    return cur.column === 'audio' || tracks.audio.length === 0 ? cur : selectedAudioCursor(tracks);
  }
  if (move === 'right') return cur.column === 'subtitles' ? cur : selectedSubtitleCursor(tracks);
  const delta = move === 'down' ? 1 : -1;
  return clampPickerCursor({ column: cur.column, index: cur.index + delta }, tracks);
}

/** Selection for the row under the (clamped) cursor. */
export function activatePickerCursor(
  cursor: TrackPickerCursor,
  tracks: MediaTracks,
): PickerActivation {
  const cur = clampPickerCursor(cursor, tracks);
  if (cur.column === 'audio') {
    return { kind: 'audio', id: (tracks.audio[cur.index] as TrackInfo).id };
  }
  if (cur.index === 0) return { kind: 'subtitle', id: null };
  return { kind: 'subtitle', id: (tracks.subtitles[cur.index - 1] as TrackInfo).id };
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
): PickerKeyIntent | null {
  if (
    (event.kind === 'press' && (event.key === 'left' || event.key === 'right')) ||
    ((event.kind === 'press' || event.kind === 'repeat') &&
      (event.key === 'up' || event.key === 'down'))
  ) {
    return { kind: 'move', cursor: movePickerCursor(cursor, tracks, event.key) };
  }
  if (event.kind === 'press' && event.key === 'select') {
    return activatePickerCursor(cursor, tracks);
  }
  return null;
}

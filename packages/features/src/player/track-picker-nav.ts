import type { KeyEvent } from '@elv/focus-core';
import {
  filterTracksByProgram,
  hasMultiplePrograms,
  type MediaTracks,
  type TrackInfo,
} from '@elv/playback';

/** Column identifier inside the track picker (`program` is shown only for multi-program TS, `#304`). */
export type TrackPickerColumn = 'program' | 'audio' | 'subtitles';

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
  | { readonly kind: 'program'; readonly id: string }
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

function effectiveTracks(tracks: MediaTracks): MediaTracks {
  return hasMultiplePrograms(tracks) ? filterTracksByProgram(tracks) : tracks;
}

function availableColumns(tracks: MediaTracks): readonly TrackPickerColumn[] {
  const effective = effectiveTracks(tracks);
  const cols: TrackPickerColumn[] = [];
  if (hasMultiplePrograms(tracks)) cols.push('program');
  if (effective.audio.length > 0) cols.push('audio');
  cols.push('subtitles');
  return cols;
}

function selectedProgramCursor(tracks: MediaTracks): TrackPickerCursor {
  const idx = (tracks.programs ?? []).findIndex((p) => p.id === tracks.selectedProgramId);
  return { column: 'program', index: Math.max(0, idx) };
}

function selectedAudioCursor(tracks: MediaTracks): TrackPickerCursor {
  const idx = tracks.audio.findIndex((t) => t.id === tracks.selectedAudioId);
  return { column: 'audio', index: Math.max(0, idx) };
}

function selectedSubtitleCursor(tracks: MediaTracks): TrackPickerCursor {
  const idx = tracks.subtitles.findIndex((t) => t.id === tracks.selectedSubtitleId);
  return { column: 'subtitles', index: idx + 1 };
}

function selectedColumnCursor(column: TrackPickerColumn, tracks: MediaTracks): TrackPickerCursor {
  if (column === 'program') return selectedProgramCursor(tracks);
  const effective = effectiveTracks(tracks);
  return column === 'audio' ? selectedAudioCursor(effective) : selectedSubtitleCursor(effective);
}

function rowCount(
  column: TrackPickerColumn,
  tracks: MediaTracks,
  options?: TrackPickerOptions,
): number {
  if (column === 'program') return tracks.programs?.length ?? 0;
  const effective = effectiveTracks(tracks);
  return column === 'audio'
    ? effective.audio.length
    : buildSubtitleColumnEntries(effective, options).length;
}

/** Cursor when the picker opens: honors `preferredColumn` when available, else audio then subtitles. */
export function initialPickerCursor(
  tracks: MediaTracks,
  preferredColumn?: TrackPickerColumn,
): TrackPickerCursor {
  const effective = effectiveTracks(tracks);
  if (preferredColumn === 'program' && hasMultiplePrograms(tracks)) {
    return selectedProgramCursor(tracks);
  }
  if (preferredColumn === 'subtitles') return selectedSubtitleCursor(effective);
  if (preferredColumn === 'audio' && effective.audio.length > 0) {
    return selectedAudioCursor(effective);
  }
  return effective.audio.length > 0
    ? selectedAudioCursor(effective)
    : selectedSubtitleCursor(effective);
}

/**
 * Keeps `cursor` on a mounted row after `tracks` changed: clamps the index, and moves to an
 * available column when the program or audio column disappeared. Returns `cursor` itself when still valid.
 */
export function clampPickerCursor(
  cursor: TrackPickerCursor,
  tracks: MediaTracks,
  options?: TrackPickerOptions,
): TrackPickerCursor {
  const cols = availableColumns(tracks);
  if (!cols.includes(cursor.column)) {
    const effective = effectiveTracks(tracks);
    if (cursor.column === 'program' && effective.audio.length > 0) {
      return selectedAudioCursor(effective);
    }
    return selectedSubtitleCursor(effective);
  }
  const max = Math.max(0, rowCount(cursor.column, tracks, options) - 1);
  const index = Math.max(0, Math.min(max, cursor.index));
  return index === cursor.index ? cursor : { column: cursor.column, index };
}

/** Moves the (clamped) cursor; Left/Right jump to the adjacent available column's selected row. */
export function movePickerCursor(
  cursor: TrackPickerCursor,
  tracks: MediaTracks,
  move: PickerMove,
  options?: TrackPickerOptions,
): TrackPickerCursor {
  const cur = clampPickerCursor(cursor, tracks, options);
  const cols = availableColumns(tracks);
  const colIdx = cols.indexOf(cur.column);
  if (move === 'left') {
    if (colIdx <= 0) return cur;
    const targetCol = cols[colIdx - 1];
    return targetCol !== undefined ? selectedColumnCursor(targetCol, tracks) : cur;
  }
  if (move === 'right') {
    if (colIdx < 0 || colIdx >= cols.length - 1) return cur;
    const targetCol = cols[colIdx + 1];
    return targetCol !== undefined ? selectedColumnCursor(targetCol, tracks) : cur;
  }
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
  if (cur.column === 'program') {
    const program = tracks.programs?.[cur.index];
    return program !== undefined ? { kind: 'program', id: program.id } : null;
  }
  const effective = effectiveTracks(tracks);
  if (cur.column === 'audio') {
    const audio = effective.audio[cur.index];
    return audio !== undefined ? { kind: 'audio', id: audio.id } : null;
  }
  const entry = buildSubtitleColumnEntries(effective, options)[cur.index];
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

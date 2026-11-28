import type { MediaTracks, TrackInfo } from '@elv/playback';

/** Optional capability flags extending the secondary/external sections of subtitle settings (`#32`, `#402`). */
export interface TrackPickerOptions {
  readonly dualSubtitles?: boolean;
  readonly canPickSubtitleFile?: boolean;
  readonly canLoadSubtitleUrl?: boolean;
}

/** Ordered row descriptor derived from subtitle tracks, optional dual subtitles, and external actions. */
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

/** Builds ordered primary, secondary, and external subtitle rows from `tracks` and capability flags. */
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

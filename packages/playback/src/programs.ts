import type { MediaTracks } from './engine';

/** Returns `true` when the active stream exposes more than one selectable MPEG-TS program (`#304`). */
export function hasMultiplePrograms(tracks: MediaTracks): boolean {
  return (tracks.programs?.length ?? 0) > 1;
}

function filterListByProgram<
  T extends { readonly programId?: string; readonly external?: boolean },
>(items: readonly T[], selectedProgramId: string): readonly T[] {
  const hasAnyProgramId = items.some(
    (item) => typeof item.programId === 'string' && item.programId.length > 0,
  );
  if (!hasAnyProgramId) return items;
  return items.filter((item) => item.external === true || item.programId === selectedProgramId);
}

/**
 * Filters `audio`, `subtitles`, and `videoQualities` to the active `selectedProgramId` when
 * `tracks.programs` has more than one entry and `selectedProgramId` is set (`#304`).
 * External subtitles (`external === true`) are always preserved, and track lists without any
 * `programId` metadata are kept intact. Returns `tracks` unchanged otherwise.
 */
export function filterTracksByProgram(tracks: MediaTracks): MediaTracks {
  if (!hasMultiplePrograms(tracks)) return tracks;
  const selectedProgramId = tracks.selectedProgramId;
  if (selectedProgramId === undefined || selectedProgramId === null || selectedProgramId === '') {
    return tracks;
  }
  const audio = filterListByProgram(tracks.audio, selectedProgramId);
  const subtitles = filterListByProgram(tracks.subtitles, selectedProgramId);
  const videoQualities =
    tracks.videoQualities === undefined
      ? undefined
      : filterListByProgram(tracks.videoQualities, selectedProgramId);
  return {
    ...tracks,
    audio,
    subtitles,
    ...(videoQualities === undefined ? {} : { videoQualities }),
  };
}

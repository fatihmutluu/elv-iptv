import type { EpisodeRow, WatchProgressRow } from '@elv/data';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildEpisodeChunks,
  type EpisodeChunk,
  resolveInitialEpisodeChunkIndex,
} from './episode-chunks';

/** Options for {@link useEpisodeChunks}. */
export interface UseEpisodeChunksOptions {
  readonly itemKey: string;
  readonly selectedSeason: number | null;
  readonly episodes: readonly EpisodeRow[];
  readonly episodeProgressByKey: ReadonlyMap<string, WatchProgressRow>;
}

/** Derived chunk sub-tabs, active slice, and full-season index offset for a series season. */
export interface EpisodeChunksState {
  readonly chunks: readonly EpisodeChunk[];
  readonly selectedChunkIndex: number;
  readonly visibleEpisodes: readonly EpisodeRow[];
  readonly episodeIndexOffset: number;
  readonly selectChunk: (index: number) => void;
}

/**
 * Manages 30-episode chunk sub-tab selection for seasons with `>= 60` episodes (`#152`).
 * Automatically jumps to the chunk containing the actionable resume / next-unwatched episode
 * whenever `itemKey` or `selectedSeason` changes, and clamps safely if chunks shrink.
 */
export function useEpisodeChunks({
  itemKey,
  selectedSeason,
  episodes,
  episodeProgressByKey,
}: UseEpisodeChunksOptions): EpisodeChunksState {
  const chunks = useMemo(() => buildEpisodeChunks(episodes), [episodes]);
  const defaultChunkIndex = useMemo(
    () => resolveInitialEpisodeChunkIndex(episodes, episodeProgressByKey, chunks),
    [chunks, episodeProgressByKey, episodes],
  );
  const [selection, setSelection] = useState<{
    readonly scope: string;
    readonly index: number;
  } | null>(null);

  const scope = `${itemKey}|${selectedSeason ?? ''}`;

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset stale manual chunk override whenever title or season changes
  useEffect(() => {
    setSelection(null);
  }, [scope]);

  const rawIndex =
    selection !== null && selection.scope === scope ? selection.index : defaultChunkIndex;
  const selectedChunkIndex =
    chunks.length > 0 ? Math.min(Math.max(0, rawIndex), chunks.length - 1) : 0;
  const activeChunk = chunks[selectedChunkIndex];

  const visibleEpisodes = useMemo(
    () =>
      activeChunk !== undefined
        ? episodes.slice(activeChunk.startIndex, activeChunk.endIndex)
        : episodes,
    [activeChunk, episodes],
  );
  const episodeIndexOffset = activeChunk?.startIndex ?? 0;

  const selectChunk = useCallback(
    (index: number) => {
      setSelection({ scope, index });
    },
    [scope],
  );

  return {
    chunks,
    selectedChunkIndex,
    visibleEpisodes,
    episodeIndexOffset,
    selectChunk,
  };
}

import type { EpisodeRow, WatchProgressRow } from '@elv/data';
import { resolveSeriesPrimaryEpisode } from './detail-model';

/** Minimum episode count in a season before 30-episode chunk sub-tabs activate (`#152`). */
export const EPISODE_CHUNK_THRESHOLD = 60;

/** Default maximum number of mounted episode rows per chunk sub-tab (`#152`). */
export const EPISODE_CHUNK_SIZE = 30;

/** Descriptor of one contiguous slice of episodes within a long season. */
export interface EpisodeChunk {
  readonly index: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly label: string;
}

function hasMonotonicEpisodeNumbers(episodes: readonly EpisodeRow[]): boolean {
  let prev = 0;
  for (const ep of episodes) {
    const num = ep.episode;
    if (num === null || !Number.isInteger(num) || num <= prev) return false;
    prev = num;
  }
  return true;
}

/**
 * Partitions a season with `>= threshold` episodes into `chunkSize`-sized sub-tab slices.
 * Seasons with fewer than `threshold` episodes return `[]` so short seasons render zero extra UI.
 * Uses monotonic provider episode numbers for `"start–end"` labels, falling back to 1-based
 * ordinals when episode numbers are missing or non-monotonic.
 */
export function buildEpisodeChunks(
  episodes: readonly EpisodeRow[],
  chunkSize = EPISODE_CHUNK_SIZE,
  threshold = EPISODE_CHUNK_THRESHOLD,
): EpisodeChunk[] {
  const safeChunkSize =
    Number.isFinite(chunkSize) && chunkSize >= 1 ? Math.floor(chunkSize) : EPISODE_CHUNK_SIZE;
  const safeThreshold =
    Number.isFinite(threshold) && threshold >= 1 ? Math.floor(threshold) : EPISODE_CHUNK_THRESHOLD;

  if (episodes.length < safeThreshold) return [];

  const useProviderNumbers = hasMonotonicEpisodeNumbers(episodes);
  const chunks: EpisodeChunk[] = [];
  for (
    let startIndex = 0, index = 0;
    startIndex < episodes.length;
    startIndex += safeChunkSize, index += 1
  ) {
    const endIndex = Math.min(episodes.length, startIndex + safeChunkSize);
    const firstEp = episodes[startIndex]?.episode;
    const lastEp = episodes[endIndex - 1]?.episode;
    const startNum =
      useProviderNumbers && firstEp !== undefined && firstEp !== null ? firstEp : startIndex + 1;
    const endNum =
      useProviderNumbers && lastEp !== undefined && lastEp !== null ? lastEp : endIndex;
    chunks.push({
      index,
      startIndex,
      endIndex,
      label: `${startNum}–${endNum}`,
    });
  }
  return chunks;
}

/**
 * Resolves the initial chunk index containing the actionable resume / next-unwatched episode
 * via {@link resolveSeriesPrimaryEpisode}, falling back to `0`.
 */
export function resolveInitialEpisodeChunkIndex(
  episodes: readonly EpisodeRow[],
  progressByKey: ReadonlyMap<string, WatchProgressRow>,
  chunks: readonly EpisodeChunk[],
): number {
  if (chunks.length === 0 || episodes.length === 0) return 0;
  const picked = resolveSeriesPrimaryEpisode(episodes, progressByKey);
  if (!picked) return 0;
  const matched = chunks.findIndex(
    (chunk) => picked.index >= chunk.startIndex && picked.index < chunk.endIndex,
  );
  return Math.max(matched, 0);
}

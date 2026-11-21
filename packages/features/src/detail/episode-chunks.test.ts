import type { EpisodeRow, WatchProgressRow } from '@elv/data';
import { describe, expect, it } from 'vitest';
import {
  buildEpisodeChunks,
  EPISODE_CHUNK_SIZE,
  EPISODE_CHUNK_THRESHOLD,
  resolveInitialEpisodeChunkIndex,
} from './episode-chunks';

function makeEpisodes(
  count: number,
  episodeNumberFn: (index: number) => number | null = (i) => i + 1,
): EpisodeRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    key: `x:s1:ep:${i + 1}`,
    season: 1,
    episode: episodeNumberFn(i),
    title: `Episode ${i + 1}`,
    durationSec: 2700,
  }));
}

function makeProgress(
  itemKey: string,
  overrides: Partial<WatchProgressRow> = {},
): WatchProgressRow {
  return {
    profileId: 'default',
    sourceId: 's1',
    itemKey,
    kind: 'episode',
    title: 'Episode',
    subtitle: null,
    logo: null,
    seriesKey: 'x:s1:series:301',
    season: 1,
    episode: 1,
    positionMs: 0,
    durationMs: 2_700_000,
    watched: false,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('episode-chunks', () => {
  it('exports default threshold 60 and chunk size 30', () => {
    expect(EPISODE_CHUNK_THRESHOLD).toBe(60);
    expect(EPISODE_CHUNK_SIZE).toBe(30);
  });

  describe('buildEpisodeChunks', () => {
    it('returns empty array when episode count is below threshold (< 60)', () => {
      expect(buildEpisodeChunks([])).toEqual([]);
      expect(buildEpisodeChunks(makeEpisodes(12))).toEqual([]);
      expect(buildEpisodeChunks(makeEpisodes(59))).toEqual([]);
    });

    it('partitions exactly 60 episodes into 2 chunks (1–30, 31–60)', () => {
      expect(buildEpisodeChunks(makeEpisodes(60))).toEqual([
        { index: 0, startIndex: 0, endIndex: 30, label: '1–30' },
        { index: 1, startIndex: 30, endIndex: 60, label: '31–60' },
      ]);
    });

    it('partitions 105 episodes into 4 chunks (1–30, 31–60, 61–90, 91–105)', () => {
      expect(buildEpisodeChunks(makeEpisodes(105))).toEqual([
        { index: 0, startIndex: 0, endIndex: 30, label: '1–30' },
        { index: 1, startIndex: 30, endIndex: 60, label: '31–60' },
        { index: 2, startIndex: 60, endIndex: 90, label: '61–90' },
        { index: 3, startIndex: 90, endIndex: 105, label: '91–105' },
      ]);
    });

    it('uses provider episode numbers when strictly monotonic (e.g. continuous anime numbering)', () => {
      const episodes = makeEpisodes(65, (i) => 101 + i);
      expect(buildEpisodeChunks(episodes)).toEqual([
        { index: 0, startIndex: 0, endIndex: 30, label: '101–130' },
        { index: 1, startIndex: 30, endIndex: 60, label: '131–160' },
        { index: 2, startIndex: 60, endIndex: 65, label: '161–165' },
      ]);
    });

    it('falls back to 1-based ordinal labels when episode numbers are null or non-monotonic', () => {
      const nullNumbered = makeEpisodes(62, () => null);
      expect(buildEpisodeChunks(nullNumbered)).toEqual([
        { index: 0, startIndex: 0, endIndex: 30, label: '1–30' },
        { index: 1, startIndex: 30, endIndex: 60, label: '31–60' },
        { index: 2, startIndex: 60, endIndex: 62, label: '61–62' },
      ]);

      const descending = makeEpisodes(60, (i) => 60 - i);
      expect(buildEpisodeChunks(descending)).toEqual([
        { index: 0, startIndex: 0, endIndex: 30, label: '1–30' },
        { index: 1, startIndex: 30, endIndex: 60, label: '31–60' },
      ]);

      const duplicates = makeEpisodes(60, () => 1);
      expect(buildEpisodeChunks(duplicates)).toEqual([
        { index: 0, startIndex: 0, endIndex: 30, label: '1–30' },
        { index: 1, startIndex: 30, endIndex: 60, label: '31–60' },
      ]);
    });

    it('supports custom chunkSize and threshold and guards non-positive inputs', () => {
      expect(buildEpisodeChunks(makeEpisodes(10), 4, 8)).toEqual([
        { index: 0, startIndex: 0, endIndex: 4, label: '1–4' },
        { index: 1, startIndex: 4, endIndex: 8, label: '5–8' },
        { index: 2, startIndex: 8, endIndex: 10, label: '9–10' },
      ]);
      expect(buildEpisodeChunks(makeEpisodes(60), 0, -5)).toHaveLength(2);
    });
  });

  describe('resolveInitialEpisodeChunkIndex', () => {
    it('returns 0 when chunks or episodes are empty or no watch progress exists', () => {
      const episodes = makeEpisodes(100);
      const chunks = buildEpisodeChunks(episodes);
      expect(resolveInitialEpisodeChunkIndex([], new Map(), chunks)).toBe(0);
      expect(resolveInitialEpisodeChunkIndex(episodes, new Map(), [])).toBe(0);
      expect(resolveInitialEpisodeChunkIndex(episodes, new Map(), chunks)).toBe(0);
    });

    it('jumps straight to chunk 2 (61–90) when E72 is in progress', () => {
      const episodes = makeEpisodes(100);
      const chunks = buildEpisodeChunks(episodes);
      const progress = new Map<string, WatchProgressRow>([
        ['x:s1:ep:72', makeProgress('x:s1:ep:72', { positionMs: 600_000, watched: false })],
      ]);
      expect(resolveInitialEpisodeChunkIndex(episodes, progress, chunks)).toBe(2);
    });

    it('jumps straight to chunk 2 (61–90) when E1–E65 are watched and E66 is next unwatched', () => {
      const episodes = makeEpisodes(100);
      const chunks = buildEpisodeChunks(episodes);
      const progress = new Map<string, WatchProgressRow>();
      for (let i = 1; i <= 65; i++) {
        const key = `x:s1:ep:${i}`;
        progress.set(key, makeProgress(key, { watched: true, positionMs: 2_700_000 }));
      }
      expect(resolveInitialEpisodeChunkIndex(episodes, progress, chunks)).toBe(2);
    });

    it('falls back to chunk 0 when all episodes are watched or chunks do not cover picked index', () => {
      const episodes = makeEpisodes(100);
      const chunks = buildEpisodeChunks(episodes);
      const allWatched = new Map<string, WatchProgressRow>();
      for (let i = 1; i <= 100; i++) {
        const key = `x:s1:ep:${i}`;
        allWatched.set(key, makeProgress(key, { watched: true, positionMs: 2_700_000 }));
      }
      expect(resolveInitialEpisodeChunkIndex(episodes, allWatched, chunks)).toBe(0);

      const inProgress72 = new Map<string, WatchProgressRow>([
        ['x:s1:ep:72', makeProgress('x:s1:ep:72', { positionMs: 600_000, watched: false })],
      ]);
      expect(
        resolveInitialEpisodeChunkIndex(episodes, inProgress72, [
          { index: 0, startIndex: 0, endIndex: 30, label: '1–30' },
        ]),
      ).toBe(0);
    });
  });
});

import type { ChapterInfo } from '@elv/playback';
import { describe, expect, it } from 'vitest';
import {
  computeChapterMarkerDots,
  findChapterAtPosition,
  normalizeChapters,
  resolveChapterJumpTarget,
} from './chapters';

const CHAPTERS: readonly ChapterInfo[] = [
  { id: 'c2', title: 'Act II', startMs: 60_000, endMs: 120_000 },
  { id: 'c0', title: 'Intro', startMs: 0, endMs: 30_000 },
  { id: 'c1', title: 'Act I', startMs: 30_000, endMs: 60_000 },
];

describe('chapters (#118)', () => {
  it('normalizes, sorts, and computes marker dots excluding 0ms origin', () => {
    const sorted = normalizeChapters(CHAPTERS, 150_000);
    expect(sorted.map((c) => c.id)).toEqual(['c0', 'c1', 'c2']);

    const dots = computeChapterMarkerDots(CHAPTERS, 120_000);
    expect(dots).toEqual([
      { id: 'c1', title: 'Act I', startMs: 30_000, leftPct: 25 },
      { id: 'c2', title: 'Act II', startMs: 60_000, leftPct: 50 },
    ]);
  });

  it('finds active chapter for a given position', () => {
    const sorted = normalizeChapters(CHAPTERS, 150_000);
    expect(findChapterAtPosition(sorted, 0)?.title).toBe('Intro');
    expect(findChapterAtPosition(sorted, 45_000)?.title).toBe('Act I');
    expect(findChapterAtPosition(sorted, 125_000)).toBeUndefined();
  });

  it('resolves prev/next chapter jump targets with 3s restart threshold', () => {
    expect(resolveChapterJumpTarget(CHAPTERS, 10_000, 'next')).toBe(30_000);
    expect(resolveChapterJumpTarget(CHAPTERS, 60_000, 'next')).toBeUndefined();

    // > 3s into Act I -> restarts Act I
    expect(resolveChapterJumpTarget(CHAPTERS, 35_000, 'prev')).toBe(30_000);
    // <= 3s into Act I -> jumps to Intro
    expect(resolveChapterJumpTarget(CHAPTERS, 32_000, 'prev')).toBe(0);
    // <= 3s into first chapter -> restarts at 0
    expect(resolveChapterJumpTarget(CHAPTERS, 1_500, 'prev')).toBe(0);
  });
});

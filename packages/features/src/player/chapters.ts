import type { ChapterInfo } from '@elv/playback';

/** Threshold (ms) into a chapter beyond which "Previous chapter" restarts the current chapter (`#118`). */
const CHAPTER_PREV_RESTART_THRESHOLD_MS = 3_000;

/** Positioned chapter dot on a normalized `[0, 100]` progress rail (`#118`). */
export interface ChapterMarkerDot {
  readonly id: string;
  readonly title?: string | undefined;
  readonly startMs: number;
  readonly leftPct: number;
}

/**
 * Filters and sorts raw engine chapter markers to valid timestamps within `[0, durationMs)`.
 */
export function normalizeChapters(
  chapters: readonly ChapterInfo[] | undefined,
  durationMs: number | undefined,
): readonly ChapterInfo[] {
  if (!chapters || chapters.length === 0) return [];
  const hasDur = durationMs !== undefined && Number.isFinite(durationMs) && durationMs > 0;
  return chapters
    .filter(
      (c) => Number.isFinite(c.startMs) && c.startMs >= 0 && (!hasDur || c.startMs < durationMs),
    )
    .slice()
    .sort((a, b) => a.startMs - b.startMs);
}

/** Returns the active chapter covering `positionMs`, or `undefined` if none matches. */
export function findChapterAtPosition(
  chapters: readonly ChapterInfo[],
  positionMs: number,
): ChapterInfo | undefined {
  if (chapters.length === 0 || !Number.isFinite(positionMs) || positionMs < 0) return undefined;
  let active: ChapterInfo | undefined;
  for (const ch of chapters) {
    if (ch.startMs <= positionMs) active = ch;
    else break;
  }
  if (active?.endMs !== undefined && Number.isFinite(active.endMs) && positionMs >= active.endMs) {
    return undefined;
  }
  return active;
}

/**
 * Resolves the seek target timestamp (ms) for previous/next chapter stepping (`#118`).
 * - `'prev'`: restarts the current chapter if elapsed `> 3 000 ms`, else jumps to the prior chapter.
 * - `'next'`: jumps to the next chapter starting strictly after `positionMs`.
 */
export function resolveChapterJumpTarget(
  chapters: readonly ChapterInfo[],
  positionMs: number,
  direction: 'prev' | 'next',
): number | undefined {
  const sorted = normalizeChapters(chapters, undefined);
  if (sorted.length === 0 || !Number.isFinite(positionMs)) return undefined;
  const pos = Math.max(0, positionMs);

  let currentIdx = -1;
  for (let i = 0; i < sorted.length; i += 1) {
    const ch = sorted[i];
    if (ch !== undefined && ch.startMs <= pos) currentIdx = i;
    else break;
  }

  if (direction === 'next') {
    const nextChapter = sorted[currentIdx + 1];
    return nextChapter?.startMs;
  }

  if (currentIdx < 0) return undefined;
  const current = sorted[currentIdx];
  if (current === undefined) return undefined;
  if (pos - current.startMs > CHAPTER_PREV_RESTART_THRESHOLD_MS) {
    return current.startMs;
  }
  const prevChapter = sorted[currentIdx - 1];
  return prevChapter !== undefined ? prevChapter.startMs : current.startMs;
}

/** Maps normalized chapters into percentage marker positions along the VOD timeline (`#118`). */
export function computeChapterMarkerDots(
  chapters: readonly ChapterInfo[] | undefined,
  durationMs: number | undefined,
): readonly ChapterMarkerDot[] {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs <= 0) return [];
  const sorted = normalizeChapters(chapters, durationMs);
  return sorted
    .filter((ch) => ch.startMs > 0)
    .map((ch) => ({
      id: ch.id,
      ...(ch.title !== undefined ? { title: ch.title } : {}),
      startMs: ch.startMs,
      leftPct: Math.max(0, Math.min(100, Math.round((ch.startMs / durationMs) * 1000) / 10)),
    }));
}

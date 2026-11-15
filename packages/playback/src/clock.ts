import type { ClockAnchor } from './engine';

/** Extrapolates the playback position at `nowMs`, clamped to `[0, durationMs]`. */
export function positionAt(anchor: ClockAnchor, nowMs: number): number {
  const raw = anchor.positionMs + (nowMs - anchor.atMs) * anchor.rate;
  const capped = anchor.durationMs === undefined ? raw : Math.min(raw, anchor.durationMs);
  return Math.max(0, capped);
}

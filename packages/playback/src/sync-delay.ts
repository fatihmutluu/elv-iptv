/** Minimum live audio/subtitle sync delay offset in milliseconds (`#59`). */
export const MIN_SYNC_DELAY_MS = -30_000;

/** Maximum live audio/subtitle sync delay offset in milliseconds (`#59`). */
export const MAX_SYNC_DELAY_MS = 30_000;

/**
 * Clamps a live audio or subtitle sync delay offset to `[-30_000, 30_000]` ms and rounds to the
 * nearest integer millisecond. Returns `0` for non-finite inputs and avoids `-0`.
 */
export function clampSyncDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs)) return 0;
  const clamped = Math.round(Math.max(MIN_SYNC_DELAY_MS, Math.min(MAX_SYNC_DELAY_MS, delayMs)));
  return Object.is(clamped, -0) ? 0 : clamped;
}

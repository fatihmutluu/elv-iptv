/** Mirror of the focus-core key timing constants; `gate-hold.test.ts` pins them to the real ones. */
export const HOLD_CONSTANTS = {
  longPressMs: 500,
  repeatStartHz: 8,
  repeatFastHz: 24,
  repeatRampMs: 1500,
} as const;

/** How many moves a real hold may differ from {@link expectedHoldMoves} (device repeat timing jitters). */
export const HOLD_TOLERANCE = 3;

/**
 * Moves the focus-core interpreter makes for a held Down: the press, then (from the long-press threshold) one page
 * step and repeats every 1000/8 ms, switching to 1000/24 ms once the ramp is over. A repeat exactly on a slot boundary
 * may or may not fire on a device, which {@link HOLD_TOLERANCE} absorbs.
 */
export function expectedHoldMoves(holdMs: number): number {
  const { longPressMs, repeatStartHz, repeatFastHz, repeatRampMs } = HOLD_CONSTANTS;
  if (holdMs < longPressMs) return 1;
  const slow = 1000 / repeatStartHz;
  const rampEnd = longPressMs + repeatRampMs;
  let moves = 2;
  for (let t = longPressMs + slow; t < holdMs; t += t < rampEnd ? slow : 1000 / repeatFastHz) {
    moves++;
  }
  return moves;
}

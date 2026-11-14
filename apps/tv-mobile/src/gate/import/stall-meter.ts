/** Interval of the stall meter's ticks in ms. */
const STALL_TICK_MS = 16;

/** A running stall meter. */
export interface StallMeter {
  /** Stops the ticks and returns the longest gap between two ticks minus the 16 ms interval, rounded to 0.1 ms (0 at least). */
  stop(): number;
}

/**
 * Starts a 16 ms `setInterval` that stamps the clock; a JS thread that is busy delays the next tick, so the longest gap
 * minus the interval is the longest stall. `now` is injectable for tests.
 */
export function startStallMeter(now: () => number = () => performance.now()): StallMeter {
  let last = now();
  let longest = 0;
  const timer = setInterval(() => {
    const stamp = now();
    longest = Math.max(longest, stamp - last);
    last = stamp;
  }, STALL_TICK_MS);
  return {
    stop() {
      clearInterval(timer);
      longest = Math.max(longest, now() - last);
      return Math.round(Math.max(longest - STALL_TICK_MS, 0) * 10) / 10;
    },
  };
}

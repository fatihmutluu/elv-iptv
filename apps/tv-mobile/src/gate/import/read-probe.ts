/** Interval between two probe reads in ms. */
const READ_INTERVAL_MS = 50;

/** A running read probe. */
export interface ReadProbe {
  /** Stops after the read in flight; the longest read in ms (rounded to 0.1), reads started, reads that failed. */
  stop(): Promise<{ maxReadMs: number; reads: number; readErrors: number }>;
}

/**
 * Runs `read` right away and then 50 ms after each one ends, timing it with `now`: what a menu would wait for a page
 * while an import writes. A busy JS thread lengthens the reads too.
 */
export function startReadProbe(
  read: () => Promise<unknown>,
  now: () => number = () => performance.now(),
): ReadProbe {
  let stopped = false;
  let longest = 0;
  let reads = 0;
  let readErrors = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const loop = (async () => {
    while (!stopped) {
      const started = now();
      reads += 1;
      try {
        await read();
      } catch {
        readErrors += 1;
      }
      longest = Math.max(longest, now() - started);
      if (stopped) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, READ_INTERVAL_MS);
      });
    }
  })();
  return {
    async stop() {
      stopped = true;
      clearTimeout(timer);
      wake?.();
      await loop;
      return { maxReadMs: Math.round(longest * 10) / 10, reads, readErrors };
    },
  };
}

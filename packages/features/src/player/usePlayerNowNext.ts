import type { CatalogService, NowNextEntry } from '@elv/data';
import type { PlaybackClock } from '@elv/playback';
import { useEffect, useRef, useState } from 'react';

/** Periodic refresh interval (`60 000 ms`) for live Now/Next EPG metadata in the player (`#58`). */
export const PLAYER_NOW_NEXT_REFRESH_MS = 60_000;

/** Minimal catalog capability required by {@link usePlayerNowNext}. */
interface PlayerNowNextCatalog {
  readonly nowNext?: CatalogService['nowNext'];
  /** Optional alias supported for mock/port callers using `epgNowNext`. */
  readonly epgNowNext?: CatalogService['nowNext'];
}

/** Parameters for {@link usePlayerNowNext}. */
export interface UsePlayerNowNextParams {
  readonly catalog: PlayerNowNextCatalog | undefined;
  readonly itemKey: string | undefined;
  readonly enabled: boolean;
  /** Wall-clock Unix epoch timestamp provider in ms (defaults to `Date.now`). */
  readonly wallClock?: () => number;
  /** Legacy test clock override; prefer `wallClock` for Unix epoch timestamps. */
  readonly clock?: PlaybackClock;
  readonly refreshMs?: number;
}

/**
 * Fetches and periodically refreshes (every 60 s) Live Now/Next programme metadata for a single
 * channel key using wall-clock epoch time, dropping stale async responses cleanly on change or unmount (`#58`, `#57`).
 */
export function usePlayerNowNext(params: UsePlayerNowNextParams): NowNextEntry | null {
  const {
    catalog,
    itemKey,
    enabled,
    wallClock,
    clock,
    refreshMs = PLAYER_NOW_NEXT_REFRESH_MS,
  } = params;
  const query = catalog?.nowNext ?? catalog?.epgNowNext;
  const wallClockRef = useRef(wallClock);
  wallClockRef.current = wallClock;
  const clockRef = useRef(clock);
  clockRef.current = clock;

  const [entry, setEntry] = useState<NowNextEntry | null>(null);

  useEffect(() => {
    if (!enabled || itemKey === undefined || itemKey.length === 0 || query === undefined) {
      setEntry(null);
      return;
    }

    let cancelled = false;
    const fetchNowNext = (): void => {
      const nowMs =
        wallClockRef.current !== undefined
          ? wallClockRef.current()
          : clockRef.current !== undefined
            ? clockRef.current.now()
            : Date.now();
      void query([itemKey], nowMs).then(
        (rows) => {
          if (cancelled) return;
          const matched = rows.find((r) => r.channelKey === itemKey) ?? rows[0] ?? null;
          setEntry(matched);
        },
        () => {
          if (!cancelled) setEntry(null);
        },
      );
    };

    fetchNowNext();
    const intervalMs = Number.isFinite(refreshMs) && refreshMs > 0 ? refreshMs : 0;
    const handle = intervalMs > 0 ? setInterval(fetchNowNext, intervalMs) : undefined;

    return () => {
      cancelled = true;
      if (handle !== undefined) clearInterval(handle);
    };
  }, [enabled, itemKey, query, refreshMs]);

  return entry;
}

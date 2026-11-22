import type { CatalogService, SourceImportHealth } from '@elv/data';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Options for {@link useImportHealth}. */
export interface UseImportHealthOptions {
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly externalRefreshToken: number;
}

/** Reactive failed-refresh health state and retry handler for {@link CachedCatalogStrip} (`#141`). */
export interface ImportHealthState {
  readonly health: readonly SourceImportHealth[];
  readonly retrying: boolean;
  readonly retryFailedSources: () => void;
}

/**
 * Tracks sources whose latest catalog refresh failed while cached SQLite rows remain browsable
 * (`#141`), exposing a non-blocking retry action for `CachedCatalogStrip`.
 */
export function useImportHealth({
  catalog,
  refreshToken,
  externalRefreshToken,
}: UseImportHealthOptions): ImportHealthState {
  const [health, setHealth] = useState<readonly SourceImportHealth[]>([]);
  const [retrying, setRetrying] = useState(false);
  const mountedRef = useRef(true);
  const retryingRef = useRef(false);
  const healthRef = useRef(health);
  healthRef.current = health;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh tokens re-query import health after imports
  useEffect(() => {
    let cancelled = false;
    const query = catalog.latestImportHealth;
    if (!query) {
      setHealth([]);
      return;
    }
    void query()
      .then((rows) => {
        if (!cancelled && mountedRef.current) setHealth(rows);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalog, refreshToken, externalRefreshToken]);

  const retryFailedSources = useCallback(() => {
    if (retryingRef.current) return;
    const failedIds = [...new Set(healthRef.current.map((entry) => entry.sourceId))];
    if (failedIds.length === 0) return;
    retryingRef.current = true;
    setRetrying(true);
    void (async () => {
      try {
        for (const sourceId of failedIds) {
          await catalog.importSource(sourceId);
        }
        const refreshed = (await catalog.latestImportHealth?.()) ?? [];
        if (mountedRef.current) setHealth(refreshed);
      } catch {
        // Leave existing cached health banner visible on unexpected errors
      } finally {
        retryingRef.current = false;
        if (mountedRef.current) setRetrying(false);
      }
    })();
  }, [catalog]);

  return { health, retrying, retryFailedSources };
}

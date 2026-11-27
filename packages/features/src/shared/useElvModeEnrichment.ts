import type { CatalogService, ElvItemEnrichment } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** Max unmatched visible keys sent per priority viewport enrichment batch (`#511`). */
const ELV_PRIORITY_ENRICH_CAP = 40;

const EMPTY_ENRICHMENT_MAP: ReadonlyMap<string, ElvItemEnrichment> = new Map();
const EMPTY_RESOLVED_KEYS: ReadonlySet<string> = new Set();

/** Options for {@link useElvEnrichmentForKeys}. */
export interface UseElvEnrichmentForKeysOptions {
  readonly enabled: boolean;
  readonly lang: string;
  readonly catalogRevision?: number;
}

/** Return value of {@link useElvEnrichmentForKeys} (`#511`). */
export interface UseElvEnrichmentForKeysResult {
  readonly enrichmentByKey: ReadonlyMap<string, ElvItemEnrichment>;
  /** Keys whose initial local SQLite `getElvEnrichmentForKeys` lookup has settled. */
  readonly resolvedKeys: ReadonlySet<string>;
  /**
   * Returns `true` while `enabled` is true, the catalog supports local enrichment lookup,
   * and `key`'s initial `< 2ms` SQLite lookup has not settled yet (so cards keep `poster: null`
   * instead of firing a throwaway raw IPTV poster HTTP request).
   */
  readonly isKeyLookupPending: (key: string) => boolean;
}

/** Options for {@link useElvBackgroundMatcher}. */
export interface UseElvBackgroundMatcherOptions {
  readonly enabled: boolean;
  readonly lang: string;
  readonly catalogRevision: number;
}

interface ScopedEnrichmentState {
  readonly scopeId: number;
  readonly enrichmentByKey: ReadonlyMap<string, ElvItemEnrichment>;
  readonly resolvedKeys: ReadonlySet<string>;
}

/**
 * Zero-wait batched local enrichment hydration for visible catalog cards (`#511`):
 * - Performs one indexed `getElvEnrichmentForKeys(keys)` lookup against `elv-enrichment.db`.
 * - Tracks `resolvedKeys` so callers suppress raw IPTV posters (`poster: null`) until the
 *   `< 2ms` local lookup settles, preventing double HTTP poster fetches.
 * - Clears stale enrichment and resolved-key state whenever `catalog`, `catalogRevision`, or
 *   `lang` changes.
 * - For up to 40 missing visible keys, triggers `enrichElvPriorityKeys` in the background and
 *   merges newly matched entries seamlessly as they land.
 */
export function useElvEnrichmentForKeys(
  catalog: Partial<Pick<CatalogService, 'getElvEnrichmentForKeys' | 'enrichElvPriorityKeys'>>,
  keys: readonly string[],
  options: UseElvEnrichmentForKeysOptions,
): UseElvEnrichmentForKeysResult {
  const { enabled, lang, catalogRevision = 0 } = options;
  const hasLookup = catalog.getElvEnrichmentForKeys !== undefined;

  const uniqueKeys = useMemo(() => {
    if (!enabled || keys.length === 0) return [] as string[];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of keys) {
      if (k !== '' && !seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
    return out;
  }, [enabled, keys]);

  const keysSignature = useMemo(() => uniqueKeys.join('\u0001'), [uniqueKeys]);
  const [scopedState, setScopedState] = useState<ScopedEnrichmentState>({
    scopeId: 0,
    enrichmentByKey: EMPTY_ENRICHMENT_MAP,
    resolvedKeys: EMPTY_RESOLVED_KEYS,
  });

  const attemptedKeysRef = useRef<Set<string>>(new Set());
  const lastScopeRef = useRef<{
    catalog: unknown;
    catalogRevision: number;
    lang: string;
    scopeId: number;
  }>({
    catalog,
    catalogRevision,
    lang,
    scopeId: 0,
  });

  if (
    lastScopeRef.current.catalog !== catalog ||
    lastScopeRef.current.catalogRevision !== catalogRevision ||
    lastScopeRef.current.lang !== lang
  ) {
    lastScopeRef.current = {
      catalog,
      catalogRevision,
      lang,
      scopeId: lastScopeRef.current.scopeId + 1,
    };
    attemptedKeysRef.current = new Set();
  }
  const currentScopeId = lastScopeRef.current.scopeId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: keysSignature tracks uniqueKeys deterministically without array identity churn
  useEffect(() => {
    setScopedState((prev) =>
      prev.scopeId === currentScopeId && (enabled || prev.enrichmentByKey.size === 0)
        ? prev
        : {
            scopeId: currentScopeId,
            enrichmentByKey: EMPTY_ENRICHMENT_MAP,
            resolvedKeys: EMPTY_RESOLVED_KEYS,
          },
    );

    if (!enabled || uniqueKeys.length === 0 || catalog.getElvEnrichmentForKeys === undefined) {
      return undefined;
    }

    let cancelled = false;
    const ac = new AbortController();
    const getEnrichment = catalog.getElvEnrichmentForKeys;
    const enrichPriority = catalog.enrichElvPriorityKeys;

    const commitLocal = (
      incoming: ReadonlyMap<string, ElvItemEnrichment>,
      settledKeys?: readonly string[],
    ) => {
      setScopedState((prev) => {
        const baseMap =
          prev.scopeId === currentScopeId ? prev.enrichmentByKey : EMPTY_ENRICHMENT_MAP;
        const baseResolved =
          prev.scopeId === currentScopeId ? prev.resolvedKeys : EMPTY_RESOLVED_KEYS;

        let mapChanged = prev.scopeId !== currentScopeId;
        let nextMap = baseMap;
        if (incoming.size > 0) {
          const mutableMap = new Map(baseMap);
          for (const [k, v] of incoming) {
            if (mutableMap.get(k) !== v) {
              mutableMap.set(k, v);
              mapChanged = true;
            }
          }
          if (mapChanged) nextMap = mutableMap;
        }

        let resolvedChanged = prev.scopeId !== currentScopeId;
        let nextResolved = baseResolved;
        if (settledKeys !== undefined && settledKeys.length > 0) {
          let needsAdd = false;
          for (const k of settledKeys) {
            if (!baseResolved.has(k)) {
              needsAdd = true;
              break;
            }
          }
          if (needsAdd) {
            const mutableResolved = new Set(baseResolved);
            for (const k of settledKeys) mutableResolved.add(k);
            nextResolved = mutableResolved;
            resolvedChanged = true;
          }
        }

        if (!mapChanged && !resolvedChanged) return prev;
        return {
          scopeId: currentScopeId,
          enrichmentByKey: nextMap,
          resolvedKeys: nextResolved,
        };
      });
    };

    void (async () => {
      try {
        const localMap = await getEnrichment(uniqueKeys);
        if (cancelled) return;
        commitLocal(localMap, uniqueKeys);

        if (enrichPriority === undefined) return;
        const missing: string[] = [];
        for (const k of uniqueKeys) {
          if (!localMap.has(k) && !attemptedKeysRef.current.has(k)) {
            missing.push(k);
            if (missing.length >= ELV_PRIORITY_ENRICH_CAP) break;
          }
        }
        if (missing.length === 0) return;
        for (const k of missing) attemptedKeysRef.current.add(k);

        const summary = await enrichPriority(missing, { lang, signal: ac.signal });
        if (cancelled || summary.aborted) return;
        if (summary.layer1Matched + summary.remoteMatched > 0) {
          const refreshed = await getEnrichment(missing);
          if (!cancelled) commitLocal(refreshed);
        }
      } catch {
        // Best-effort enrichment: mark lookup settled so raw catalog artwork loads cleanly.
        if (!cancelled) commitLocal(EMPTY_ENRICHMENT_MAP, uniqueKeys);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [catalog, catalogRevision, currentScopeId, enabled, keysSignature, lang]);

  const activeEnrichmentByKey =
    enabled && scopedState.scopeId === currentScopeId
      ? scopedState.enrichmentByKey
      : EMPTY_ENRICHMENT_MAP;
  const activeResolvedKeys =
    enabled && scopedState.scopeId === currentScopeId
      ? scopedState.resolvedKeys
      : EMPTY_RESOLVED_KEYS;

  const isKeyLookupPending = useCallback(
    (key: string): boolean => enabled && hasLookup && !activeResolvedKeys.has(key),
    [activeResolvedKeys, enabled, hasLookup],
  );

  return useMemo<UseElvEnrichmentForKeysResult>(
    () => ({
      enrichmentByKey: activeEnrichmentByKey,
      resolvedKeys: activeResolvedKeys,
      isKeyLookupPending,
    }),
    [activeEnrichmentByKey, activeResolvedKeys, isKeyLookupPending],
  );
}

/**
 * Runs incremental ELV Mode background matching once per `catalogRevision` when ELV Mode
 * metadata enrichment is enabled, cancelling cleanly on disable or unmount (`#511`).
 */
export function useElvBackgroundMatcher(
  catalog: Partial<Pick<CatalogService, 'runElvBackgroundMatching'>>,
  options: UseElvBackgroundMatcherOptions,
): void {
  const { enabled, lang, catalogRevision } = options;
  const completedSigRef = useRef<{ catalog: unknown; sig: string } | null>(null);

  useEffect(() => {
    if (!enabled || catalog.runElvBackgroundMatching === undefined) return undefined;
    const sig = `${catalogRevision}:${lang}`;
    if (completedSigRef.current?.catalog === catalog && completedSigRef.current.sig === sig) {
      return undefined;
    }

    const ac = new AbortController();
    const runMatcher = catalog.runElvBackgroundMatching;

    void Promise.resolve()
      .then(() => runMatcher({ lang, signal: ac.signal }))
      .then((summary) => {
        if (!ac.signal.aborted && !summary.aborted) {
          completedSigRef.current = { catalog, sig };
        }
      })
      .catch(() => undefined);

    return () => {
      ac.abort();
    };
  }, [catalog, catalogRevision, enabled, lang]);
}

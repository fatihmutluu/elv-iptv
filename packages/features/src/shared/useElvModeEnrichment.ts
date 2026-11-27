import type { CatalogService, ElvItemEnrichment } from '@elv/data';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCatalogUiCache } from './CatalogUiCacheProvider';
import {
  type CatalogUiCache,
  type ElvEnrichmentCacheSnapshot,
  MAX_ELV_ENRICHMENT_ENTRIES,
} from './catalog-ui-cache';

/** Max unmatched visible keys sent per priority viewport enrichment batch (`#511`). */
const ELV_PRIORITY_ENRICH_CAP = 40;

const EMPTY_ENRICHMENT_MAP: ReadonlyMap<string, ElvItemEnrichment> = new Map();
const EMPTY_RESOLVED_KEYS: ReadonlySet<string> = new Set();

interface CatalogFallbackEnrichmentStore {
  lang: string;
  readonly entries: Map<string, ElvItemEnrichment | null>;
}

interface AttemptedScopeState {
  lang: string;
  catalogRevision: number;
  readonly keys: Set<string>;
}

const catalogIdWeakMap = new WeakMap<object, number>();
let nextCatalogId = 1;

function getCatalogIdentity(catalog: object): number {
  let id = catalogIdWeakMap.get(catalog);
  if (id === undefined) {
    id = nextCatalogId++;
    catalogIdWeakMap.set(catalog, id);
  }
  return id;
}

const fallbackStoreByCatalog = new WeakMap<object, CatalogFallbackEnrichmentStore>();
const attemptedByCacheTarget = new WeakMap<object, AttemptedScopeState>();

function getOrCreateAttemptedSet(
  target: object,
  lang: string,
  catalogRevision: number,
): Set<string> {
  const existing = attemptedByCacheTarget.get(target);
  if (
    existing !== undefined &&
    existing.lang === lang &&
    existing.catalogRevision === catalogRevision
  ) {
    return existing.keys;
  }
  const fresh: AttemptedScopeState = { lang, catalogRevision, keys: new Set<string>() };
  attemptedByCacheTarget.set(target, fresh);
  return fresh.keys;
}

function readFallbackEnrichment(
  catalog: object,
  lang: string,
  keys: readonly string[],
): ElvEnrichmentCacheSnapshot {
  const store = fallbackStoreByCatalog.get(catalog);
  if (store === undefined || store.lang !== lang || keys.length === 0) {
    return { enrichmentByKey: EMPTY_ENRICHMENT_MAP, resolvedKeys: EMPTY_RESOLVED_KEYS };
  }
  const enrichmentByKey = new Map<string, ElvItemEnrichment>();
  const resolvedKeys = new Set<string>();
  for (const key of keys) {
    if (!store.entries.has(key)) continue;
    const hit = store.entries.get(key) ?? null;
    // Touch LRU order
    store.entries.delete(key);
    store.entries.set(key, hit);
    resolvedKeys.add(key);
    if (hit !== null) {
      enrichmentByKey.set(key, hit);
    }
  }
  if (resolvedKeys.size === 0) {
    return { enrichmentByKey: EMPTY_ENRICHMENT_MAP, resolvedKeys: EMPTY_RESOLVED_KEYS };
  }
  return { enrichmentByKey, resolvedKeys };
}

function writeFallbackEnrichment(
  catalog: object,
  lang: string,
  entries: ReadonlyMap<string, ElvItemEnrichment>,
  resolvedKeys?: readonly string[],
): void {
  let store = fallbackStoreByCatalog.get(catalog);
  if (store === undefined || store.lang !== lang) {
    store = { lang, entries: new Map() };
    fallbackStoreByCatalog.set(catalog, store);
  }
  const touchSet = (key: string, val: ElvItemEnrichment | null) => {
    if (key === '') return;
    if (store.entries.has(key)) {
      store.entries.delete(key);
    }
    store.entries.set(key, val);
    while (store.entries.size > MAX_ELV_ENRICHMENT_ENTRIES) {
      const oldest = store.entries.keys().next().value;
      if (oldest === undefined) break;
      store.entries.delete(oldest);
    }
  };
  if (resolvedKeys !== undefined) {
    for (const key of resolvedKeys) {
      touchSet(key, entries.get(key) ?? null);
    }
  }
  for (const [key, val] of entries) {
    touchSet(key, val);
  }
}

function readWarmEnrichment(
  uiCache: CatalogUiCache | null,
  catalog: object,
  lang: string,
  keys: readonly string[],
): ElvEnrichmentCacheSnapshot {
  if (keys.length === 0) {
    return { enrichmentByKey: EMPTY_ENRICHMENT_MAP, resolvedKeys: EMPTY_RESOLVED_KEYS };
  }
  if (uiCache?.getElvEnrichmentSnapshot !== undefined && uiCache.getLocale() === lang) {
    return uiCache.getElvEnrichmentSnapshot(keys);
  }
  return readFallbackEnrichment(catalog, lang, keys);
}

function writeWarmEnrichment(
  uiCache: CatalogUiCache | null,
  catalog: object,
  lang: string,
  entries: ReadonlyMap<string, ElvItemEnrichment>,
  resolvedKeys?: readonly string[],
): void {
  if (uiCache?.setElvEnrichmentBatch !== undefined && uiCache.getLocale() === lang) {
    uiCache.setElvEnrichmentBatch(entries, resolvedKeys);
    return;
  }
  writeFallbackEnrichment(catalog, lang, entries, resolvedKeys);
}

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
  readonly scopeIdentity: string;
  readonly enrichmentByKey: ReadonlyMap<string, ElvItemEnrichment>;
  readonly resolvedKeys: ReadonlySet<string>;
}

/**
 * Zero-wait batched local enrichment hydration for visible catalog cards (`#511`):
 * - Performs one indexed `getElvEnrichmentForKeys(keys)` lookup against `elv-enrichment.db`.
 * - Hydrates synchronously on mount from bounded `CatalogUiCache` (1,500-entry LRU) or a
 *   `catalog`+`lang`-scoped `WeakMap` cache so tab remounts render with zero pending flash.
 * - Preserves previously resolved `enrichmentByKey` / `resolvedKeys` across `catalogRevision`
 *   bumps (`stale-while-revalidate`) while fresh SQLite enrichment runs in the background.
 * - Clears stale enrichment cleanly whenever `catalog`, `lang`, or `enabled` turns off.
 * - For up to 40 missing visible keys, triggers `enrichElvPriorityKeys` in the background and
 *   merges newly matched entries seamlessly as they land.
 */
export function useElvEnrichmentForKeys(
  catalog: Partial<Pick<CatalogService, 'getElvEnrichmentForKeys' | 'enrichElvPriorityKeys'>>,
  keys: readonly string[],
  options: UseElvEnrichmentForKeysOptions,
): UseElvEnrichmentForKeysResult {
  const { enabled, lang, catalogRevision = 0 } = options;
  const uiCache = useCatalogUiCache();
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
  const scopeIdentity = `${getCatalogIdentity(catalog)}:${lang}`;

  const [scopedState, setScopedState] = useState<ScopedEnrichmentState>(() => {
    if (!enabled || !hasLookup || uniqueKeys.length === 0) {
      return {
        scopeIdentity,
        enrichmentByKey: EMPTY_ENRICHMENT_MAP,
        resolvedKeys: EMPTY_RESOLVED_KEYS,
      };
    }
    const warm = readWarmEnrichment(uiCache, catalog, lang, uniqueKeys);
    return {
      scopeIdentity,
      enrichmentByKey: warm.enrichmentByKey,
      resolvedKeys: warm.resolvedKeys,
    };
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: keysSignature tracks uniqueKeys deterministically without array identity churn
  useEffect(() => {
    if (!enabled) {
      setScopedState((prev) =>
        prev.scopeIdentity === scopeIdentity && prev.enrichmentByKey.size === 0
          ? prev
          : {
              scopeIdentity,
              enrichmentByKey: EMPTY_ENRICHMENT_MAP,
              resolvedKeys: EMPTY_RESOLVED_KEYS,
            },
      );
      return undefined;
    }

    // Reset immediately when catalog or lang changes, hydrating any warm hit for the new scope
    setScopedState((prev) => {
      if (prev.scopeIdentity === scopeIdentity) return prev;
      const warm =
        hasLookup && uniqueKeys.length > 0
          ? readFallbackEnrichment(catalog, lang, uniqueKeys)
          : { enrichmentByKey: EMPTY_ENRICHMENT_MAP, resolvedKeys: EMPTY_RESOLVED_KEYS };
      return {
        scopeIdentity,
        enrichmentByKey: warm.enrichmentByKey,
        resolvedKeys: warm.resolvedKeys,
      };
    });

    if (uniqueKeys.length === 0 || catalog.getElvEnrichmentForKeys === undefined) {
      return undefined;
    }

    let cancelled = false;
    const ac = new AbortController();
    const getEnrichment = catalog.getElvEnrichmentForKeys;
    const enrichPriority = catalog.enrichElvPriorityKeys;
    const attemptedKeys = getOrCreateAttemptedSet(uiCache ?? catalog, lang, catalogRevision);

    const commitLocal = (
      incoming: ReadonlyMap<string, ElvItemEnrichment>,
      settledKeys?: readonly string[],
    ) => {
      writeWarmEnrichment(uiCache, catalog, lang, incoming, settledKeys);
      setScopedState((prev) => {
        const baseMap =
          prev.scopeIdentity === scopeIdentity ? prev.enrichmentByKey : EMPTY_ENRICHMENT_MAP;
        const baseResolved =
          prev.scopeIdentity === scopeIdentity ? prev.resolvedKeys : EMPTY_RESOLVED_KEYS;

        let mapChanged = prev.scopeIdentity !== scopeIdentity;
        const mutableMap = new Map(baseMap);
        if (settledKeys !== undefined) {
          for (const k of settledKeys) {
            const nextVal = incoming.get(k);
            if (nextVal !== undefined) {
              if (mutableMap.get(k) !== nextVal) {
                mutableMap.set(k, nextVal);
                mapChanged = true;
              }
            } else if (mutableMap.has(k)) {
              mutableMap.delete(k);
              mapChanged = true;
            }
          }
        } else {
          for (const [k, v] of incoming) {
            if (mutableMap.get(k) !== v) {
              mutableMap.set(k, v);
              mapChanged = true;
            }
          }
        }
        const nextMap = mapChanged ? mutableMap : baseMap;

        let resolvedChanged = prev.scopeIdentity !== scopeIdentity;
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
          scopeIdentity,
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
          if (!localMap.has(k) && !attemptedKeys.has(k)) {
            missing.push(k);
            if (missing.length >= ELV_PRIORITY_ENRICH_CAP) break;
          }
        }
        if (missing.length === 0) return;
        for (const k of missing) attemptedKeys.add(k);

        const summary = await enrichPriority(missing, { lang, signal: ac.signal });
        if (cancelled || summary.aborted) return;
        if (summary.layer1Matched + summary.remoteMatched > 0) {
          const refreshed = await getEnrichment(missing);
          if (!cancelled) commitLocal(refreshed);
        }
      } catch {
        // Best-effort enrichment: mark lookup settled so raw catalog artwork loads cleanly without dropping cached entries.
        if (!cancelled) {
          setScopedState((prev) => {
            const baseMap =
              prev.scopeIdentity === scopeIdentity ? prev.enrichmentByKey : EMPTY_ENRICHMENT_MAP;
            const baseResolved =
              prev.scopeIdentity === scopeIdentity ? prev.resolvedKeys : EMPTY_RESOLVED_KEYS;
            const nextResolved = new Set(baseResolved);
            for (const k of uniqueKeys) nextResolved.add(k);
            return {
              scopeIdentity,
              enrichmentByKey: baseMap,
              resolvedKeys: nextResolved,
            };
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [catalog, catalogRevision, enabled, hasLookup, keysSignature, lang, scopeIdentity, uiCache]);

  // Synchronously merge warm cache hits for any newly visible keys not yet committed to scopedState
  const warmMerge = useMemo<ElvEnrichmentCacheSnapshot>(() => {
    if (!enabled || !hasLookup || uniqueKeys.length === 0) {
      return { enrichmentByKey: EMPTY_ENRICHMENT_MAP, resolvedKeys: EMPTY_RESOLVED_KEYS };
    }
    const baseMatched = scopedState.scopeIdentity === scopeIdentity;
    const baseMap = baseMatched ? scopedState.enrichmentByKey : EMPTY_ENRICHMENT_MAP;
    const baseResolved = baseMatched ? scopedState.resolvedKeys : EMPTY_RESOLVED_KEYS;

    const missingFromState: string[] = [];
    for (const k of uniqueKeys) {
      if (!baseResolved.has(k)) missingFromState.push(k);
    }
    if (missingFromState.length === 0) {
      return { enrichmentByKey: baseMap, resolvedKeys: baseResolved };
    }

    const warm = baseMatched
      ? readWarmEnrichment(uiCache, catalog, lang, missingFromState)
      : readFallbackEnrichment(catalog, lang, missingFromState);
    if (warm.resolvedKeys.size === 0) {
      return { enrichmentByKey: baseMap, resolvedKeys: baseResolved };
    }

    const mergedMap = new Map(baseMap);
    for (const [k, v] of warm.enrichmentByKey) mergedMap.set(k, v);
    const mergedResolved = new Set(baseResolved);
    for (const k of warm.resolvedKeys) mergedResolved.add(k);
    return { enrichmentByKey: mergedMap, resolvedKeys: mergedResolved };
  }, [
    catalog,
    enabled,
    hasLookup,
    lang,
    scopedState.enrichmentByKey,
    scopedState.resolvedKeys,
    scopedState.scopeIdentity,
    scopeIdentity,
    uiCache,
    uniqueKeys,
  ]);

  const activeEnrichmentByKey = warmMerge.enrichmentByKey;
  const activeResolvedKeys = warmMerge.resolvedKeys;

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

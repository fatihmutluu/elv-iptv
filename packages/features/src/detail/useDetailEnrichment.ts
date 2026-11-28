import type {
  CatalogService,
  ElvFranchiseLibraryItem,
  ElvTitleRecord,
  VodEnrichmentRecord,
} from '@elv/data';
import type { ElvModePreferences } from '@elv/domain';
import { type MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';
import { type DetailTarget, useElvEnrichmentForKeys } from '../shared';

/** Options for {@link useDetailEnrichment}. */
export interface UseDetailEnrichmentOptions {
  readonly catalog: CatalogService;
  readonly target: DetailTarget;
  readonly elvPrefs: ElvModePreferences;
  readonly elvEnrichActive: boolean;
  readonly vodEnrichmentEnabled: boolean;
  readonly locale: string;
  readonly refreshToken: number;
  readonly mountedRef: MutableRefObject<boolean>;
}

/** Optional ELV Mode title/franchise enrichment and key-free VOD enrichment for {@link useDetailData}. */
export function useDetailEnrichment({
  catalog,
  target,
  elvPrefs,
  elvEnrichActive,
  vodEnrichmentEnabled,
  locale,
  refreshToken,
  mountedRef,
}: UseDetailEnrichmentOptions) {
  const [enrichment, setEnrichment] = useState<VodEnrichmentRecord | null>(null);
  const [elvTitleDetail, setElvTitleDetail] = useState<ElvTitleRecord | null>(null);
  const [franchiseItems, setFranchiseItems] = useState<readonly ElvFranchiseLibraryItem[]>([]);
  const prevItemKeyRef = useRef(target.itemKey);

  useEffect(() => {
    if (prevItemKeyRef.current !== target.itemKey) {
      prevItemKeyRef.current = target.itemKey;
      setEnrichment(null);
      setElvTitleDetail(null);
      setFranchiseItems([]);
    }
  }, [target.itemKey]);

  const elvTargetKeys = useMemo(() => [target.itemKey], [target.itemKey]);
  const elvEnrichment = useElvEnrichmentForKeys(catalog, elvTargetKeys, {
    enabled: elvEnrichActive,
    lang: locale,
    catalogRevision: refreshToken,
  });
  const elvItemEnrichment = elvEnrichment.enrichmentByKey.get(target.itemKey);
  const elvPosterLookupPending =
    elvEnrichActive && elvEnrichment.isKeyLookupPending(target.itemKey);
  const matchedImdbId = elvItemEnrichment?.imdbId ?? null;

  useEffect(() => {
    if (!elvEnrichActive || matchedImdbId === null || catalog.getElvTitleDetail === undefined) {
      setElvTitleDetail(null);
      return undefined;
    }
    let cancelled = false;
    const ac = new AbortController();
    void catalog
      .getElvTitleDetail(matchedImdbId, { lang: locale, signal: ac.signal })
      .then((rec) => {
        if (!cancelled && mountedRef.current && rec !== null) setElvTitleDetail(rec);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [catalog, elvEnrichActive, locale, matchedImdbId, mountedRef]);

  useEffect(() => {
    if (
      !elvPrefs.elvModeEnabled ||
      matchedImdbId === null ||
      catalog.listElvFranchiseItems === undefined
    ) {
      setFranchiseItems([]);
      return undefined;
    }
    let cancelled = false;
    void catalog
      .listElvFranchiseItems(matchedImdbId)
      .then((rows) => {
        if (!cancelled && mountedRef.current) setFranchiseItems(rows);
      })
      .catch(() => {
        if (!cancelled && mountedRef.current) setFranchiseItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [catalog, elvPrefs.elvModeEnabled, matchedImdbId, mountedRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken triggers opt-in enrichment refresh on source sync
  useEffect(() => {
    if (vodEnrichmentEnabled !== true) {
      setEnrichment(null);
      return undefined;
    }
    if (target.kind !== 'movie' && target.kind !== 'series') return undefined;
    if (typeof catalog.enrichVodItem !== 'function') return undefined;
    let cancelled = false;
    void catalog
      .enrichVodItem(target.itemKey, { enabled: true })
      .then((record) => {
        if (!cancelled && mountedRef.current) setEnrichment(record);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [catalog, mountedRef, refreshToken, target.itemKey, target.kind, vodEnrichmentEnabled]);

  const activeElvTitle = elvEnrichActive
    ? (elvTitleDetail ?? elvItemEnrichment?.title ?? null)
    : null;

  return {
    enrichment,
    activeElvTitle,
    elvPosterLookupPending,
    matchedImdbId,
    franchiseItems,
  };
}

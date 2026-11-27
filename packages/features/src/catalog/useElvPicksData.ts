import type { CatalogService, ElvRecommendedItem, ItemRow, WatchProgressRow } from '@elv/data';
import type { ElvModePreferences } from '@elv/domain';
import type { AppI18n } from '@elv/i18n';
import { useEffect, useMemo, useState } from 'react';
import {
  applyElvCardPresentation,
  batchLoadProgressByKeys,
  buildElvCacheFingerprint,
  useProfile,
} from '../shared';
import { formatElvRecommendationReason } from './elv-genre-label';

const ELV_PICKS_LIMIT = 30;

/** One ELV Picks poster entry paired with its localized explainability reason badge (`#512`). */
interface PresentedElvPick {
  readonly item: ItemRow;
  readonly reasonLabel: string;
}

/** Options for {@link useElvPicksData}. */
export interface UseElvPicksDataOptions {
  readonly enabled: boolean;
  readonly kind: 'movie' | 'series';
  readonly catalog: CatalogService;
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly localRefreshTick: number;
  readonly elvPrefs: ElvModePreferences;
  readonly i18n: AppI18n;
}

/** State returned by {@link useElvPicksData}. */
export interface ElvPicksDataState {
  readonly picks: readonly PresentedElvPick[];
  readonly loaded: boolean;
  readonly progressByKey: ReadonlyMap<string, WatchProgressRow>;
}

/**
 * Loads reactive, zero-blink `ELV Picks` recommendations (`profile: 'elv_picks'`, `limit: 30`)
 * for the Movies or Series quick-filter sub-tab, keeping previously rendered picks visible across
 * background refreshes (`#512`).
 */
export function useElvPicksData({
  enabled,
  kind,
  catalog,
  refreshToken,
  userStateVersion,
  localRefreshTick,
  elvPrefs,
  i18n,
}: UseElvPicksDataOptions): ElvPicksDataState {
  const { activeProfileId } = useProfile();
  const elvFingerprint = useMemo(() => buildElvCacheFingerprint(elvPrefs), [elvPrefs]);

  const [rawPicks, setRawPicks] = useState<readonly ElvRecommendedItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [progressByKey, setProgressByKey] = useState<ReadonlyMap<string, WatchProgressRow>>(
    () => new Map(),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken, userStateVersion, localRefreshTick, and elvFingerprint trigger reactive recommendation refreshes
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    if (typeof catalog.getElvRecommendations !== 'function') {
      setRawPicks([]);
      setLoaded(true);
      return undefined;
    }

    void catalog
      .getElvRecommendations({
        profile: 'elv_picks',
        kind,
        profileId: activeProfileId,
        limit: ELV_PICKS_LIMIT,
      })
      .then(async (rows) => {
        if (cancelled) return;
        setRawPicks(rows);
        setLoaded(true);
        const keys = rows.map((entry) => entry.item.key);
        if (keys.length > 0) {
          const prog = await batchLoadProgressByKeys(catalog, keys).catch(
            () => new Map<string, WatchProgressRow>(),
          );
          if (!cancelled) setProgressByKey(prog);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoaded(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeProfileId,
    catalog,
    elvFingerprint,
    enabled,
    kind,
    localRefreshTick,
    refreshToken,
    userStateVersion,
  ]);

  const picks = useMemo<readonly PresentedElvPick[]>(() => {
    if (!enabled || rawPicks.length === 0) return [];
    return rawPicks.map((entry) => ({
      item: applyElvCardPresentation(entry.item, entry.enrichment, elvPrefs, i18n.locale),
      reasonLabel: formatElvRecommendationReason(entry.reason, i18n.t),
    }));
  }, [elvPrefs, enabled, i18n, rawPicks]);

  return useMemo<ElvPicksDataState>(
    () => ({ picks, loaded, progressByKey }),
    [loaded, picks, progressByKey],
  );
}

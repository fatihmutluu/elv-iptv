import type { CatalogService, ElvRecommendedItem } from '@elv/data';
import type { ElvModePreferences } from '@elv/domain';
import { useEffect, useMemo, useRef, useState } from 'react';
import { buildElvCacheFingerprint, isElvFeatureActive } from '../shared';

const HOME_ELV_SHOWCASE_LIMIT = 24;
const EMPTY_RECOMMENDATIONS: readonly ElvRecommendedItem[] = [];

/** Options for {@link useHomeElvShowcase}. */
export interface UseHomeElvShowcaseOptions {
  readonly catalog: CatalogService;
  readonly sourcesCount: number;
  readonly refreshToken: number;
  readonly userStateVersion: number;
  readonly localRefreshTick: number;
  readonly activeProfileId: string;
  readonly elvPrefs: ElvModePreferences;
}

/**
 * Triggers non-blocking, session-deduped `refreshElvFeeds()` in the background and loads the
 * mixed Movies + Series Home Showcase recommendations (`profile: 'home'`, `limit: 24`) when
 * `elvModeEnabled && elvSmartRecommendations` is active (`#512`).
 */
export function useHomeElvShowcase({
  catalog,
  sourcesCount,
  refreshToken,
  userStateVersion,
  localRefreshTick,
  activeProfileId,
  elvPrefs,
}: UseHomeElvShowcaseOptions): readonly ElvRecommendedItem[] {
  const smartRecsActive = isElvFeatureActive(elvPrefs, 'elvSmartRecommendations');
  const elvFingerprint = useMemo(() => buildElvCacheFingerprint(elvPrefs), [elvPrefs]);

  const [recommendations, setRecommendations] =
    useState<readonly ElvRecommendedItem[]>(EMPTY_RECOMMENDATIONS);
  const [feedUpdatedTick, setFeedUpdatedTick] = useState(0);
  const feedRefreshedRef = useRef<{ catalog: unknown; refreshToken: number } | null>(null);

  useEffect(() => {
    if (!smartRecsActive || sourcesCount === 0 || typeof catalog.refreshElvFeeds !== 'function') {
      return undefined;
    }
    if (
      feedRefreshedRef.current?.catalog === catalog &&
      feedRefreshedRef.current.refreshToken === refreshToken
    ) {
      return undefined;
    }
    feedRefreshedRef.current = { catalog, refreshToken };

    let cancelled = false;
    void catalog
      .refreshElvFeeds()
      .then((updated) => {
        if (!cancelled && updated) {
          setFeedUpdatedTick((t) => t + 1);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [catalog, refreshToken, smartRecsActive, sourcesCount]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshToken, userStateVersion, localRefreshTick, feedUpdatedTick, and elvFingerprint trigger fresh recommendation reads
  useEffect(() => {
    if (
      !smartRecsActive ||
      sourcesCount === 0 ||
      typeof catalog.getElvRecommendations !== 'function'
    ) {
      setRecommendations(EMPTY_RECOMMENDATIONS);
      return undefined;
    }

    let cancelled = false;
    void catalog
      .getElvRecommendations({
        profile: 'home',
        profileId: activeProfileId,
        limit: HOME_ELV_SHOWCASE_LIMIT,
      })
      .then((rows) => {
        if (!cancelled) setRecommendations(rows);
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [
    activeProfileId,
    catalog,
    elvFingerprint,
    feedUpdatedTick,
    localRefreshTick,
    refreshToken,
    smartRecsActive,
    sourcesCount,
    userStateVersion,
  ]);

  return smartRecsActive ? recommendations : EMPTY_RECOMMENDATIONS;
}

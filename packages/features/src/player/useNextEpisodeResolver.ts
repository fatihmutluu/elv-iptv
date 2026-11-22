import type { CatalogService, NextEpisodeRow } from '@elv/data';
import { useEffect, useState } from 'react';
import type { PlayableEntry, PlayTarget } from '../ports/play-target';

/** Minimal catalog capability required by {@link useNextEpisodeResolver}. */
interface NextEpisodeCatalog {
  readonly queryNextEpisode?: CatalogService['queryNextEpisode'];
}

/** Parameters for {@link useNextEpisodeResolver}. */
export interface UseNextEpisodeResolverParams {
  readonly catalog: NextEpisodeCatalog | undefined;
  readonly activeTarget: PlayTarget;
  readonly profileId?: string;
}

/** Converts a cross-season {@link NextEpisodeRow} into a playable VOD episode entry (`#392`). */
export function mapNextEpisodeRowToPlayableEntry(
  row: NextEpisodeRow,
  activeTarget: Pick<PlayTarget, 'accountKey'>,
): PlayableEntry {
  const seasonEpisode =
    row.episode !== null && row.episode !== undefined
      ? `S${row.season} E${row.episode}`
      : undefined;
  const episodeTitle = row.title?.trim() || seasonEpisode || row.key;
  const seriesTitle = row.seriesTitle?.trim();
  const title = seriesTitle ? `${seriesTitle} — ${episodeTitle}` : episodeTitle;
  const subtitle = seasonEpisode ?? episodeTitle;

  return {
    itemKey: row.key,
    sourceId: row.sourceId,
    ...(activeTarget.accountKey !== undefined ? { accountKey: activeTarget.accountKey } : {}),
    title,
    subtitle,
    kind: 'vod',
    itemKind: 'episode',
    seriesKey: row.seriesKey,
    season: row.season,
    episode: row.episode,
    ...(row.logo !== null ? { logo: row.logo } : {}),
  };
}

/**
 * Resolves the next episode for a VOD series target (`#392`):
 * returns `activeTarget.nextEpisodes[0]` synchronously when already queued (zero DB query),
 * otherwise resolves across season boundaries via `catalog.queryNextEpisode` safely on item change.
 */
export function useNextEpisodeResolver(
  params: UseNextEpisodeResolverParams,
): PlayableEntry | undefined {
  const { catalog, activeTarget, profileId } = params;
  const inlineNext = activeTarget.kind === 'vod' ? activeTarget.nextEpisodes?.[0] : undefined;
  const queryNextEpisode = catalog?.queryNextEpisode;
  const seriesKey = activeTarget.kind === 'vod' ? activeTarget.seriesKey : undefined;
  const itemKey = activeTarget.itemKey;
  const accountKey = activeTarget.accountKey;

  const [resolved, setResolved] = useState<{
    readonly forItemKey: string;
    readonly entry: PlayableEntry | undefined;
  } | null>(null);

  useEffect(() => {
    if (inlineNext !== undefined || !seriesKey || queryNextEpisode === undefined) {
      setResolved(null);
      return;
    }

    let cancelled = false;
    setResolved(null);

    void queryNextEpisode(seriesKey, itemKey, profileId).then(
      (row) => {
        if (cancelled) return;
        const entry =
          row !== null
            ? mapNextEpisodeRowToPlayableEntry(row, accountKey !== undefined ? { accountKey } : {})
            : undefined;
        setResolved({ forItemKey: itemKey, entry });
      },
      () => {
        if (!cancelled) setResolved({ forItemKey: itemKey, entry: undefined });
      },
    );

    return () => {
      cancelled = true;
    };
  }, [accountKey, inlineNext, itemKey, profileId, queryNextEpisode, seriesKey]);

  if (inlineNext !== undefined) return inlineNext;
  return resolved?.forItemKey === itemKey ? resolved.entry : undefined;
}

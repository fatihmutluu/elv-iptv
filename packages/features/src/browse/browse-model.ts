import type { CategoryRow, EpisodeRow, ItemRow, SourceRow } from '@elv/data';
import type { ElvError } from '@elv/domain';
import type { AppI18n, MessageId } from '@elv/i18n';

/** Category row paired with its source-disambiguated display label. */
export interface DisplayCategory {
  readonly row: CategoryRow;
  readonly label: string;
}

/** Remembered seasons/episodes drilldown state inside the Series tab. */
export interface SeriesDetailState {
  readonly series: ItemRow;
  readonly selectedSeasonIndex: number;
  readonly selectedEpisodeIndex: number;
  readonly activePane?: 'seasons' | 'episodes';
}

/** Per-tab focus and drilldown memory preserved across tab switches and PlayerScreen visits. */
export interface TabBrowseMemory {
  readonly categoryId?: string;
  readonly categoryIndex: number;
  readonly itemIndex: number;
  readonly activePane?: 'categories' | 'items';
  readonly seriesDetail?: SeriesDetailState;
}

/** Default initial browse memory for any content tab. */
export const EMPTY_TAB_MEMORY: TabBrowseMemory = {
  categoryIndex: 0,
  itemIndex: 0,
};

/** Localized message and actionable hint for a browse/series read failure. */
export interface DescribedBrowseFailure {
  readonly messageId: MessageId;
  readonly hintId: MessageId;
}

/**
 * Flattens per-source category lists in `sources` order, prefixing `${source.name} — ` only when
 * more than one source is configured.
 */
export function buildDisplayCategories(
  sources: readonly SourceRow[],
  bySource: ReadonlyMap<string, readonly CategoryRow[]>,
): DisplayCategory[] {
  const multi = sources.length > 1;
  const out: DisplayCategory[] = [];
  for (const source of sources) {
    const rows = bySource.get(source.id) ?? [];
    for (const row of rows) {
      out.push({
        row,
        label: multi ? `${source.name} — ${row.name}` : row.name,
      });
    }
  }
  return out;
}

/** Resolves the active category index from `memory.categoryId` first, else clamped `categoryIndex`. */
export function resolveSelectedCategoryIndex(
  categories: readonly DisplayCategory[],
  memory: TabBrowseMemory,
): number {
  if (categories.length === 0) return 0;
  if (memory.categoryId !== undefined) {
    const byId = categories.findIndex((c) => c.row.id === memory.categoryId);
    if (byId >= 0) return byId;
  }
  return Math.min(Math.max(0, Math.floor(memory.categoryIndex)), categories.length - 1);
}

/** Formats a plain item title (`num. Name` for numbered live channels, `Name (year)` for dated VOD). */
export function formatItemTitle(item: ItemRow): string {
  if (item.kind === 'live' && item.num !== null) {
    return `${item.num}. ${item.name}`;
  }
  if ((item.kind === 'movie' || item.kind === 'series') && item.year !== null) {
    return `${item.name} (${item.year})`;
  }
  return item.name;
}

/** Formats localized episode list copy (`E1 · Title` / `Episode 1`) and full player OSD title. */
export function formatEpisodeLabel(
  episode: EpisodeRow,
  index: number,
  seriesName: string,
  t: AppI18n['t'],
): { readonly rowText: string; readonly playTitle: string } {
  const epNum = episode.episode ?? index + 1;
  const title = episode.title?.trim() ?? '';
  const rowText =
    title.length > 0
      ? t('series.episodeTitled', { episode: epNum, title })
      : t('series.episodeUntitled', { episode: epNum });
  return {
    rowText,
    playTitle: `${seriesName} — ${rowText}`,
  };
}

/** Maps a `CatalogService.seasons` error to localized copy and an actionable recovery hint. */
export function describeCatalogReadFailure(error: ElvError): DescribedBrowseFailure {
  if (error.category === 'auth') {
    if (
      error.code === 'invalid-credentials' ||
      error.code === 'http-401' ||
      error.code === 'http-403'
    ) {
      return {
        messageId: 'source.error.invalidCredentials',
        hintId: 'source.hint.invalidCredentials',
      };
    }
    return {
      messageId: 'source.error.accountExpired',
      hintId: 'source.hint.accountExpired',
    };
  }
  if (error.category === 'network') {
    if (error.code === 'rate-limited' || error.code === 'http-429' || error.code === 'http-509') {
      return {
        messageId: 'source.error.rateLimited',
        hintId: 'source.hint.rateLimited',
      };
    }
    if (error.code === 'timeout') {
      return {
        messageId: 'source.error.timeout',
        hintId: 'source.hint.timeout',
      };
    }
    return {
      messageId: 'source.error.unreachable',
      hintId: 'source.hint.unreachable',
    };
  }
  if (error.code === 'item-not-found' || error.code === 'http-404') {
    return {
      messageId: 'player.error.itemNotFound',
      hintId: 'player.hint.itemNotFound',
    };
  }
  return {
    messageId: 'source.error.storage',
    hintId: 'source.hint.storage',
  };
}

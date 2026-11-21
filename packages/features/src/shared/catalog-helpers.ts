import {
  type CatalogService,
  type CategoryRow,
  MIN_RESUME_POSITION_MS,
  type SourceRow,
  type WatchProgressRow,
} from '@elv/data';
import type { Theme, ViewportInfo } from '@elv/ui-kit';

/** Category row paired with its source-disambiguated display label. */
export interface DisplayCategory {
  readonly row: CategoryRow;
  readonly label: string;
}

/** Watch-status filter chips supported in Movies & Series discovery and grids (`#14`). */
export type WatchStatusFilter = 'all' | 'unwatched' | 'inProgress' | 'watched';

/** Responsive Cinema Quietude layout metrics shared across Catalog Discovery, Grids, and Detail. */
export interface CatalogLayoutMetrics {
  readonly isTv: boolean;
  readonly isTouch: boolean;
  readonly isPortrait: boolean;
  readonly padX: number;
  readonly railGap: number;
  readonly gridGap: number;
  readonly heroTopClearance: number;
  readonly posterRailWidth: number;
  readonly gridColumns: number;
  readonly gridCardWidth: number;
  readonly gridRowHeight: number;
  readonly visibleGridRows: number;
}

const MIN_CARD_WIDTH = 88;
const PROGRESS_BATCH_CHUNK = 100;

/**
 * Flattens per-source category lists in `sources` order, prefixing `${source.name} — ` only when
 * more than one source is configured.
 */
export function buildSharedDisplayCategories(
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

/** Formats crisp poster metadata (`2026 · ★ 8.6`) without third-party brand names. */
export function formatVodMeta(year: number | null, rating: number | null): string | undefined {
  const parts: string[] = [];
  if (year !== null && Number.isFinite(year)) parts.push(String(year));
  if (rating !== null && Number.isFinite(rating)) parts.push(`★ ${rating.toFixed(1)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** Evaluates whether a VOD item's watch progress matches the active {@link WatchStatusFilter}. */
export function matchesWatchStatus(
  progress: WatchProgressRow | undefined,
  filter: WatchStatusFilter,
): boolean {
  if (filter === 'all') return true;
  if (filter === 'watched') return progress?.watched === true;
  if (filter === 'inProgress') {
    return (
      progress !== undefined && !progress.watched && progress.positionMs >= MIN_RESUME_POSITION_MS
    );
  }
  return (
    progress === undefined || (!progress.watched && progress.positionMs < MIN_RESUME_POSITION_MS)
  );
}

/** Computes responsive peek/grid poster widths and fixed virtualized row heights from viewport tokens. */
export function computeCatalogLayout(viewport: ViewportInfo, theme: Theme): CatalogLayoutMetrics {
  const isTv = viewport.formFactor === 'tv';
  const isTouch = viewport.inputModality === 'touch';
  const isPortrait =
    viewport.orientation === 'portrait' &&
    viewport.formFactor !== 'tv' &&
    viewport.formFactor !== 'desktop';

  const safeWidth = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 1280;
  const safeHeight =
    Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 720;

  const padX = isTv
    ? Math.max(theme.spacing.xl, viewport.overscan.x)
    : isPortrait
      ? theme.spacing.md
      : theme.spacing.lg;
  const railGap = isPortrait ? 8 : 10;
  const gridGap = isTv ? 16 : isPortrait ? 10 : 12;
  const topInset = isTv
    ? Math.max(viewport.safeArea.top, viewport.overscan.y)
    : viewport.safeArea.top;
  const heroTopClearance = (!isPortrait ? (isTv ? 58 : 56) : 50) + topInset + 24;

  const available = Math.max(0, safeWidth - padX * 2);
  const railCols = Math.max(1, viewport.columns.posterRail);
  const posterRailWidth = Math.max(
    MIN_CARD_WIDTH,
    Math.floor((available - Math.max(0, railCols - 1) * railGap) / railCols),
  );

  const gridColumns = Math.max(1, Math.floor(viewport.columns.categoryGrid));
  const gridCardWidth = Math.max(
    MIN_CARD_WIDTH,
    Math.floor((available - Math.max(0, gridColumns - 1) * gridGap) / gridColumns),
  );
  const posterHeight = Math.round(gridCardWidth * 1.5);
  const textAndPad = isTv ? 68 : 54;
  const gridRowHeight = posterHeight + textAndPad + gridGap;
  const usableHeight = Math.max(gridRowHeight, safeHeight - heroTopClearance - 110);
  const visibleGridRows = Math.max(2, Math.ceil(usableHeight / gridRowHeight));

  return {
    isTv,
    isTouch,
    isPortrait,
    padX,
    railGap,
    gridGap,
    heroTopClearance,
    posterRailWidth,
    gridColumns,
    gridCardWidth,
    gridRowHeight,
    visibleGridRows,
  };
}

/**
 * Fetches watch-progress rows for a set of keys in bounded chunks (`<= 100` keys per query) so
 * IPC/SQLite variable limits are never exceeded and callers receive a fast `Map` lookup.
 */
export async function batchLoadProgressByKeys(
  catalog: Pick<CatalogService, 'listProgressByKeys'>,
  itemKeys: readonly string[],
): Promise<Map<string, WatchProgressRow>> {
  const out = new Map<string, WatchProgressRow>();
  if (!catalog.listProgressByKeys || itemKeys.length === 0) return out;
  const unique = [...new Set(itemKeys)];
  for (let i = 0; i < unique.length; i += PROGRESS_BATCH_CHUNK) {
    const chunk = unique.slice(i, i + PROGRESS_BATCH_CHUNK);
    const rows = await catalog.listProgressByKeys(chunk);
    for (const row of rows) out.set(row.itemKey, row);
  }
  return out;
}

/** Kinds a menu browses; stored as `kind` in `categories` and `placements`. */
export type BrowseKind = 'live' | 'movie' | 'series';

/** Largest page `items` and `queryAllSourcesItems` return. */
const MAX_PAGE = 500;

/** A live channel, movie or series in a category or multi-source view. */
export interface ItemRow {
  /** Row id in its table; the argument of `seasons` and `episodes` for a series. */
  id: number;
  /** Stable content key; the argument of `resolveStream`. */
  key: string;
  kind: BrowseKind;
  sourceId: string;
  providerId: string | null;
  name: string;
  /** Logo or cover as stored (an M3U template is resolved by the service). */
  logo: string | null;
  rating: number | null;
  year: number | null;
  /** Channel number (live only). */
  num: number | null;
}

/** @internal Raw SQLite item projection shared by category and multi-source browse queries. */
export interface RawItemRow {
  id: number;
  key: string;
  source_id?: string;
  provider_id: string | null;
  name: string;
  logo: string | null;
  rating: number | null;
  year: number | null;
  num: number | null;
}

/** @internal Columns per kind; fixed strings, never built from data. */
export const ITEM_COLS: Record<BrowseKind, string> = {
  live: 't.logo AS logo, NULL AS rating, NULL AS year, t.num AS num',
  movie: 't.logo AS logo, t.rating AS rating, t.year AS year, NULL AS num',
  series: 't.cover AS logo, t.rating AS rating, t.year AS year, NULL AS num',
};

/** @internal Backing catalog table per kind; fixed strings, never built from data. */
export const ITEM_TABLE: Record<BrowseKind, string> = {
  live: 'live',
  movie: 'movies',
  series: 'series',
};

/** @internal Clamps a page request; `limit` is 0 to {@link MAX_PAGE}, `offset` at least 0. */
export function clampPage(offset: number, limit: number): { offset: number; limit: number } {
  const whole = (n: number) => (Number.isFinite(n) ? Math.floor(n) : 0);
  return {
    offset: Math.max(0, whole(offset)),
    limit: Math.min(MAX_PAGE, Math.max(0, whole(limit))),
  };
}

/** @internal Maps a raw SQLite item row to {@link ItemRow}. */
export function mapItemRow(kind: BrowseKind, sourceId: string, r: RawItemRow): ItemRow {
  return {
    id: r.id,
    key: r.key,
    kind,
    sourceId: r.source_id ?? sourceId,
    providerId: r.provider_id,
    name: r.name,
    logo: r.logo,
    rating: r.rating,
    year: r.year,
    num: r.num,
  };
}

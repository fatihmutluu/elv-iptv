import { elvError, err, ok, type Result, type SqlDriver, type SqlValue } from '@elv/domain';
import { findRestrictedItemKeys, loadActiveParentalFilter } from './parental-repo';
import { resolveSafeStorageLogo } from './queries';
import {
  clampLimit,
  DEFAULT_PROFILE_ID,
  MAX_USER_LIST_LIMIT,
  normalizeProfileId,
  optFloat,
  optInt,
} from './user-state-helpers';

/** Supported personal rating values for Movies & Series. */
export type RatingValue = 'like' | 'dislike';

/** Supported catalog item kinds for personal ratings (strictly Movies & Series, never Live TV). */
export type RatingKind = 'movie' | 'series';

/** One row of the `ratings` table. */
export interface RatingRow {
  readonly profileId: string;
  readonly sourceId: string;
  readonly itemKey: string;
  readonly kind: RatingKind;
  readonly value: RatingValue;
  readonly title: string;
  readonly logo: string | null;
  readonly year: number | null;
  readonly rating: number | null;
  readonly updatedAt: number;
}

/** Input for {@link setItemRating}. */
export interface SetRatingInput {
  readonly profileId?: string;
  readonly sourceId: string;
  readonly itemKey: string;
  readonly kind: RatingKind;
  readonly title: string;
  readonly logo?: string | null;
  readonly year?: number | null;
  readonly rating?: number | null;
}

/** Filter options for {@link listRatings}. */
export interface ListRatingsOptions {
  readonly value?: RatingValue;
  readonly kind?: RatingKind;
  readonly limit?: number;
  readonly profileId?: string;
  readonly parentalUnlocked?: boolean;
}

/** Ratings methods exposed on `CatalogService`. */
export interface CatalogRatingsOpsMethods {
  setRating(input: SetRatingInput, value: RatingValue | null): Promise<Result<RatingValue | null>>;
  getRating(itemKey: string, profileId?: string): Promise<RatingValue | null>;
  listRatings(opts?: ListRatingsOptions): Promise<RatingRow[]>;
  listRatingMap(profileId?: string): Promise<Readonly<Record<string, RatingValue>>>;
}

interface RawRatingRow {
  profile_id: string;
  source_id: string;
  item_key: string;
  kind: RatingKind;
  value: RatingValue;
  title: string;
  logo: string | null;
  year: number | null;
  rating: number | null;
  updated_at: number;
}

const MAX_RATING_MAP_KEYS = 2_000;

function isRatingKind(raw: unknown): raw is RatingKind {
  return raw === 'movie' || raw === 'series';
}

function isRatingValue(raw: unknown): raw is RatingValue {
  return raw === 'like' || raw === 'dislike';
}

function mapRatingRow(r: RawRatingRow): RatingRow {
  return {
    profileId: r.profile_id,
    sourceId: r.source_id,
    itemKey: r.item_key,
    kind: r.kind,
    value: r.value,
    title: r.title,
    logo: r.logo,
    year: r.year,
    rating: r.rating,
    updatedAt: r.updated_at,
  };
}

const UPSERT_RATING_SQL = `INSERT INTO ratings (
  profile_id, source_id, item_key, kind, value, title, logo, year, rating, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(profile_id, item_key) DO UPDATE SET
  source_id = excluded.source_id,
  kind = excluded.kind,
  value = excluded.value,
  title = excluded.title,
  logo = excluded.logo,
  year = excluded.year,
  rating = excluded.rating,
  updated_at = excluded.updated_at`;

/**
 * Sets or clears a personal Like/Dislike rating for a Movie or Series.
 * Strictly rejects non-`'movie'`/`'series'` kinds (never Live TV).
 * Passing `value = null` deletes the rating row.
 */
export async function setItemRating(
  db: SqlDriver,
  input: SetRatingInput,
  value: RatingValue | null,
  clock: () => number = Date.now,
): Promise<Result<RatingValue | null>> {
  if (!isRatingKind(input.kind)) {
    return err(elvError('source-format', 'invalid-rating-kind'));
  }
  const itemKey = input.itemKey.trim();
  if (itemKey === '') {
    return err(elvError('source-format', 'invalid-rating'));
  }
  const profileId = normalizeProfileId(input.profileId);

  if (value === null) {
    await db.run('DELETE FROM ratings WHERE profile_id = ? AND item_key = ?', [profileId, itemKey]);
    return ok(null);
  }

  if (!isRatingValue(value)) {
    return err(elvError('source-format', 'invalid-rating-value'));
  }
  const sourceId = input.sourceId.trim();
  const title = input.title.trim();
  if (sourceId === '' || title === '') {
    return err(elvError('source-format', 'invalid-rating'));
  }

  const safeLogo = await resolveSafeStorageLogo(db, {
    sourceId,
    itemKey,
    kind: input.kind,
    ...(input.logo === undefined ? {} : { logo: input.logo }),
  });
  const updatedAt = Math.max(0, Math.round(clock()));

  await db.run(UPSERT_RATING_SQL, [
    profileId,
    sourceId,
    itemKey,
    input.kind,
    value,
    title,
    safeLogo,
    optInt(input.year),
    optFloat(input.rating),
    updatedAt,
  ]);

  return ok(value);
}

/** Reads the current personal rating (`'like' | 'dislike' | null`) for `(profileId, itemKey)`. */
export async function getItemRating(
  db: SqlDriver,
  itemKey: string,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<RatingValue | null> {
  const trimmed = itemKey.trim();
  if (trimmed === '') return null;
  const normalized = normalizeProfileId(profileId);
  const rows = await db.all<{ value: string }>(
    'SELECT value FROM ratings WHERE profile_id = ? AND item_key = ? LIMIT 1',
    [normalized, trimmed],
  );
  const raw = rows[0]?.value;
  return isRatingValue(raw) ? raw : null;
}

/**
 * Lists personal ratings for a profile ordered by `updated_at DESC, item_key ASC`.
 * Respects active parental locks and clamps `limit` to `0..250`.
 */
export async function listRatings(db: SqlDriver, opts?: ListRatingsOptions): Promise<RatingRow[]> {
  const clamped = clampLimit(opts?.limit, 50);
  if (clamped === 0) return [];
  if (opts?.value !== undefined && !isRatingValue(opts.value)) return [];
  if (opts?.kind !== undefined && !isRatingKind(opts.kind)) return [];
  const normalized = normalizeProfileId(opts?.profileId);
  const filter = await loadActiveParentalFilter(db, normalized, opts?.parentalUnlocked);
  const fetchLimit = filter === null ? clamped : Math.min(MAX_USER_LIST_LIMIT, clamped * 4);

  const params: SqlValue[] = [normalized];
  let filterClause = '';
  if (opts?.value !== undefined) {
    filterClause += ' AND value = ?';
    params.push(opts.value);
  }
  if (opts?.kind !== undefined) {
    filterClause += ' AND kind = ?';
    params.push(opts.kind);
  }
  params.push(fetchLimit);

  const rows = await db.all<RawRatingRow>(
    `SELECT profile_id, source_id, item_key, kind, value, title, logo, year, rating, updated_at
       FROM ratings
      WHERE profile_id = ?${filterClause}
      ORDER BY updated_at DESC, item_key ASC
      LIMIT ?`,
    params,
  );
  const mapped = rows.map(mapRatingRow);
  if (filter === null) return mapped;
  const restricted = await findRestrictedItemKeys(
    db,
    filter,
    rows.map((r) => ({
      itemKey: r.item_key,
      sourceId: r.source_id,
      kind: r.kind,
      title: r.title,
    })),
  );
  return mapped.filter((r) => !restricted.has(r.itemKey)).slice(0, clamped);
}

/** Lists a compact `itemKey -> 'like' | 'dislike'` map for a profile (capped at 2,000 entries). */
export async function listRatingMap(
  db: SqlDriver,
  profileId: string = DEFAULT_PROFILE_ID,
): Promise<Readonly<Record<string, RatingValue>>> {
  const normalized = normalizeProfileId(profileId);
  const rows = await db.all<{ item_key: string; value: string }>(
    `SELECT item_key, value
       FROM ratings
      WHERE profile_id = ?
      ORDER BY updated_at DESC, item_key ASC
      LIMIT ?`,
    [normalized, MAX_RATING_MAP_KEYS],
  );
  const out: Record<string, RatingValue> = {};
  for (const row of rows) {
    if (isRatingValue(row.value)) {
      out[row.item_key] = row.value;
    }
  }
  return out;
}

interface RatingsPlaytimeLike {
  resolveRowLogos<T extends { sourceId: string; logo: string | null }>(rows: T[]): Promise<T[]>;
}

/** @internal Creates ratings methods for `CatalogService`. */
export function createCatalogRatingsOpsMethods(deps: {
  db: SqlDriver;
  clock: () => number;
  playtime: RatingsPlaytimeLike;
  syncUserData: () => Promise<void> | undefined;
}): CatalogRatingsOpsMethods {
  const { db, clock, playtime, syncUserData } = deps;
  return {
    async setRating(input, value) {
      const res = await setItemRating(db, input, value, clock);
      if (res.ok) await syncUserData();
      return res;
    },
    getRating: (itemKey, profileId) => getItemRating(db, itemKey, profileId),
    listRatings: async (opts) => playtime.resolveRowLogos(await listRatings(db, opts)),
    listRatingMap: (profileId) => listRatingMap(db, profileId),
  };
}

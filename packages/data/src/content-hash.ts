const FNV_OFFSET_HI = 0xcbf29ce4;
const FNV_OFFSET_LO = 0x84222325;
const FNV_PRIME_LO = 0x1b3;

/** Scalar field value accepted by {@link fnv1a64Hex}. `null` and `undefined` both hash as SQL `NULL`. */
export type HashField = string | number | null | undefined;

interface FnvState {
  hi: number;
  lo: number;
}

/**
 * Feeds one byte into 64-bit FNV-1a using pure 32-bit integer ops (zero `BigInt` allocations):
 * multiplying by `0x100000001b3` equals `(h << 40) + h * 0x1b3` modulo 2^64.
 */
function feedByte(s: FnvState, byte: number): void {
  const lo = (s.lo ^ (byte & 0xff)) >>> 0;
  const p0 = (lo & 0xffff) * FNV_PRIME_LO;
  const p1 = (lo >>> 16) * FNV_PRIME_LO + (p0 >>> 16);
  s.lo = (((p1 & 0xffff) << 16) | (p0 & 0xffff)) >>> 0;
  s.hi = (Math.imul(s.hi, FNV_PRIME_LO) + (lo << 8) + (p1 >>> 16)) >>> 0;
}

function feedAscii(s: FnvState, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    feedByte(s, text.charCodeAt(i));
  }
}

function feedUtf8(s: FnvState, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      feedByte(s, code);
    } else if (code < 0x800) {
      feedByte(s, 0xc0 | (code >>> 6));
      feedByte(s, 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        feedByte(s, 0xf0 | (cp >>> 18));
        feedByte(s, 0x80 | ((cp >>> 12) & 0x3f));
        feedByte(s, 0x80 | ((cp >>> 6) & 0x3f));
        feedByte(s, 0x80 | (cp & 0x3f));
        i += 1;
        continue;
      }
      feedByte(s, 0xe0 | (code >>> 12));
      feedByte(s, 0x80 | ((code >>> 6) & 0x3f));
      feedByte(s, 0x80 | (code & 0x3f));
    } else {
      feedByte(s, 0xe0 | (code >>> 12));
      feedByte(s, 0x80 | ((code >>> 6) & 0x3f));
      feedByte(s, 0x80 | (code & 0x3f));
    }
  }
}

/**
 * Computes a deterministic 64-bit FNV-1a digest as a 16-character lowercase hex string over
 * type-tagged, length-prefixed, null-delimited fields (`#192`). Pure JS with zero `node:*` imports.
 */
export function fnv1a64Hex(fields: readonly HashField[]): string {
  const s: FnvState = { hi: FNV_OFFSET_HI, lo: FNV_OFFSET_LO };
  for (const field of fields) {
    if (field === null || field === undefined) {
      feedByte(s, 0x00);
      feedByte(s, 0x00);
    } else if (typeof field === 'number') {
      const normalized = Object.is(field, -0) ? 0 : field;
      const text = String(normalized);
      feedByte(s, 0x01);
      feedAscii(s, `${text.length}:`);
      feedAscii(s, text);
      feedByte(s, 0x00);
    } else {
      feedByte(s, 0x02);
      feedAscii(s, `${field.length}:`);
      feedUtf8(s, field);
      feedByte(s, 0x00);
    }
  }
  return s.hi.toString(16).padStart(8, '0') + s.lo.toString(16).padStart(8, '0');
}

/** Persisted mutable columns of a `categories` row. */
export interface CategoryHashInput {
  readonly name: string;
  readonly nameFold: string;
  readonly position: number;
}

/** Persisted mutable columns of a `live` row. */
export interface LiveHashInput {
  readonly providerId?: string | null | undefined;
  readonly num?: number | null | undefined;
  readonly name: string;
  readonly nameFold: string;
  readonly logo?: string | null | undefined;
  readonly guideId?: string | null | undefined;
  readonly catchupDays?: number | null | undefined;
  readonly catchupMode?: string | null | undefined;
  readonly catchupSourceTemplate?: string | null | undefined;
  readonly urlTemplate?: string | null | undefined;
  readonly headersJson?: string | null | undefined;
  readonly backupUrlsJson?: string | null | undefined;
  readonly epgShiftMs?: number | null | undefined;
}

/** Persisted mutable columns of a `movies` row. */
export interface MovieHashInput {
  readonly providerId?: string | null | undefined;
  readonly name: string;
  readonly nameFold: string;
  readonly logo?: string | null | undefined;
  readonly rating?: number | null | undefined;
  readonly year?: number | null | undefined;
  readonly extension?: string | null | undefined;
  readonly added?: number | null | undefined;
  readonly urlTemplate?: string | null | undefined;
  readonly headersJson?: string | null | undefined;
  readonly backupUrlsJson?: string | null | undefined;
  readonly castText?: string | null | undefined;
  readonly directorText?: string | null | undefined;
  readonly providerImdbId?: string | null | undefined;
  readonly providerTmdbId?: string | null | undefined;
}

/** Persisted mutable columns of a `series` row. */
export interface SeriesHashInput {
  readonly providerId?: string | null | undefined;
  readonly name: string;
  readonly nameFold: string;
  readonly cover?: string | null | undefined;
  readonly plot?: string | null | undefined;
  readonly rating?: number | null | undefined;
  readonly year?: number | null | undefined;
  readonly lastModified?: number | null | undefined;
  readonly castText?: string | null | undefined;
  readonly directorText?: string | null | undefined;
  readonly providerImdbId?: string | null | undefined;
  readonly providerTmdbId?: string | null | undefined;
}

/** Computes the deterministic content hash for a `categories` row. */
export function hashCategoryRow(row: CategoryHashInput): string {
  return fnv1a64Hex([row.name, row.nameFold, row.position]);
}

/** Computes the deterministic content hash for a `live` row. */
export function hashLiveRow(row: LiveHashInput): string {
  return fnv1a64Hex([
    row.providerId,
    row.num,
    row.name,
    row.nameFold,
    row.logo,
    row.guideId,
    row.catchupDays,
    row.catchupMode,
    row.catchupSourceTemplate,
    row.urlTemplate,
    row.headersJson,
    row.backupUrlsJson,
    row.epgShiftMs,
  ]);
}

/** Computes the deterministic content hash for a `movies` row. */
export function hashMovieRow(row: MovieHashInput): string {
  return fnv1a64Hex([
    row.providerId,
    row.name,
    row.nameFold,
    row.logo,
    row.rating,
    row.year,
    row.extension,
    row.added,
    row.urlTemplate,
    row.headersJson,
    row.backupUrlsJson,
    row.castText,
    row.directorText,
    row.providerImdbId,
    row.providerTmdbId,
  ]);
}

/** Computes the deterministic content hash for a `series` row. */
export function hashSeriesRow(row: SeriesHashInput): string {
  return fnv1a64Hex([
    row.providerId,
    row.name,
    row.nameFold,
    row.cover,
    row.plot,
    row.rating,
    row.year,
    row.lastModified,
    row.castText,
    row.directorText,
    row.providerImdbId,
    row.providerTmdbId,
  ]);
}

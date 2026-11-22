const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** Scalar field value accepted by {@link fnv1a64Hex}. `null` and `undefined` both hash as SQL `NULL`. */
export type HashField = string | number | null | undefined;

function feedByte(hash: bigint, byte: number): bigint {
  return ((hash ^ BigInt(byte & 0xff)) * FNV_PRIME) & MASK_64;
}

function feedAscii(hash: bigint, text: string): bigint {
  let h = hash;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h ^ BigInt(text.charCodeAt(i) & 0xff)) * FNV_PRIME) & MASK_64;
  }
  return h;
}

function feedUtf8(hash: bigint, text: string): bigint {
  let h = hash;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      h = feedByte(h, code);
    } else if (code < 0x800) {
      h = feedByte(h, 0xc0 | (code >>> 6));
      h = feedByte(h, 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const low = text.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const cp = ((code - 0xd800) << 10) + (low - 0xdc00) + 0x10000;
        h = feedByte(h, 0xf0 | (cp >>> 18));
        h = feedByte(h, 0x80 | ((cp >>> 12) & 0x3f));
        h = feedByte(h, 0x80 | ((cp >>> 6) & 0x3f));
        h = feedByte(h, 0x80 | (cp & 0x3f));
        i += 1;
        continue;
      }
      h = feedByte(h, 0xe0 | (code >>> 12));
      h = feedByte(h, 0x80 | ((code >>> 6) & 0x3f));
      h = feedByte(h, 0x80 | (code & 0x3f));
    } else {
      h = feedByte(h, 0xe0 | (code >>> 12));
      h = feedByte(h, 0x80 | ((code >>> 6) & 0x3f));
      h = feedByte(h, 0x80 | (code & 0x3f));
    }
  }
  return h;
}

/**
 * Computes a deterministic 64-bit FNV-1a digest as a 16-character lowercase hex string over
 * type-tagged, length-prefixed, null-delimited fields (`#192`). Pure JS with zero `node:*` imports.
 */
export function fnv1a64Hex(fields: readonly HashField[]): string {
  let h = FNV_OFFSET_BASIS;
  for (const field of fields) {
    if (field === null || field === undefined) {
      h = feedByte(h, 0x00);
      h = feedByte(h, 0x00);
    } else if (typeof field === 'number') {
      const normalized = Object.is(field, -0) ? 0 : field;
      const text = String(normalized);
      h = feedByte(h, 0x01);
      h = feedAscii(h, `${text.length}:`);
      h = feedAscii(h, text);
      h = feedByte(h, 0x00);
    } else {
      h = feedByte(h, 0x02);
      h = feedAscii(h, `${field.length}:`);
      h = feedUtf8(h, field);
      h = feedByte(h, 0x00);
    }
  }
  return h.toString(16).padStart(16, '0');
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
  ]);
}

import type { SqlDriver } from '@elv/domain';
import type { HttpCacheValidator, SourceHttpCache, SourceSettings } from './sources';
import { resolveTemplate, type UrlVars } from './templates';

const MAX_VALIDATOR_LENGTH = 256;
/** Rejects CR/LF, ASCII control chars, and non-ByteString (> 0x7e) characters so headers never inject or throw. */
const INVALID_HEADER_CHARS = /[^\x20-\x7e]/;
/** Strict vocabulary of opaque guide slot names (forbids URLs, credentials, and prototype keys). */
const OPAQUE_SLOT = /^(?:override|xtream|discovered:\d+)$/;
const CATALOG_ITEM_TABLES = ['live', 'movies', 'series', 'episodes'] as const;

function sanitizeValidatorValue(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  if (INVALID_HEADER_CHARS.test(raw)) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_VALIDATOR_LENGTH) return undefined;
  return trimmed;
}

/** Returns a sanitized copy of a stored or incoming validator, or `undefined` when nothing valid remains. */
export function sanitizeValidator(
  validator: HttpCacheValidator | undefined,
): HttpCacheValidator | undefined {
  if (validator === undefined) return undefined;
  const etag = sanitizeValidatorValue(validator.etag);
  const lastModified = sanitizeValidatorValue(validator.lastModified);
  if (etag === undefined && lastModified === undefined) return undefined;
  return {
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  };
}

/** Extracts sanitized `etag` / `last-modified` validators from response headers (case-insensitive). */
export function extractValidators(
  headers: Readonly<Record<string, string>>,
): HttpCacheValidator | undefined {
  let etag: string | undefined;
  let lastModified: string | undefined;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'etag') etag = value;
    else if (lower === 'last-modified') lastModified = value;
  }
  return sanitizeValidator({
    ...(etag === undefined ? {} : { etag }),
    ...(lastModified === undefined ? {} : { lastModified }),
  });
}

/** Merges `If-None-Match` / `If-Modified-Since` headers onto base transport headers using sanitized validators. */
export function conditionalHeaders(
  base: Readonly<Record<string, string>>,
  validator: HttpCacheValidator | undefined,
): Record<string, string> {
  const headers: Record<string, string> = { ...base };
  const clean = sanitizeValidator(validator);
  if (clean?.etag !== undefined) headers['if-none-match'] = clean.etag;
  if (clean?.lastModified !== undefined) headers['if-modified-since'] = clean.lastModified;
  return headers;
}

/** Merges optional updated validators from a 304 response onto the previously stored validator. */
export function merge304Validator(
  previous: HttpCacheValidator | undefined,
  incoming: HttpCacheValidator | undefined,
): HttpCacheValidator | undefined {
  const prev = sanitizeValidator(previous);
  const next = sanitizeValidator(incoming);
  if (next === undefined) return prev;
  return sanitizeValidator({ ...prev, ...next });
}

/** Whether two validator records have identical `etag` and `lastModified` fields. */
export function sameValidator(
  a: HttpCacheValidator | undefined,
  b: HttpCacheValidator | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.etag === b.etag && a.lastModified === b.lastModified;
}

/** Whether two guide validator maps have identical keys and validator values. */
export function sameGuideCache(
  a: Readonly<Record<string, HttpCacheValidator>> | undefined,
  b: Readonly<Record<string, HttpCacheValidator>> | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!Object.hasOwn(b, k) || !sameValidator(a[k], b[k])) return false;
  }
  return true;
}

function normalizeHttpCache(cache: SourceHttpCache): SourceHttpCache | undefined {
  const out: SourceHttpCache = {};
  if (cache.playlist !== undefined) out.playlist = cache.playlist;
  if (cache.guide !== undefined && Object.keys(cache.guide).length > 0) out.guide = cache.guide;
  return out.playlist === undefined && out.guide === undefined ? undefined : out;
}

/** Returns updated settings with the M3U playlist validator set or cleared. */
export function withPlaylistValidator(
  settings: SourceSettings,
  validator: HttpCacheValidator | undefined,
): SourceSettings {
  const next: SourceSettings = { ...settings };
  const cache: SourceHttpCache = { ...settings.httpCache };
  const clean = sanitizeValidator(validator);
  if (clean === undefined) delete cache.playlist;
  else cache.playlist = clean;
  const normalized = normalizeHttpCache(cache);
  if (normalized === undefined) delete next.httpCache;
  else next.httpCache = normalized;
  return next;
}

/** Returns updated settings with one opaque guide slot validator updated in place (e.g. on 304). */
export function withGuideValidator(
  settings: SourceSettings,
  slot: string,
  validator: HttpCacheValidator | undefined,
): SourceSettings {
  if (!OPAQUE_SLOT.test(slot)) return settings;
  const next: SourceSettings = { ...settings };
  const cache: SourceHttpCache = { ...settings.httpCache };
  const guide: Record<string, HttpCacheValidator> = { ...cache.guide };
  const clean = sanitizeValidator(validator);
  if (clean === undefined) delete guide[slot];
  else guide[slot] = clean;
  if (Object.keys(guide).length === 0) delete cache.guide;
  else cache.guide = guide;
  const normalized = normalizeHttpCache(cache);
  if (normalized === undefined) delete next.httpCache;
  else next.httpCache = normalized;
  return next;
}

/**
 * Replaces the entire `httpCache.guide` map with only the winning slot's validator (or removes `httpCache.guide`
 * when `validator` is empty), so stale validators from previously-active fallback slots cannot trigger false 304s.
 */
export function replaceGuideValidator(
  settings: SourceSettings,
  slot: string,
  validator: HttpCacheValidator | undefined,
): SourceSettings {
  if (!OPAQUE_SLOT.test(slot)) return settings;
  const next: SourceSettings = { ...settings };
  const cache: SourceHttpCache = { ...settings.httpCache };
  const clean = sanitizeValidator(validator);
  if (clean === undefined) delete cache.guide;
  else cache.guide = { [slot]: clean };
  const normalized = normalizeHttpCache(cache);
  if (normalized === undefined) delete next.httpCache;
  else next.httpCache = normalized;
  return next;
}

/** Whether discovered M3U guide URL placeholders or their resolved URLs changed, reordered, or were removed. */
export function discoveredGuidesChanged(
  prevUrls: readonly string[] | undefined,
  nextUrls: readonly string[] | undefined,
  oldVars: UrlVars,
  newVars: UrlVars,
): boolean {
  const a = prevUrls ?? [];
  const b = nextUrls ?? [];
  if (a.length !== b.length) return true;
  for (let i = 0; i < a.length; i += 1) {
    const prevT = a[i] as string;
    const nextT = b[i] as string;
    if (prevT !== nextT || resolveTemplate(prevT, oldVars) !== resolveTemplate(nextT, newVars)) {
      return true;
    }
  }
  return false;
}

/** Removes all `discovered:*` guide validators while preserving `override` and `xtream` validators. */
export function clearDiscoveredGuideValidators(settings: SourceSettings): SourceSettings {
  const guide = settings.httpCache?.guide;
  if (guide === undefined) return settings;
  const kept: Record<string, HttpCacheValidator> = {};
  let removed = false;
  for (const [slot, val] of Object.entries(guide)) {
    if (slot.startsWith('discovered:')) removed = true;
    else kept[slot] = val;
  }
  if (!removed) return settings;
  const next: SourceSettings = { ...settings };
  const cache: SourceHttpCache = { ...settings.httpCache };
  if (Object.keys(kept).length === 0) delete cache.guide;
  else cache.guide = kept;
  const normalized = normalizeHttpCache(cache);
  if (normalized === undefined) delete next.httpCache;
  else next.httpCache = normalized;
  return next;
}

/** Whether the source already has stored guide programmes (required before sending conditional guide headers). */
export async function hasStoredProgrammes(db: SqlDriver, sourceId: string): Promise<boolean> {
  return (
    (await db.all('SELECT 1 FROM programmes WHERE source_id = ? LIMIT 1', [sourceId])).length > 0
  );
}

/** Whether the source already has stored catalog items (required before sending conditional playlist headers). */
export async function hasStoredCatalog(db: SqlDriver, sourceId: string): Promise<boolean> {
  for (const table of CATALOG_ITEM_TABLES) {
    if ((await db.all(`SELECT 1 FROM ${table} WHERE source_id = ? LIMIT 1`, [sourceId])).length > 0)
      return true;
  }
  return false;
}

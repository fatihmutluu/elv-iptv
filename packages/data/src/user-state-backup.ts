import { CREDENTIAL_PARAMS, type SqlDriver } from '@elv/domain';
import { SOURCE_ID } from './sources';
import {
  clampMs,
  type FavoriteRow,
  mapFavoriteRow,
  mapProgressRow,
  normalizeProfileId,
  optFloat,
  optInt,
  type RawFavoriteRow,
  type RawProgressRow,
  type UserItemKind,
  type WatchProgressRow,
} from './user-state-helpers';

/** Local tvOS `NSUserDefaults` payload budget (`384 KiB`, leaving >100 KB headroom under tvOS's 500 KB cap). */
export const DEFAULT_USER_DATA_MAX_BYTES = 393_216;

/** iCloud `NSUbiquitousKeyValueStore` payload budget (`900 KiB`, under Apple's 1 MB KVS ceiling). */
export const ICLOUD_USER_DATA_MAX_BYTES = 921_600;

const VERSION = 1 as const;
const USER_ITEM_KINDS = new Set<UserItemKind>(['live', 'movie', 'series', 'episode']);
const SENSITIVE_QUERY_KEYS = new Set<string>([
  'username',
  'password',
  'token',
  'auth',
  'key',
  'pass',
  'pwd',
  'passwd',
  'access_token',
  'auth_token',
  'api_key',
  'apikey',
  'session',
  'jwt',
  'wmsauthsign',
  ...[...CREDENTIAL_PARAMS].map((p) => p.toLowerCase()),
]);

/**
 * Persistent key-value backing store for purge-safe user data on Apple platforms (`#79`, ADR 0014).
 * `read` and `write` may throw; backup helpers treat failures as best-effort recovery aids.
 */
export interface UserDataStore {
  read(): string | undefined;
  write(value: string): void;
  /** Optional local fallback writer (e.g. Apple `NSUserDefaults`) guaranteed `<= 384 KiB` (`#79`). */
  writeLocalFallback?(value: string): void;
  readonly maxBytes?: number;
}

/** Reserved local profile metadata entry for forward compatibility (`#15`). */
export interface UserDataProfileEntry {
  id: string;
  name: string;
  avatar?: string | null;
  isKids?: boolean;
  createdAt: number;
}

/** Versioned user-state snapshot serialized into `UserDataStore`. */
export interface UserDataSnapshot {
  readonly v: typeof VERSION;
  readonly favorites: readonly FavoriteRow[];
  readonly progress: readonly WatchProgressRow[];
  readonly profiles?: readonly UserDataProfileEntry[];
}

/** Sanitized decoded snapshot returned by {@link decodeUserDataSnapshot}. */
export interface DecodedUserDataSnapshot {
  favorites: FavoriteRow[];
  progress: WatchProgressRow[];
  profiles: UserDataProfileEntry[];
}

/** Row counts restored by {@link reconcileUserData}. */
export interface ReconcileUserDataResult {
  favoritesRestored: number;
  progressRestored: number;
}

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Drops any logo URL that is not clean `http(s)`, contains embedded `userinfo`, template placeholders,
 * control characters, or sensitive auth query parameters so credentials never enter persistent KV storage.
 */
export function sanitizeBackupLogo(logo: string | null | undefined): string | null {
  if (typeof logo !== 'string') return null;
  const trimmed = logo.trim();
  if (trimmed === '' || trimmed.includes('{{') || hasControlChar(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  const schemeEnd = trimmed.indexOf('://');
  if (schemeEnd >= 0) {
    const afterScheme = trimmed.slice(schemeEnd + 3);
    const authorityEnd = afterScheme.search(/[/?#]/);
    const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
    if (authority.includes('@')) return null;
  }
  for (const paramKey of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY_KEYS.has(paramKey.toLowerCase())) return null;
  }
  return trimmed;
}

function sanitizeAvatar(avatar: unknown): string | null {
  if (typeof avatar !== 'string') return null;
  const trimmed = avatar.trim();
  if (trimmed === '' || hasControlChar(trimmed) || trimmed.includes('{{')) return null;
  if (trimmed.includes('://')) return sanitizeBackupLogo(trimmed);
  if (trimmed.includes(':')) return null;
  return trimmed.slice(0, 64);
}

function isUserItemKind(value: unknown): value is UserItemKind {
  return typeof value === 'string' && USER_ITEM_KINDS.has(value as UserItemKind);
}

function parseFavoriteEntry(raw: unknown): FavoriteRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.sourceId !== 'string' ||
    !SOURCE_ID.test(r.sourceId) ||
    typeof r.itemKey !== 'string' ||
    r.itemKey.trim() === '' ||
    !isUserItemKind(r.kind) ||
    typeof r.title !== 'string' ||
    r.title.trim() === '' ||
    typeof r.addedAt !== 'number' ||
    !Number.isFinite(r.addedAt)
  ) {
    return null;
  }
  return {
    profileId: normalizeProfileId(typeof r.profileId === 'string' ? r.profileId : undefined),
    sourceId: r.sourceId,
    itemKey: r.itemKey,
    kind: r.kind,
    title: r.title,
    logo: sanitizeBackupLogo(typeof r.logo === 'string' ? r.logo : null),
    year: typeof r.year === 'number' ? optInt(r.year) : null,
    rating: typeof r.rating === 'number' ? optFloat(r.rating) : null,
    addedAt: Math.round(r.addedAt),
  };
}

function parseProgressEntry(raw: unknown): WatchProgressRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.sourceId !== 'string' ||
    !SOURCE_ID.test(r.sourceId) ||
    typeof r.itemKey !== 'string' ||
    r.itemKey.trim() === '' ||
    !isUserItemKind(r.kind) ||
    typeof r.title !== 'string' ||
    r.title.trim() === '' ||
    typeof r.positionMs !== 'number' ||
    !Number.isFinite(r.positionMs) ||
    typeof r.durationMs !== 'number' ||
    !Number.isFinite(r.durationMs) ||
    typeof r.watched !== 'boolean' ||
    typeof r.updatedAt !== 'number' ||
    !Number.isFinite(r.updatedAt)
  ) {
    return null;
  }
  const subtitle = typeof r.subtitle === 'string' && r.subtitle !== '' ? r.subtitle : null;
  const seriesKey =
    typeof r.seriesKey === 'string' && r.seriesKey.trim() !== '' ? r.seriesKey.trim() : null;
  return {
    profileId: normalizeProfileId(typeof r.profileId === 'string' ? r.profileId : undefined),
    sourceId: r.sourceId,
    itemKey: r.itemKey,
    kind: r.kind,
    title: r.title,
    subtitle,
    logo: sanitizeBackupLogo(typeof r.logo === 'string' ? r.logo : null),
    seriesKey,
    season: typeof r.season === 'number' ? optInt(r.season) : null,
    episode: typeof r.episode === 'number' ? optInt(r.episode) : null,
    positionMs: clampMs(r.positionMs),
    durationMs: clampMs(r.durationMs),
    watched: r.watched,
    updatedAt: Math.round(r.updatedAt),
  };
}

function parseProfileEntry(raw: unknown): UserDataProfileEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.id !== 'string' ||
    r.id.trim() === '' ||
    typeof r.name !== 'string' ||
    r.name.trim() === '' ||
    typeof r.createdAt !== 'number' ||
    !Number.isFinite(r.createdAt)
  ) {
    return null;
  }
  return {
    id: r.id.trim(),
    name: r.name.trim(),
    avatar: sanitizeAvatar(r.avatar),
    isKids: typeof r.isKids === 'boolean' ? r.isKids : false,
    createdAt: Math.round(r.createdAt),
  };
}

function compareFavorites(a: FavoriteRow, b: FavoriteRow): number {
  if (b.addedAt !== a.addedAt) return b.addedAt - a.addedAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
}

function compareProgress(a: WatchProgressRow, b: WatchProgressRow): number {
  if (a.watched !== b.watched) return a.watched ? 1 : -1;
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
}

const EMPTY_ENVELOPE = '{"v":1,"favorites":[],"progress":[]}';
const EMPTY_ENVELOPE_BYTES = utf8ByteLength(EMPTY_ENVELOPE);
const PROFILES_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"profiles":[]');

function stringifyPayload(
  favorites: readonly FavoriteRow[],
  progress: readonly WatchProgressRow[],
  profiles: readonly UserDataProfileEntry[],
): string {
  return JSON.stringify(
    profiles.length > 0
      ? { v: VERSION, favorites, progress, profiles }
      : { v: VERSION, favorites, progress },
  );
}

/**
 * Encodes a version-1 user-data snapshot to compact JSON within `maxBytes` UTF-8 bytes.
 * Sanitizes all logo/avatar URLs and greedily packs entries in strict priority order
 * (`profiles` -> newest `favorites` -> unwatched `progress` -> watched `progress`), skipping any
 * individual oversized row that would exceed `maxBytes` so normal rows are never starved.
 * Returns `''` when `maxBytes` cannot fit even the empty v1 envelope.
 */
export function encodeUserDataSnapshot(
  snapshot: Pick<UserDataSnapshot, 'favorites' | 'progress' | 'profiles'> & {
    readonly v?: typeof VERSION;
  },
  maxBytes: number = DEFAULT_USER_DATA_MAX_BYTES,
): string {
  const budget = Number.isFinite(maxBytes)
    ? Math.max(0, Math.floor(maxBytes))
    : DEFAULT_USER_DATA_MAX_BYTES;
  if (budget < EMPTY_ENVELOPE_BYTES) return '';

  const profiles = (snapshot.profiles ?? [])
    .map((entry) => parseProfileEntry(entry))
    .filter((entry): entry is UserDataProfileEntry => entry !== null);
  const favorites = snapshot.favorites
    .map((entry) => parseFavoriteEntry(entry))
    .filter((entry): entry is FavoriteRow => entry !== null)
    .sort(compareFavorites);
  const progress = snapshot.progress
    .map((entry) => parseProgressEntry(entry))
    .filter((entry): entry is WatchProgressRow => entry !== null)
    .sort(compareProgress);

  const full = stringifyPayload(favorites, progress, profiles);
  if (utf8ByteLength(full) <= budget) return full;

  let usedBytes = EMPTY_ENVELOPE_BYTES;
  const keptProfiles: UserDataProfileEntry[] = [];
  for (const profile of profiles) {
    const overhead = keptProfiles.length === 0 ? PROFILES_ENVELOPE_OVERHEAD_BYTES : 1;
    const itemBytes = utf8ByteLength(JSON.stringify(profile));
    if (usedBytes + overhead + itemBytes <= budget) {
      keptProfiles.push(profile);
      usedBytes += overhead + itemBytes;
    }
  }

  const keptFavorites: FavoriteRow[] = [];
  for (const favorite of favorites) {
    const overhead = keptFavorites.length === 0 ? 0 : 1;
    const itemBytes = utf8ByteLength(JSON.stringify(favorite));
    if (usedBytes + overhead + itemBytes <= budget) {
      keptFavorites.push(favorite);
      usedBytes += overhead + itemBytes;
    }
  }

  const keptProgress: WatchProgressRow[] = [];
  for (const entry of progress) {
    const overhead = keptProgress.length === 0 ? 0 : 1;
    const itemBytes = utf8ByteLength(JSON.stringify(entry));
    if (usedBytes + overhead + itemBytes <= budget) {
      keptProgress.push(entry);
      usedBytes += overhead + itemBytes;
    }
  }

  return stringifyPayload(keptFavorites, keptProgress, keptProfiles);
}

/** Decodes and sanitizes a persisted snapshot; returns empty arrays on missing, corrupt, or foreign payloads. */
export function decodeUserDataSnapshot(raw: string | undefined): DecodedUserDataSnapshot {
  if (raw === undefined || raw === '') return { favorites: [], progress: [], profiles: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { favorites: [], progress: [], profiles: [] };
  }
  const obj = parsed as {
    v?: unknown;
    favorites?: unknown;
    progress?: unknown;
    profiles?: unknown;
  } | null;
  if (obj === null || typeof obj !== 'object' || obj.v !== VERSION) {
    return { favorites: [], progress: [], profiles: [] };
  }
  const favorites = Array.isArray(obj.favorites)
    ? obj.favorites
        .map((entry) => parseFavoriteEntry(entry))
        .filter((entry): entry is FavoriteRow => entry !== null)
    : [];
  const progress = Array.isArray(obj.progress)
    ? obj.progress
        .map((entry) => parseProgressEntry(entry))
        .filter((entry): entry is WatchProgressRow => entry !== null)
    : [];
  const profiles = Array.isArray(obj.profiles)
    ? obj.profiles
        .map((entry) => parseProfileEntry(entry))
        .filter((entry): entry is UserDataProfileEntry => entry !== null)
    : [];
  return { favorites, progress, profiles };
}

function readSnapshot(store: UserDataStore): DecodedUserDataSnapshot {
  try {
    return decodeUserDataSnapshot(store.read());
  } catch {
    return { favorites: [], progress: [], profiles: [] };
  }
}

/** Reads `favorites` and `watch_progress` from `db` and persists a budget-safe snapshot to `store`. */
export async function saveUserDataSnapshot(db: SqlDriver, store: UserDataStore): Promise<void> {
  try {
    const [rawFavorites, rawProgress] = await Promise.all([
      db.all<RawFavoriteRow>(
        'SELECT profile_id, source_id, item_key, kind, title, logo, year, rating, added_at FROM favorites ORDER BY added_at DESC, profile_id ASC, item_key ASC',
      ),
      db.all<RawProgressRow>(
        'SELECT profile_id, source_id, item_key, kind, title, subtitle, logo, series_key, season, episode, position_ms, duration_ms, watched, updated_at FROM watch_progress ORDER BY watched ASC, updated_at DESC, profile_id ASC, item_key ASC',
      ),
    ]);
    const snapshot = {
      favorites: rawFavorites.map(mapFavoriteRow),
      progress: rawProgress.map(mapProgressRow),
      profiles: readSnapshot(store).profiles,
    };
    const encoded = encodeUserDataSnapshot(snapshot, store.maxBytes ?? DEFAULT_USER_DATA_MAX_BYTES);
    try {
      store.write(encoded);
    } catch {
      // Best-effort primary persistence.
    }
    if (store.writeLocalFallback !== undefined) {
      try {
        const localEncoded =
          utf8ByteLength(encoded) <= DEFAULT_USER_DATA_MAX_BYTES
            ? encoded
            : encodeUserDataSnapshot(snapshot, DEFAULT_USER_DATA_MAX_BYTES);
        store.writeLocalFallback(localEncoded);
      } catch {
        // Best-effort local fallback persistence.
      }
    }
  } catch {
    // Best-effort recovery aid: never disrupt catalog operations on KV failure.
  }
}

const RESTORE_FAVORITE_SQL = `INSERT OR IGNORE INTO favorites (
  profile_id, source_id, item_key, kind, title, logo, year, rating, added_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const RESTORE_PROGRESS_SQL = `INSERT OR IGNORE INTO watch_progress (
  profile_id, source_id, item_key, kind, title, subtitle, logo,
  series_key, season, episode, position_ms, duration_ms, watched, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Reconciles SQLite user tables with persistent KV storage on startup (`#79`, ADR 0014).
 * When SQLite already holds favorites or watch progress, refreshes the backup snapshot.
 * When both tables are empty (e.g. after a tvOS `Library/Caches` purge), restores valid rows
 * atomically in a single transaction.
 */
export async function reconcileUserData(
  db: SqlDriver,
  store: UserDataStore,
): Promise<ReconcileUserDataResult> {
  const [favPresent, progPresent] = await Promise.all([
    db.all<{ found: number }>('SELECT 1 AS found FROM favorites LIMIT 1'),
    db.all<{ found: number }>('SELECT 1 AS found FROM watch_progress LIMIT 1'),
  ]);
  if (favPresent.length > 0 || progPresent.length > 0) {
    await saveUserDataSnapshot(db, store);
    return { favoritesRestored: 0, progressRestored: 0 };
  }
  const snapshot = readSnapshot(store);
  if (snapshot.favorites.length === 0 && snapshot.progress.length === 0) {
    return { favoritesRestored: 0, progressRestored: 0 };
  }
  let favoritesRestored = 0;
  let progressRestored = 0;
  await db.transaction(async (tx) => {
    for (const fav of snapshot.favorites) {
      const res = await tx.run(RESTORE_FAVORITE_SQL, [
        fav.profileId,
        fav.sourceId,
        fav.itemKey,
        fav.kind,
        fav.title,
        fav.logo,
        fav.year,
        fav.rating,
        fav.addedAt,
      ]);
      favoritesRestored += res.changes;
    }
    for (const prog of snapshot.progress) {
      const res = await tx.run(RESTORE_PROGRESS_SQL, [
        prog.profileId,
        prog.sourceId,
        prog.itemKey,
        prog.kind,
        prog.title,
        prog.subtitle,
        prog.logo,
        prog.seriesKey,
        prog.season,
        prog.episode,
        prog.positionMs,
        prog.durationMs,
        prog.watched ? 1 : 0,
        prog.updatedAt,
      ]);
      progressRestored += res.changes;
    }
  });
  return { favoritesRestored, progressRestored };
}

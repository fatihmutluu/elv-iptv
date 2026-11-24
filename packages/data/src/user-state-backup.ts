import { CREDENTIAL_PARAMS, type SqlDriver } from '@elv/domain';
import { isProfileAvatarToken, isValidProfileId } from './profiles-repo';
import {
  isSafeRecentChannelKey,
  mapRecentChannelRow,
  type RawRecentChannelRow,
  type RecentChannelRow,
} from './recent-channels-repo';
import { SOURCE_ID } from './sources';
import {
  clampTrackDelayMs,
  mapTrackPreferenceRow,
  type PersistedTrackPreference,
  type RawTrackPreferenceRow,
  sanitizeResizeMode,
  sanitizeTrackLabel,
  sanitizeTrackLang,
} from './track-preferences-repo';
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
  readonly trackPreferences?: readonly PersistedTrackPreference[];
  readonly recentChannels?: readonly RecentChannelRow[];
}

/** Sanitized decoded snapshot returned by {@link decodeUserDataSnapshot}. */
export interface DecodedUserDataSnapshot {
  favorites: FavoriteRow[];
  progress: WatchProgressRow[];
  profiles: UserDataProfileEntry[];
  trackPreferences?: PersistedTrackPreference[];
  recentChannels?: RecentChannelRow[];
}

/** Row counts restored by {@link reconcileUserData}. */
export interface ReconcileUserDataResult {
  favoritesRestored: number;
  progressRestored: number;
  profilesRestored?: number;
  trackPreferencesRestored?: number;
  recentChannelsRestored?: number;
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

function parseTrackPreferenceEntry(raw: unknown): PersistedTrackPreference | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.sourceId !== 'string' ||
    !SOURCE_ID.test(r.sourceId) ||
    typeof r.scopeKey !== 'string' ||
    r.scopeKey.trim() === '' ||
    typeof r.updatedAt !== 'number' ||
    !Number.isFinite(r.updatedAt)
  ) {
    return null;
  }
  return {
    profileId: normalizeProfileId(typeof r.profileId === 'string' ? r.profileId : undefined),
    scopeKey: r.scopeKey.trim(),
    sourceId: r.sourceId,
    audioLang: sanitizeTrackLang(r.audioLang),
    audioLabel: sanitizeTrackLabel(r.audioLabel),
    subLang: sanitizeTrackLang(r.subLang),
    subLabel: sanitizeTrackLabel(r.subLabel),
    subDisabled: r.subDisabled === true,
    audioDelayMs: clampTrackDelayMs(r.audioDelayMs),
    subDelayMs: clampTrackDelayMs(r.subDelayMs),
    resizeMode: sanitizeResizeMode(r.resizeMode),
    updatedAt: Math.round(r.updatedAt),
  };
}

function compareTrackPreferences(a: PersistedTrackPreference, b: PersistedTrackPreference): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  return a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0;
}

function parseRecentChannelEntry(raw: unknown): RecentChannelRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.sourceId !== 'string' ||
    !SOURCE_ID.test(r.sourceId) ||
    !isSafeRecentChannelKey(r.itemKey) ||
    typeof r.watchedAt !== 'number' ||
    !Number.isFinite(r.watchedAt)
  ) {
    return null;
  }
  return {
    profileId: normalizeProfileId(typeof r.profileId === 'string' ? r.profileId : undefined),
    sourceId: r.sourceId,
    itemKey: r.itemKey.trim(),
    watchedAt: Math.max(0, Math.round(r.watchedAt)),
  };
}

function compareRecentChannels(a: RecentChannelRow, b: RecentChannelRow): number {
  if (b.watchedAt !== a.watchedAt) return b.watchedAt - a.watchedAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
}

const EMPTY_ENVELOPE = '{"v":1,"favorites":[],"progress":[]}';
const EMPTY_ENVELOPE_BYTES = utf8ByteLength(EMPTY_ENVELOPE);
const PROFILES_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"profiles":[]');
const TRACK_PREFS_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"trackPreferences":[]');
const RECENT_CHANNELS_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"recentChannels":[]');

function stringifyPayload(
  favorites: readonly FavoriteRow[],
  progress: readonly WatchProgressRow[],
  profiles: readonly UserDataProfileEntry[],
  trackPreferences: readonly PersistedTrackPreference[],
  recentChannels: readonly RecentChannelRow[],
): string {
  return JSON.stringify({
    v: VERSION,
    favorites,
    progress,
    ...(profiles.length > 0 ? { profiles } : {}),
    ...(trackPreferences.length > 0 ? { trackPreferences } : {}),
    ...(recentChannels.length > 0 ? { recentChannels } : {}),
  });
}

/**
 * Encodes a version-1 user-data snapshot to compact JSON within `maxBytes` UTF-8 bytes.
 * Sanitizes all logo/avatar URLs and greedily packs entries in strict priority order
 * (`profiles` -> newest `favorites` -> unwatched `progress` -> watched `progress` -> `trackPreferences`),
 * skipping any individual oversized row that would exceed `maxBytes` so normal rows are never starved.
 * Returns `''` when `maxBytes` cannot fit even the empty v1 envelope.
 */
export function encodeUserDataSnapshot(
  snapshot: Pick<
    UserDataSnapshot,
    'favorites' | 'progress' | 'profiles' | 'trackPreferences' | 'recentChannels'
  > & {
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
  const trackPreferences = (snapshot.trackPreferences ?? [])
    .map((entry) => parseTrackPreferenceEntry(entry))
    .filter((entry): entry is PersistedTrackPreference => entry !== null)
    .sort(compareTrackPreferences);
  const recentChannels = (snapshot.recentChannels ?? [])
    .map((entry) => parseRecentChannelEntry(entry))
    .filter((entry): entry is RecentChannelRow => entry !== null)
    .sort(compareRecentChannels);

  const full = stringifyPayload(favorites, progress, profiles, trackPreferences, recentChannels);
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

  const keptTrackPrefs: PersistedTrackPreference[] = [];
  for (const pref of trackPreferences) {
    const overhead = keptTrackPrefs.length === 0 ? TRACK_PREFS_ENVELOPE_OVERHEAD_BYTES : 1;
    const itemBytes = utf8ByteLength(JSON.stringify(pref));
    if (usedBytes + overhead + itemBytes <= budget) {
      keptTrackPrefs.push(pref);
      usedBytes += overhead + itemBytes;
    }
  }

  const keptRecentChannels: RecentChannelRow[] = [];
  for (const recent of recentChannels) {
    const overhead = keptRecentChannels.length === 0 ? RECENT_CHANNELS_ENVELOPE_OVERHEAD_BYTES : 1;
    const itemBytes = utf8ByteLength(JSON.stringify(recent));
    if (usedBytes + overhead + itemBytes <= budget) {
      keptRecentChannels.push(recent);
      usedBytes += overhead + itemBytes;
    }
  }

  return stringifyPayload(
    keptFavorites,
    keptProgress,
    keptProfiles,
    keptTrackPrefs,
    keptRecentChannels,
  );
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
    trackPreferences?: unknown;
    recentChannels?: unknown;
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
  const trackPreferences = Array.isArray(obj.trackPreferences)
    ? obj.trackPreferences
        .map((entry) => parseTrackPreferenceEntry(entry))
        .filter((entry): entry is PersistedTrackPreference => entry !== null)
    : [];
  const recentChannels = Array.isArray(obj.recentChannels)
    ? obj.recentChannels
        .map((entry) => parseRecentChannelEntry(entry))
        .filter((entry): entry is RecentChannelRow => entry !== null)
    : [];
  return {
    favorites,
    progress,
    profiles,
    ...(trackPreferences.length > 0 ? { trackPreferences } : {}),
    ...(recentChannels.length > 0 ? { recentChannels } : {}),
  };
}

function readSnapshot(store: UserDataStore): DecodedUserDataSnapshot {
  try {
    return decodeUserDataSnapshot(store.read());
  } catch {
    return { favorites: [], progress: [], profiles: [] };
  }
}

/** Reads `profiles`, `favorites`, `watch_progress`, `track_preferences`, and `recent_channels` from `db` and persists a budget-safe snapshot to `store`. */
export async function saveUserDataSnapshot(db: SqlDriver, store: UserDataStore): Promise<void> {
  try {
    const [rawFavorites, rawProgress, rawProfiles, rawTrackPrefs, rawRecentChannels] =
      await Promise.all([
        db.all<RawFavoriteRow>(
          'SELECT profile_id, source_id, item_key, kind, title, logo, year, rating, added_at FROM favorites ORDER BY added_at DESC, profile_id ASC, item_key ASC',
        ),
        db.all<RawProgressRow>(
          'SELECT profile_id, source_id, item_key, kind, title, subtitle, logo, series_key, season, episode, position_ms, duration_ms, watched, updated_at FROM watch_progress ORDER BY watched ASC, updated_at DESC, profile_id ASC, item_key ASC',
        ),
        db.all<{
          id: string;
          name: string;
          avatar_token: string;
          is_kids: number;
          created_at: number;
        }>(
          'SELECT id, name, avatar_token, is_kids, created_at FROM profiles ORDER BY is_default DESC, created_at ASC, id ASC',
        ),
        db.all<RawTrackPreferenceRow>(
          'SELECT profile_id, scope_key, source_id, audio_lang, audio_label, sub_lang, sub_label, sub_disabled, audio_delay_ms, sub_delay_ms, resize_mode, updated_at FROM track_preferences ORDER BY updated_at DESC, profile_id ASC, scope_key ASC',
        ),
        db.all<RawRecentChannelRow>(
          'SELECT profile_id, source_id, item_key, watched_at FROM recent_channels ORDER BY watched_at DESC, profile_id ASC, item_key ASC',
        ),
      ]);
    const profiles: UserDataProfileEntry[] =
      rawProfiles.length > 0
        ? rawProfiles.map((p) => ({
            id: p.id,
            name: p.name,
            avatar: p.avatar_token,
            isKids: p.is_kids !== 0,
            createdAt: p.created_at,
          }))
        : readSnapshot(store).profiles;
    const snapshot = {
      favorites: rawFavorites.map(mapFavoriteRow),
      progress: rawProgress.map(mapProgressRow),
      profiles,
      trackPreferences: rawTrackPrefs.map(mapTrackPreferenceRow),
      recentChannels: rawRecentChannels.map(mapRecentChannelRow),
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

const RESTORE_TRACK_PREF_SQL = `INSERT OR IGNORE INTO track_preferences (
  profile_id, scope_key, source_id, audio_lang, audio_label, sub_lang, sub_label,
  sub_disabled, audio_delay_ms, sub_delay_ms, resize_mode, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const RESTORE_RECENT_CHANNEL_SQL = `INSERT OR IGNORE INTO recent_channels (
  profile_id, source_id, item_key, watched_at
) VALUES (?, ?, ?, ?)`;

const RESTORE_PROFILE_SQL = `INSERT OR IGNORE INTO profiles (
  id, name, avatar_token, is_kids, is_default, created_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)`;

const RESTORE_DEFAULT_PROFILE_SQL = `UPDATE profiles
  SET name = ?, avatar_token = ?, is_kids = ?, updated_at = ?
 WHERE id = 'default' AND updated_at = 0 AND name = 'Default'`;

/**
 * Reconciles SQLite user tables with persistent KV storage on startup (`#79`, ADR 0014).
 * When SQLite already holds favorites, watch progress, track preferences, recent channels, or
 * non-default profiles, refreshes the backup snapshot.
 * When all tables are empty (e.g. after a tvOS `Library/Caches` purge), restores valid rows
 * atomically in a single transaction.
 */
export async function reconcileUserData(
  db: SqlDriver,
  store: UserDataStore,
): Promise<ReconcileUserDataResult> {
  const [favPresent, progPresent, trackPresent, recentPresent, customProfilePresent] =
    await Promise.all([
      db.all<{ found: number }>('SELECT 1 AS found FROM favorites LIMIT 1'),
      db.all<{ found: number }>('SELECT 1 AS found FROM watch_progress LIMIT 1'),
      db.all<{ found: number }>('SELECT 1 AS found FROM track_preferences LIMIT 1'),
      db.all<{ found: number }>('SELECT 1 AS found FROM recent_channels LIMIT 1'),
      db.all<{ found: number }>("SELECT 1 AS found FROM profiles WHERE id != 'default' LIMIT 1"),
    ]);
  if (
    favPresent.length > 0 ||
    progPresent.length > 0 ||
    trackPresent.length > 0 ||
    recentPresent.length > 0 ||
    customProfilePresent.length > 0
  ) {
    await saveUserDataSnapshot(db, store);
    return { favoritesRestored: 0, progressRestored: 0 };
  }
  const snapshot = readSnapshot(store);
  const trackPrefs = snapshot.trackPreferences ?? [];
  const recentChannels = snapshot.recentChannels ?? [];
  if (
    snapshot.favorites.length === 0 &&
    snapshot.progress.length === 0 &&
    snapshot.profiles.length === 0 &&
    trackPrefs.length === 0 &&
    recentChannels.length === 0
  ) {
    return { favoritesRestored: 0, progressRestored: 0 };
  }
  let favoritesRestored = 0;
  let progressRestored = 0;
  let profilesRestored = 0;
  let trackPreferencesRestored = 0;
  let recentChannelsRestored = 0;
  await db.transaction(async (tx) => {
    for (const profile of snapshot.profiles) {
      if (!isValidProfileId(profile.id)) continue;
      const avatarToken = isProfileAvatarToken(profile.avatar) ? profile.avatar : 'crimson';
      const isKids = profile.isKids === true ? 1 : 0;
      const isDefault = profile.id === 'default' ? 1 : 0;
      const res = await tx.run(RESTORE_PROFILE_SQL, [
        profile.id,
        profile.name,
        avatarToken,
        isKids,
        isDefault,
        profile.createdAt,
        profile.createdAt,
      ]);
      profilesRestored += res.changes;
      if (
        profile.id === 'default' &&
        res.changes === 0 &&
        (profile.name !== 'Default' ||
          avatarToken !== 'crimson' ||
          isKids !== 0 ||
          profile.createdAt !== 0)
      ) {
        const upd = await tx.run(RESTORE_DEFAULT_PROFILE_SQL, [
          profile.name,
          avatarToken,
          isKids,
          profile.createdAt,
        ]);
        profilesRestored += upd.changes;
      }
    }
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
    for (const pref of trackPrefs) {
      const res = await tx.run(RESTORE_TRACK_PREF_SQL, [
        pref.profileId,
        pref.scopeKey,
        pref.sourceId,
        pref.audioLang,
        pref.audioLabel,
        pref.subLang,
        pref.subLabel,
        pref.subDisabled ? 1 : 0,
        pref.audioDelayMs,
        pref.subDelayMs,
        pref.resizeMode,
        pref.updatedAt,
      ]);
      trackPreferencesRestored += res.changes;
    }
    for (const recent of recentChannels) {
      const res = await tx.run(RESTORE_RECENT_CHANNEL_SQL, [
        recent.profileId,
        recent.sourceId,
        recent.itemKey,
        recent.watchedAt,
      ]);
      recentChannelsRestored += res.changes;
    }
  });
  return {
    favoritesRestored,
    progressRestored,
    ...(profilesRestored > 0 ? { profilesRestored } : {}),
    ...(trackPreferencesRestored > 0 ? { trackPreferencesRestored } : {}),
    ...(recentChannelsRestored > 0 ? { recentChannelsRestored } : {}),
  };
}

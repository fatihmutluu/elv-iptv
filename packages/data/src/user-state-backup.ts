import type { SqlDriver } from '@elv/domain';
import { type ChannelOverrideRecord, markChannelCustomNamesDirty } from './channel-overrides-repo';
import type { CustomGroupItemRecord } from './custom-groups-repo';
import type { ParentalLockRecord, ParentalSettings } from './parental-policy';
import { markParentalStateDirty } from './parental-repo';
import { isProfileAvatarToken, isValidProfileId } from './profiles-repo';
import {
  mapRecentChannelRow,
  type RawRecentChannelRow,
  type RecentChannelRow,
} from './recent-channels-repo';
import {
  mapTrackPreferenceRow,
  type PersistedTrackPreference,
  type RawTrackPreferenceRow,
} from './track-preferences-repo';
import {
  compareChannelOverrides,
  compareCustomGroupItems,
  compareCustomGroups,
  parseChannelOverrideEntry,
  parseCustomGroupEntry,
  parseCustomGroupItemEntry,
  readChannelManagementBackupRows,
  restoreChannelManagementBackupRows,
  type UserDataCustomGroupEntry,
} from './user-state-backup-channels';
import {
  compareFavorites,
  compareProgress,
  compareRecentChannels,
  compareTrackPreferences,
  parseFavoriteEntry,
  parseProfileEntry,
  parseProgressEntry,
  parseRecentChannelEntry,
  parseTrackPreferenceEntry,
  type UserDataProfileEntry,
} from './user-state-backup-entries';
import {
  compareParentalLocks,
  compareParentalSettings,
  parseParentalLockEntry,
  parseParentalSettingsEntry,
  readParentalBackupRows,
  restoreParentalBackupRows,
} from './user-state-backup-parental';
import {
  type FavoriteRow,
  mapFavoriteRow,
  mapProgressRow,
  type RawFavoriteRow,
  type RawProgressRow,
  type WatchProgressRow,
} from './user-state-helpers';

export type { UserDataCustomGroupEntry } from './user-state-backup-channels';
export { sanitizeBackupLogo, type UserDataProfileEntry } from './user-state-backup-entries';

/** Local tvOS `NSUserDefaults` payload budget (`384 KiB`, leaving >100 KB headroom under tvOS's 500 KB cap). */
export const DEFAULT_USER_DATA_MAX_BYTES = 393_216;

/** iCloud `NSUbiquitousKeyValueStore` payload budget (`900 KiB`, under Apple's 1 MB KVS ceiling). */
export const ICLOUD_USER_DATA_MAX_BYTES = 921_600;

const VERSION = 1 as const;

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

/** Versioned user-state snapshot serialized into `UserDataStore`. */
export interface UserDataSnapshot {
  readonly v: typeof VERSION;
  readonly favorites: readonly FavoriteRow[];
  readonly progress: readonly WatchProgressRow[];
  readonly profiles?: readonly UserDataProfileEntry[];
  readonly parentalSettings?: readonly ParentalSettings[];
  readonly parentalLocks?: readonly ParentalLockRecord[];
  readonly trackPreferences?: readonly PersistedTrackPreference[];
  readonly recentChannels?: readonly RecentChannelRow[];
  readonly channelOverrides?: readonly ChannelOverrideRecord[];
  readonly customGroups?: readonly UserDataCustomGroupEntry[];
  readonly customGroupItems?: readonly CustomGroupItemRecord[];
}

/** Sanitized decoded snapshot returned by {@link decodeUserDataSnapshot}. */
export interface DecodedUserDataSnapshot {
  favorites: FavoriteRow[];
  progress: WatchProgressRow[];
  profiles: UserDataProfileEntry[];
  parentalSettings?: ParentalSettings[];
  parentalLocks?: ParentalLockRecord[];
  trackPreferences?: PersistedTrackPreference[];
  recentChannels?: RecentChannelRow[];
  channelOverrides?: ChannelOverrideRecord[];
  customGroups?: UserDataCustomGroupEntry[];
  customGroupItems?: CustomGroupItemRecord[];
}

/** Row counts restored by {@link reconcileUserData}. */
export interface ReconcileUserDataResult {
  favoritesRestored: number;
  progressRestored: number;
  profilesRestored?: number;
  parentalSettingsRestored?: number;
  parentalLocksRestored?: number;
  trackPreferencesRestored?: number;
  recentChannelsRestored?: number;
  channelOverridesRestored?: number;
  customGroupsRestored?: number;
  customGroupItemsRestored?: number;
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

const EMPTY_ENVELOPE = '{"v":1,"favorites":[],"progress":[]}';
const EMPTY_ENVELOPE_BYTES = utf8ByteLength(EMPTY_ENVELOPE);
const PROFILES_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"profiles":[]');
const PARENTAL_SETTINGS_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"parentalSettings":[]');
const PARENTAL_LOCKS_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"parentalLocks":[]');
const TRACK_PREFS_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"trackPreferences":[]');
const RECENT_CHANNELS_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"recentChannels":[]');
const CHANNEL_OVERRIDES_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"channelOverrides":[]');
const CUSTOM_GROUPS_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"customGroups":[]');
const CUSTOM_GROUP_ITEMS_ENVELOPE_OVERHEAD_BYTES = utf8ByteLength(',"customGroupItems":[]');

function stringifyPayload(payload: {
  favorites: readonly FavoriteRow[];
  progress: readonly WatchProgressRow[];
  profiles: readonly UserDataProfileEntry[];
  parentalSettings: readonly ParentalSettings[];
  parentalLocks: readonly ParentalLockRecord[];
  trackPreferences: readonly PersistedTrackPreference[];
  recentChannels: readonly RecentChannelRow[];
  channelOverrides: readonly ChannelOverrideRecord[];
  customGroups: readonly UserDataCustomGroupEntry[];
  customGroupItems: readonly CustomGroupItemRecord[];
}): string {
  return JSON.stringify({
    v: VERSION,
    favorites: payload.favorites,
    progress: payload.progress,
    ...(payload.profiles.length > 0 ? { profiles: payload.profiles } : {}),
    ...(payload.parentalSettings.length > 0 ? { parentalSettings: payload.parentalSettings } : {}),
    ...(payload.parentalLocks.length > 0 ? { parentalLocks: payload.parentalLocks } : {}),
    ...(payload.trackPreferences.length > 0 ? { trackPreferences: payload.trackPreferences } : {}),
    ...(payload.recentChannels.length > 0 ? { recentChannels: payload.recentChannels } : {}),
    ...(payload.channelOverrides.length > 0 ? { channelOverrides: payload.channelOverrides } : {}),
    ...(payload.customGroups.length > 0 ? { customGroups: payload.customGroups } : {}),
    ...(payload.customGroupItems.length > 0 ? { customGroupItems: payload.customGroupItems } : {}),
  });
}

function packWithinBudget<T>(
  items: readonly T[],
  firstOverhead: number,
  state: { usedBytes: number; readonly budget: number },
): T[] {
  const kept: T[] = [];
  for (const item of items) {
    const overhead = kept.length === 0 ? firstOverhead : 1;
    const itemBytes = utf8ByteLength(JSON.stringify(item));
    if (state.usedBytes + overhead + itemBytes <= state.budget) {
      kept.push(item);
      state.usedBytes += overhead + itemBytes;
    }
  }
  return kept;
}

/**
 * Encodes a version-1 user-data snapshot to compact JSON within `maxBytes` UTF-8 bytes.
 * Sanitizes all logo/avatar URLs and greedily packs entries in strict priority order
 * (`profiles` -> `parentalSettings` -> `parentalLocks` -> newest `favorites` -> unwatched `progress` -> watched `progress` -> `trackPreferences` -> `recentChannels`),
 * skipping any individual oversized row that would exceed `maxBytes` so normal rows are never starved.
 * Returns `''` when `maxBytes` cannot fit even the empty v1 envelope.
 */
export function encodeUserDataSnapshot(
  snapshot: Pick<
    UserDataSnapshot,
    | 'favorites'
    | 'progress'
    | 'profiles'
    | 'parentalSettings'
    | 'parentalLocks'
    | 'trackPreferences'
    | 'recentChannels'
    | 'channelOverrides'
    | 'customGroups'
    | 'customGroupItems'
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
  const parentalSettings = (snapshot.parentalSettings ?? [])
    .map((entry) => parseParentalSettingsEntry(entry))
    .filter((entry): entry is ParentalSettings => entry !== null)
    .sort(compareParentalSettings);
  const parentalLocks = (snapshot.parentalLocks ?? [])
    .map((entry) => parseParentalLockEntry(entry))
    .filter((entry): entry is ParentalLockRecord => entry !== null)
    .sort(compareParentalLocks);
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
  const customGroups = (snapshot.customGroups ?? [])
    .map((entry) => parseCustomGroupEntry(entry))
    .filter((entry): entry is UserDataCustomGroupEntry => entry !== null)
    .sort(compareCustomGroups);
  const customGroupItems = (snapshot.customGroupItems ?? [])
    .map((entry) => parseCustomGroupItemEntry(entry))
    .filter((entry): entry is CustomGroupItemRecord => entry !== null)
    .sort(compareCustomGroupItems);
  const channelOverrides = (snapshot.channelOverrides ?? [])
    .map((entry) => parseChannelOverrideEntry(entry))
    .filter((entry): entry is ChannelOverrideRecord => entry !== null)
    .sort(compareChannelOverrides);

  const full = stringifyPayload({
    favorites,
    progress,
    profiles,
    parentalSettings,
    parentalLocks,
    trackPreferences,
    recentChannels,
    channelOverrides,
    customGroups,
    customGroupItems,
  });
  if (utf8ByteLength(full) <= budget) return full;

  const packState = { usedBytes: EMPTY_ENVELOPE_BYTES, budget };
  const keptProfiles = packWithinBudget(profiles, PROFILES_ENVELOPE_OVERHEAD_BYTES, packState);
  const keptParentalSettings = packWithinBudget(
    parentalSettings,
    PARENTAL_SETTINGS_ENVELOPE_OVERHEAD_BYTES,
    packState,
  );
  const keptParentalLocks = packWithinBudget(
    parentalLocks,
    PARENTAL_LOCKS_ENVELOPE_OVERHEAD_BYTES,
    packState,
  );
  const keptFavorites = packWithinBudget(favorites, 0, packState);
  const keptProgress = packWithinBudget(progress, 0, packState);
  const keptCustomGroups = packWithinBudget(
    customGroups,
    CUSTOM_GROUPS_ENVELOPE_OVERHEAD_BYTES,
    packState,
  );
  const keptGroupIdSet = new Set(keptCustomGroups.map((g) => g.id));
  const keptCustomGroupItems = packWithinBudget(
    customGroupItems.filter((item) => keptGroupIdSet.has(item.groupId)),
    CUSTOM_GROUP_ITEMS_ENVELOPE_OVERHEAD_BYTES,
    packState,
  );
  const keptChannelOverrides = packWithinBudget(
    channelOverrides,
    CHANNEL_OVERRIDES_ENVELOPE_OVERHEAD_BYTES,
    packState,
  );
  const keptTrackPrefs = packWithinBudget(
    trackPreferences,
    TRACK_PREFS_ENVELOPE_OVERHEAD_BYTES,
    packState,
  );
  const keptRecentChannels = packWithinBudget(
    recentChannels,
    RECENT_CHANNELS_ENVELOPE_OVERHEAD_BYTES,
    packState,
  );

  return stringifyPayload({
    favorites: keptFavorites,
    progress: keptProgress,
    profiles: keptProfiles,
    parentalSettings: keptParentalSettings,
    parentalLocks: keptParentalLocks,
    trackPreferences: keptTrackPrefs,
    recentChannels: keptRecentChannels,
    channelOverrides: keptChannelOverrides,
    customGroups: keptCustomGroups,
    customGroupItems: keptCustomGroupItems,
  });
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
    parentalSettings?: unknown;
    parentalLocks?: unknown;
    trackPreferences?: unknown;
    recentChannels?: unknown;
    channelOverrides?: unknown;
    customGroups?: unknown;
    customGroupItems?: unknown;
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
  const parentalSettings = Array.isArray(obj.parentalSettings)
    ? obj.parentalSettings
        .map((entry) => parseParentalSettingsEntry(entry))
        .filter((entry): entry is ParentalSettings => entry !== null)
    : [];
  const parentalLocks = Array.isArray(obj.parentalLocks)
    ? obj.parentalLocks
        .map((entry) => parseParentalLockEntry(entry))
        .filter((entry): entry is ParentalLockRecord => entry !== null)
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
  const channelOverrides = Array.isArray(obj.channelOverrides)
    ? obj.channelOverrides
        .map((entry) => parseChannelOverrideEntry(entry))
        .filter((entry): entry is ChannelOverrideRecord => entry !== null)
    : [];
  const customGroups = Array.isArray(obj.customGroups)
    ? obj.customGroups
        .map((entry) => parseCustomGroupEntry(entry))
        .filter((entry): entry is UserDataCustomGroupEntry => entry !== null)
    : [];
  const customGroupItems = Array.isArray(obj.customGroupItems)
    ? obj.customGroupItems
        .map((entry) => parseCustomGroupItemEntry(entry))
        .filter((entry): entry is CustomGroupItemRecord => entry !== null)
    : [];
  return {
    favorites,
    progress,
    profiles,
    ...(parentalSettings.length > 0 ? { parentalSettings } : {}),
    ...(parentalLocks.length > 0 ? { parentalLocks } : {}),
    ...(trackPreferences.length > 0 ? { trackPreferences } : {}),
    ...(recentChannels.length > 0 ? { recentChannels } : {}),
    ...(channelOverrides.length > 0 ? { channelOverrides } : {}),
    ...(customGroups.length > 0 ? { customGroups } : {}),
    ...(customGroupItems.length > 0 ? { customGroupItems } : {}),
  };
}

function readSnapshot(store: UserDataStore): DecodedUserDataSnapshot {
  try {
    return decodeUserDataSnapshot(store.read());
  } catch {
    return { favorites: [], progress: [], profiles: [] };
  }
}

/** Reads `profiles`, `parental_settings`, `parental_locks`, `favorites`, `watch_progress`, `track_preferences`, and `recent_channels` from `db` and persists a budget-safe snapshot to `store`. */
export async function saveUserDataSnapshot(db: SqlDriver, store: UserDataStore): Promise<void> {
  try {
    const [
      rawFavorites,
      rawProgress,
      rawProfiles,
      rawTrackPrefs,
      rawRecentChannels,
      parental,
      channelMgmt,
    ] = await Promise.all([
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
      readParentalBackupRows(db),
      readChannelManagementBackupRows(db),
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
      parentalSettings: parental.parentalSettings,
      parentalLocks: parental.parentalLocks,
      trackPreferences: rawTrackPrefs.map(mapTrackPreferenceRow),
      recentChannels: rawRecentChannels.map(mapRecentChannelRow),
      channelOverrides: channelMgmt.channelOverrides,
      customGroups: channelMgmt.customGroups,
      customGroupItems: channelMgmt.customGroupItems,
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
  const [
    favPresent,
    progPresent,
    trackPresent,
    recentPresent,
    customProfilePresent,
    parentalSettingsPresent,
    parentalLocksPresent,
    overridesPresent,
    customGroupsPresent,
    customGroupItemsPresent,
  ] = await Promise.all([
    db.all<{ found: number }>('SELECT 1 AS found FROM favorites LIMIT 1'),
    db.all<{ found: number }>('SELECT 1 AS found FROM watch_progress LIMIT 1'),
    db.all<{ found: number }>('SELECT 1 AS found FROM track_preferences LIMIT 1'),
    db.all<{ found: number }>('SELECT 1 AS found FROM recent_channels LIMIT 1'),
    db.all<{ found: number }>("SELECT 1 AS found FROM profiles WHERE id != 'default' LIMIT 1"),
    db.all<{ found: number }>('SELECT 1 AS found FROM parental_settings LIMIT 1'),
    db.all<{ found: number }>('SELECT 1 AS found FROM parental_locks LIMIT 1'),
    db.all<{ found: number }>('SELECT 1 AS found FROM channel_overrides LIMIT 1'),
    db.all<{ found: number }>('SELECT 1 AS found FROM custom_groups LIMIT 1'),
    db.all<{ found: number }>('SELECT 1 AS found FROM custom_group_items LIMIT 1'),
  ]);
  if (
    favPresent.length > 0 ||
    progPresent.length > 0 ||
    trackPresent.length > 0 ||
    recentPresent.length > 0 ||
    customProfilePresent.length > 0 ||
    parentalSettingsPresent.length > 0 ||
    parentalLocksPresent.length > 0 ||
    overridesPresent.length > 0 ||
    customGroupsPresent.length > 0 ||
    customGroupItemsPresent.length > 0
  ) {
    await saveUserDataSnapshot(db, store);
    return { favoritesRestored: 0, progressRestored: 0 };
  }
  const snapshot = readSnapshot(store);
  const parentalSettings = snapshot.parentalSettings ?? [];
  const parentalLocks = snapshot.parentalLocks ?? [];
  const trackPrefs = snapshot.trackPreferences ?? [];
  const recentChannels = snapshot.recentChannels ?? [];
  const channelOverrides = snapshot.channelOverrides ?? [];
  const customGroups = snapshot.customGroups ?? [];
  const customGroupItems = snapshot.customGroupItems ?? [];
  if (
    snapshot.favorites.length === 0 &&
    snapshot.progress.length === 0 &&
    snapshot.profiles.length === 0 &&
    parentalSettings.length === 0 &&
    parentalLocks.length === 0 &&
    trackPrefs.length === 0 &&
    recentChannels.length === 0 &&
    channelOverrides.length === 0 &&
    customGroups.length === 0 &&
    customGroupItems.length === 0
  ) {
    return { favoritesRestored: 0, progressRestored: 0 };
  }
  let favoritesRestored = 0;
  let progressRestored = 0;
  let profilesRestored = 0;
  let parentalSettingsRestored = 0;
  let parentalLocksRestored = 0;
  let hasRestoredParentalState = false;
  let trackPreferencesRestored = 0;
  let recentChannelsRestored = 0;
  let channelOverridesRestored = 0;
  let customGroupsRestored = 0;
  let customGroupItemsRestored = 0;
  let hasRestoredCustomNames = false;
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
    const parentalOutcome = await restoreParentalBackupRows(tx, {
      profiles: snapshot.profiles,
      parentalSettings,
      parentalLocks,
    });
    parentalSettingsRestored = parentalOutcome.parentalSettingsRestored;
    parentalLocksRestored = parentalOutcome.parentalLocksRestored;
    hasRestoredParentalState = parentalOutcome.hasParentalState;
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
    const channelMgmtOutcome = await restoreChannelManagementBackupRows(tx, {
      channelOverrides,
      customGroups,
      customGroupItems,
    });
    channelOverridesRestored = channelMgmtOutcome.channelOverridesRestored;
    customGroupsRestored = channelMgmtOutcome.customGroupsRestored;
    customGroupItemsRestored = channelMgmtOutcome.customGroupItemsRestored;
    hasRestoredCustomNames = channelMgmtOutcome.hasCustomNames;
  });
  if (hasRestoredParentalState) {
    markParentalStateDirty(db);
  }
  if (hasRestoredCustomNames) {
    markChannelCustomNamesDirty(db);
  }
  return {
    favoritesRestored,
    progressRestored,
    ...(profilesRestored > 0 ? { profilesRestored } : {}),
    ...(parentalSettingsRestored > 0 ? { parentalSettingsRestored } : {}),
    ...(parentalLocksRestored > 0 ? { parentalLocksRestored } : {}),
    ...(trackPreferencesRestored > 0 ? { trackPreferencesRestored } : {}),
    ...(recentChannelsRestored > 0 ? { recentChannelsRestored } : {}),
    ...(channelOverridesRestored > 0 ? { channelOverridesRestored } : {}),
    ...(customGroupsRestored > 0 ? { customGroupsRestored } : {}),
    ...(customGroupItemsRestored > 0 ? { customGroupItemsRestored } : {}),
  };
}

import { base64UrlDecode, base64UrlEncode } from './encoding';

/** Current encrypted vault snapshot schema version (`#26`, `#510`). */
export const VAULT_SCHEMA_VERSION = 2 as const;

/** Maximum episode index supported by compact watched bitfields (8 KiB max decoded). */
export const MAX_EPISODE_BITFIELD_INDEX = 65_535;

/** Base LWW + tombstone metadata carried by every synced vault entity. */
export interface SyncTombstoneMeta {
  readonly updatedAt: number;
  readonly deleted?: boolean;
}

/** Per-source configuration synced alongside source credentials inside the E2EE vault (`#510`). */
export interface SyncSourceSettings {
  readonly excludedProfileIds?: readonly string[];
  readonly epgShiftMs?: number;
  readonly xmltvTimezone?: string;
  readonly categorySelectionJson?: string;
  readonly transportJson?: string;
  readonly backupServers?: readonly string[];
}

/** Encrypted IPTV source configuration synced inside the user's E2EE vault. */
export interface SyncSourceRecord extends SyncTombstoneMeta {
  readonly id: string;
  readonly kind: 'm3u' | 'xtream' | 'stalker';
  readonly name: string;
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  readonly portalUrl?: string;
  readonly mac?: string;
  readonly serialNumber?: string;
  readonly epgUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly settings?: SyncSourceSettings;
}

/** Tombstone-aware flag entry for favorites, hidden channels, and pinned channels. */
export interface SyncKeyedFlag extends SyncTombstoneMeta {
  readonly key: string;
  readonly sortOrder?: number;
  readonly profileId?: string;
}

/** Custom user channel group synced across devices. */
export interface SyncCustomGroup extends SyncTombstoneMeta {
  readonly id: string;
  readonly name: string;
  readonly channelKeys: readonly string[];
  readonly sortOrder: number;
}

/** Custom VOD collection synced across devices with deterministic LWW folder semantics. */
export interface SyncCollection extends SyncTombstoneMeta {
  readonly id: string;
  readonly name: string;
  readonly itemKeys: readonly string[];
  readonly profileId?: string;
  readonly sortOrder?: number;
}

/** Cross-source per-profile Live TV favorite folder synced across devices (`F-11`). */
export interface SyncLiveFavoriteFolder extends SyncTombstoneMeta {
  readonly id: string;
  readonly name: string;
  readonly channelKeys: readonly string[];
  readonly sortOrder: number;
  readonly profileId?: string;
}

/** Tombstone-aware playback resume entry for movies, episodes, or channels. */
export interface SyncWatchProgress extends SyncTombstoneMeta {
  readonly key: string;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly completed: boolean;
  readonly watched?: boolean;
  readonly profileId?: string;
}

/** Compact watched-episode bitfield for a series (optionally scoped by profile and season). */
export interface SyncEpisodeBitfield extends SyncTombstoneMeta {
  readonly seriesKey: string;
  readonly bitsB64: string;
  readonly profileId?: string;
  readonly season?: number;
}

/** Alias for {@link SyncEpisodeBitfield}. */
export type SyncWatchedBitfield = SyncEpisodeBitfield;

/** Per-profile Continue Watching Next-Up series dismissal merged LWW by `dismissedAt` (`#510`). */
export interface SyncContinueWatchingDismissal {
  readonly profileId: string;
  readonly seriesKey: string;
  readonly sourceId: string;
  readonly dismissedAt: number;
  readonly deleted: boolean;
}

/** Tombstone-aware personal Like/Dislike rating for a Movie or Series. */
export interface SyncRatingRecord extends SyncTombstoneMeta {
  readonly key: string;
  readonly sourceId: string;
  readonly kind: 'movie' | 'series';
  readonly value: 'like' | 'dislike';
  readonly title: string;
  readonly logo?: string | null;
  readonly year?: number | null;
  readonly rating?: number | null;
  readonly profileId?: string;
}

/** Synced household profile with Kids Mode, parental controls, and PBKDF2 PIN hash (strictly inside E2EE vault). */
export interface SyncProfileRecord extends SyncTombstoneMeta {
  readonly id: string;
  readonly name: string;
  readonly avatarToken: string;
  readonly isKids: boolean;
  readonly isDefault: boolean;
  readonly updatedAt: number;
  readonly deleted: boolean;
  readonly pinHash?: string | null;
  readonly parentalEnabled?: boolean;
  readonly parentalMaxRating?: string | null;
}

/** Complete client-side E2EE vault payload (`schemaVersion: 2`). */
export interface VaultSnapshot {
  readonly schemaVersion: typeof VAULT_SCHEMA_VERSION;
  readonly updatedAt: number;
  readonly sources: readonly SyncSourceRecord[];
  readonly favorites: readonly SyncKeyedFlag[];
  readonly hiddenChannels: readonly SyncKeyedFlag[];
  readonly pinnedChannels: readonly SyncKeyedFlag[];
  readonly customGroups: readonly SyncCustomGroup[];
  readonly collections: readonly SyncCollection[];
  readonly watchProgress: readonly SyncWatchProgress[];
  readonly watchedEpisodesBitfields: readonly SyncEpisodeBitfield[];
  readonly continueWatchingDismissals?: readonly SyncContinueWatchingDismissal[];
  readonly ratings?: readonly SyncRatingRecord[];
  readonly profiles?: readonly SyncProfileRecord[];
  readonly liveFavoriteFolders?: readonly SyncLiveFavoriteFolder[];
  readonly initialPreferences?: Readonly<Record<string, unknown>>;
  readonly initialPreferencesUpdatedAt?: number;
}

/** Creates an empty {@link VaultSnapshot} at `updatedAt`. */
export function createEmptyVaultSnapshot(updatedAt = 0): VaultSnapshot {
  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    updatedAt,
    sources: [],
    favorites: [],
    hiddenChannels: [],
    pinnedChannels: [],
    customGroups: [],
    collections: [],
    watchProgress: [],
    watchedEpisodesBitfields: [],
  };
}

function trimTrailingZeroBytes(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && (bytes[end - 1] ?? 0) === 0) end -= 1;
  return bytes.subarray(0, end);
}

/**
 * Encodes a set of zero-based watched episode indices into a compact unpadded base64url bitfield.
 * Invalid, negative, non-integer, or out-of-range indices are ignored.
 */
export function encodeEpisodeBitfield(watchedIndices: Iterable<number>): string {
  let maxIndex = -1;
  const valid: number[] = [];
  for (const idx of watchedIndices) {
    if (!Number.isInteger(idx) || idx < 0 || idx > MAX_EPISODE_BITFIELD_INDEX) continue;
    valid.push(idx);
    if (idx > maxIndex) maxIndex = idx;
  }
  if (maxIndex < 0) return '';
  const bytes = new Uint8Array((maxIndex >> 3) + 1);
  for (const idx of valid) {
    const byteIdx = idx >> 3;
    bytes[byteIdx] = (bytes[byteIdx] ?? 0) | (1 << (idx & 7));
  }
  return base64UrlEncode(trimTrailingZeroBytes(bytes));
}

/** Decodes a compact base64url watched-episode bitfield into sorted zero-based episode indices. */
export function decodeEpisodeBitfield(encoded: string): number[] {
  if (encoded.length === 0) return [];
  const bytes = base64UrlDecode(encoded);
  const indices: number[] = [];
  for (let byteIdx = 0; byteIdx < bytes.length; byteIdx += 1) {
    const byte = bytes[byteIdx] ?? 0;
    if (byte === 0) continue;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((byte & (1 << bit)) !== 0) {
        indices.push((byteIdx << 3) | bit);
      }
    }
  }
  return indices;
}

/** Merges two compact watched-episode bitfields via bitwise OR so watched progress never regresses. */
export function mergeEpisodeBitfields(a: string, b: string): string {
  if (a.length === 0)
    return b.length === 0 ? '' : base64UrlEncode(trimTrailingZeroBytes(base64UrlDecode(b)));
  if (b.length === 0) return base64UrlEncode(trimTrailingZeroBytes(base64UrlDecode(a)));
  const bytesA = base64UrlDecode(a);
  const bytesB = base64UrlDecode(b);
  const maxLen = Math.max(bytesA.length, bytesB.length);
  const merged = new Uint8Array(maxLen);
  for (let i = 0; i < maxLen; i += 1) {
    merged[i] = (bytesA[i] ?? 0) | (bytesB[i] ?? 0);
  }
  return base64UrlEncode(trimTrailingZeroBytes(merged));
}

function normalizeProfileScope(profileId: string | undefined): string {
  return profileId !== undefined && profileId.length > 0 ? profileId : 'default';
}

function pickLwwRecord<T extends SyncTombstoneMeta>(a: T, b: T): T {
  if (a.updatedAt !== b.updatedAt) {
    return a.updatedAt > b.updatedAt ? a : b;
  }
  const aDel = Boolean(a.deleted);
  const bDel = Boolean(b.deleted);
  if (aDel !== bDel) {
    return aDel ? a : b;
  }
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function mergeKeyedCollection<T extends SyncTombstoneMeta>(
  local: readonly T[],
  remote: readonly T[],
  getKey: (item: T) => string,
): T[] {
  const map = new Map<string, T>();
  for (const item of local) {
    const key = getKey(item);
    const prev = map.get(key);
    map.set(key, prev === undefined ? item : pickLwwRecord(prev, item));
  }
  for (const item of remote) {
    const key = getKey(item);
    const prev = map.get(key);
    map.set(key, prev === undefined ? item : pickLwwRecord(prev, item));
  }
  return [...map.entries()]
    .sort(([ka], [kb]) => (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([, value]) => value);
}

function pickLwwDismissal(
  a: SyncContinueWatchingDismissal,
  b: SyncContinueWatchingDismissal,
): SyncContinueWatchingDismissal {
  if (a.dismissedAt !== b.dismissedAt) {
    return a.dismissedAt > b.dismissedAt ? a : b;
  }
  if (a.deleted !== b.deleted) {
    return a.deleted ? a : b;
  }
  return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
}

function mergeDismissalsCollection(
  local: readonly SyncContinueWatchingDismissal[],
  remote: readonly SyncContinueWatchingDismissal[],
): SyncContinueWatchingDismissal[] {
  const map = new Map<string, SyncContinueWatchingDismissal>();
  for (const item of local) {
    const key = `${normalizeProfileScope(item.profileId)}\u0000${item.seriesKey}`;
    const prev = map.get(key);
    map.set(key, prev === undefined ? item : pickLwwDismissal(prev, item));
  }
  for (const item of remote) {
    const key = `${normalizeProfileScope(item.profileId)}\u0000${item.seriesKey}`;
    const prev = map.get(key);
    map.set(key, prev === undefined ? item : pickLwwDismissal(prev, item));
  }
  return [...map.entries()]
    .sort(([ka], [kb]) => (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([, value]) => value);
}

function mergeBitfieldRecord(a: SyncEpisodeBitfield, b: SyncEpisodeBitfield): SyncEpisodeBitfield {
  const aDel = Boolean(a.deleted);
  const bDel = Boolean(b.deleted);
  if (aDel && bDel) {
    return pickLwwRecord(a, b);
  }
  if (aDel) {
    return a.updatedAt >= b.updatedAt ? a : b;
  }
  if (bDel) {
    return b.updatedAt >= a.updatedAt ? b : a;
  }
  const profileId = a.profileId ?? b.profileId;
  return {
    seriesKey: a.seriesKey,
    bitsB64: mergeEpisodeBitfields(a.bitsB64, b.bitsB64),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
    ...(profileId !== undefined ? { profileId } : {}),
    ...(a.season !== undefined ? { season: a.season } : {}),
  };
}

function bitfieldCompositeKey(item: SyncEpisodeBitfield): string {
  const seasonPart = item.season === undefined ? '' : String(item.season);
  return `${normalizeProfileScope(item.profileId)}\u0000${item.seriesKey}\u0000${seasonPart}`;
}

function mergeBitfieldCollection(
  local: readonly SyncEpisodeBitfield[],
  remote: readonly SyncEpisodeBitfield[],
): SyncEpisodeBitfield[] {
  const map = new Map<string, SyncEpisodeBitfield>();
  for (const item of local) {
    const key = bitfieldCompositeKey(item);
    const prev = map.get(key);
    map.set(key, prev === undefined ? item : mergeBitfieldRecord(prev, item));
  }
  for (const item of remote) {
    const key = bitfieldCompositeKey(item);
    const prev = map.get(key);
    map.set(key, prev === undefined ? item : mergeBitfieldRecord(prev, item));
  }
  return [...map.entries()]
    .sort(([ka], [kb]) => (ka < kb ? -1 : ka > kb ? 1 : 0))
    .map(([, value]) => value);
}

function mergeInitialPreferences(
  local: VaultSnapshot,
  remote: VaultSnapshot,
): Pick<VaultSnapshot, 'initialPreferences' | 'initialPreferencesUpdatedAt'> {
  const localPrefs = local.initialPreferences;
  const remotePrefs = remote.initialPreferences;
  if (localPrefs === undefined && remotePrefs === undefined) return {};
  if (localPrefs !== undefined && remotePrefs === undefined) {
    return {
      initialPreferences: localPrefs,
      ...(local.initialPreferencesUpdatedAt !== undefined
        ? { initialPreferencesUpdatedAt: local.initialPreferencesUpdatedAt }
        : {}),
    };
  }
  if (localPrefs === undefined && remotePrefs !== undefined) {
    return {
      initialPreferences: remotePrefs,
      ...(remote.initialPreferencesUpdatedAt !== undefined
        ? { initialPreferencesUpdatedAt: remote.initialPreferencesUpdatedAt }
        : {}),
    };
  }
  const localTs = local.initialPreferencesUpdatedAt ?? 0;
  const remoteTs = remote.initialPreferencesUpdatedAt ?? 0;
  const pickLocal =
    localTs !== remoteTs
      ? localTs > remoteTs
      : JSON.stringify(localPrefs) >= JSON.stringify(remotePrefs);
  const chosenPrefs = pickLocal ? localPrefs : remotePrefs;
  const chosenTs = pickLocal
    ? local.initialPreferencesUpdatedAt
    : remote.initialPreferencesUpdatedAt;
  return {
    ...(chosenPrefs !== undefined ? { initialPreferences: chosenPrefs } : {}),
    ...(chosenTs !== undefined ? { initialPreferencesUpdatedAt: chosenTs } : {}),
  };
}

/**
 * Deterministic, commutative, tombstone-aware LWW merge of two {@link VaultSnapshot} values.
 * Active watched-episode bitfields combine via bitwise OR per `(profileId, seriesKey, season)`
 * while respecting newer tombstones. Collection updates replace `itemKeys` via LWW so item
 * removals and folder moves propagate accurately across devices.
 */
export function mergeVaultSnapshots(local: VaultSnapshot, remote: VaultSnapshot): VaultSnapshot {
  const mergedDismissals = mergeDismissalsCollection(
    local.continueWatchingDismissals ?? [],
    remote.continueWatchingDismissals ?? [],
  );
  const mergedRatings = mergeKeyedCollection(
    local.ratings ?? [],
    remote.ratings ?? [],
    (r) => `${normalizeProfileScope(r.profileId)}\u0000${r.key}`,
  );
  const mergedProfiles = mergeKeyedCollection(
    local.profiles ?? [],
    remote.profiles ?? [],
    (p) => p.id,
  );
  const mergedLiveFavoriteFolders = mergeKeyedCollection(
    local.liveFavoriteFolders ?? [],
    remote.liveFavoriteFolders ?? [],
    (f) => f.id,
  );
  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    sources: mergeKeyedCollection(local.sources, remote.sources, (s) => s.id),
    favorites: mergeKeyedCollection(
      local.favorites,
      remote.favorites,
      (f) => `${normalizeProfileScope(f.profileId)}\u0000${f.key}`,
    ),
    hiddenChannels: mergeKeyedCollection(
      local.hiddenChannels,
      remote.hiddenChannels,
      (h) => `${normalizeProfileScope(h.profileId)}\u0000${h.key}`,
    ),
    pinnedChannels: mergeKeyedCollection(
      local.pinnedChannels,
      remote.pinnedChannels,
      (p) => `${normalizeProfileScope(p.profileId)}\u0000${p.key}`,
    ),
    customGroups: mergeKeyedCollection(local.customGroups, remote.customGroups, (g) => g.id),
    collections: mergeKeyedCollection(local.collections, remote.collections, (c) => c.id),
    watchProgress: mergeKeyedCollection(
      local.watchProgress,
      remote.watchProgress,
      (w) => `${normalizeProfileScope(w.profileId)}\u0000${w.key}`,
    ),
    watchedEpisodesBitfields: mergeBitfieldCollection(
      local.watchedEpisodesBitfields,
      remote.watchedEpisodesBitfields,
    ),
    ...(mergedDismissals.length > 0 ? { continueWatchingDismissals: mergedDismissals } : {}),
    ...(mergedRatings.length > 0 ? { ratings: mergedRatings } : {}),
    ...(mergedProfiles.length > 0 ? { profiles: mergedProfiles } : {}),
    ...(mergedLiveFavoriteFolders.length > 0
      ? { liveFavoriteFolders: mergedLiveFavoriteFolders }
      : {}),
    ...mergeInitialPreferences(local, remote),
  };
}

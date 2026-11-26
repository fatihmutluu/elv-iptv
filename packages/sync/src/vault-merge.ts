import { base64UrlDecode, base64UrlEncode } from './encoding';

/** Current encrypted vault snapshot schema version (`#26`). */
export const VAULT_SCHEMA_VERSION = 1 as const;

/** Maximum episode index supported by compact watched bitfields (8 KiB max decoded). */
export const MAX_EPISODE_BITFIELD_INDEX = 65_535;

/** Base LWW + tombstone metadata carried by every synced vault entity. */
export interface SyncTombstoneMeta {
  readonly updatedAt: number;
  readonly deleted?: boolean;
}

/** Encrypted IPTV source configuration synced inside the user's E2EE vault. */
export interface SyncSourceRecord extends SyncTombstoneMeta {
  readonly id: string;
  readonly kind: 'm3u' | 'xtream';
  readonly name: string;
  readonly url: string;
  readonly username?: string;
  readonly password?: string;
  readonly epgUrl?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Tombstone-aware flag entry for favorites, hidden channels, and pinned channels. */
export interface SyncKeyedFlag extends SyncTombstoneMeta {
  readonly key: string;
}

/** Custom user channel group synced across devices. */
export interface SyncCustomGroup extends SyncTombstoneMeta {
  readonly id: string;
  readonly name: string;
  readonly channelKeys: readonly string[];
  readonly sortOrder: number;
}

/** Custom VOD collection synced across devices. */
export interface SyncCollection extends SyncTombstoneMeta {
  readonly id: string;
  readonly name: string;
  readonly itemKeys: readonly string[];
}

/** Tombstone-aware playback resume entry for movies, episodes, or channels. */
export interface SyncWatchProgress extends SyncTombstoneMeta {
  readonly key: string;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly completed: boolean;
}

/** Compact watched-episode bitfield for a series. */
export interface SyncEpisodeBitfield extends SyncTombstoneMeta {
  readonly seriesKey: string;
  readonly bitsB64: string;
}

/** Complete client-side E2EE vault payload (`schemaVersion: 1`). */
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

function mergeBitfieldRecord(a: SyncEpisodeBitfield, b: SyncEpisodeBitfield): SyncEpisodeBitfield {
  const aDel = Boolean(a.deleted);
  const bDel = Boolean(b.deleted);
  if (aDel && bDel) {
    return a.updatedAt >= b.updatedAt ? a : b;
  }
  if (aDel) {
    return a.updatedAt >= b.updatedAt ? a : b;
  }
  if (bDel) {
    return b.updatedAt >= a.updatedAt ? b : a;
  }
  return {
    seriesKey: a.seriesKey,
    bitsB64: mergeEpisodeBitfields(a.bitsB64, b.bitsB64),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

function mergeBitfieldCollection(
  local: readonly SyncEpisodeBitfield[],
  remote: readonly SyncEpisodeBitfield[],
): SyncEpisodeBitfield[] {
  const map = new Map<string, SyncEpisodeBitfield>();
  for (const item of local) {
    const prev = map.get(item.seriesKey);
    map.set(item.seriesKey, prev === undefined ? item : mergeBitfieldRecord(prev, item));
  }
  for (const item of remote) {
    const prev = map.get(item.seriesKey);
    map.set(item.seriesKey, prev === undefined ? item : mergeBitfieldRecord(prev, item));
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
 * Active watched-episode bitfields combine via bitwise OR while respecting newer tombstones.
 */
export function mergeVaultSnapshots(local: VaultSnapshot, remote: VaultSnapshot): VaultSnapshot {
  return {
    schemaVersion: VAULT_SCHEMA_VERSION,
    updatedAt: Math.max(local.updatedAt, remote.updatedAt),
    sources: mergeKeyedCollection(local.sources, remote.sources, (s) => s.id),
    favorites: mergeKeyedCollection(local.favorites, remote.favorites, (f) => f.key),
    hiddenChannels: mergeKeyedCollection(local.hiddenChannels, remote.hiddenChannels, (h) => h.key),
    pinnedChannels: mergeKeyedCollection(local.pinnedChannels, remote.pinnedChannels, (p) => p.key),
    customGroups: mergeKeyedCollection(local.customGroups, remote.customGroups, (g) => g.id),
    collections: mergeKeyedCollection(local.collections, remote.collections, (c) => c.id),
    watchProgress: mergeKeyedCollection(local.watchProgress, remote.watchProgress, (w) => w.key),
    watchedEpisodesBitfields: mergeBitfieldCollection(
      local.watchedEpisodesBitfields,
      remote.watchedEpisodesBitfields,
    ),
    ...mergeInitialPreferences(local, remote),
  };
}

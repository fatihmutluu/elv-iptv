import { VAULT_SCHEMA_VERSION, type VaultSnapshot } from './vault-merge';

const MAX_INITIAL_PREFERENCES_KEYS = 64;
const MAX_ID_LEN = 256;
const MAX_KEY_LEN = 512;
const MAX_PROFILE_ID_LEN = 128;
const MAX_NAME_LEN = 512;
const MAX_URL_LEN = 4096;
const MAX_SECRET_FIELD_LEN = 1024;
const MAX_JSON_SETTING_LEN = 262_144;
const MAX_HEADERS_COUNT = 64;
const MAX_BACKUP_SERVERS = 32;
const MAX_EXCLUDED_PROFILES = 64;
const MAX_EPG_SHIFT_MS = 86_400_000 * 7;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUnsafeKeys(obj: Record<string, unknown>): boolean {
  return (
    Object.hasOwn(obj, '__proto__') ||
    Object.hasOwn(obj, 'constructor') ||
    Object.hasOwn(obj, 'prototype')
  );
}

function isBoundedString(value: unknown, maxLen: number, allowEmpty = true): value is string {
  if (typeof value !== 'string') return false;
  if (!allowEmpty && value.length === 0) return false;
  return value.length <= maxLen;
}

function isOptionalBoundedString(value: unknown, maxLen: number, allowEmpty = true): boolean {
  return value === undefined || isBoundedString(value, maxLen, allowEmpty);
}

function isOptionalNullableString(value: unknown, maxLen: number): boolean {
  return value === undefined || value === null || isBoundedString(value, maxLen, true);
}

function isFiniteNonNeg(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalBool(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean';
}

function isStringArray(value: unknown, maxItems: number, maxItemLen: number): boolean {
  if (!Array.isArray(value) || value.length > maxItems) return false;
  for (const entry of value) {
    if (!isBoundedString(entry, maxItemLen, true)) return false;
  }
  return true;
}

function isValidHeadersMap(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainObject(value) || hasUnsafeKeys(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > MAX_HEADERS_COUNT) return false;
  for (const [k, v] of entries) {
    if (!isBoundedString(k, 128, false) || !isBoundedString(v, 2048, true)) return false;
  }
  return true;
}

function isValidSourceSettings(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainObject(value) || hasUnsafeKeys(value)) return false;
  if (
    value.excludedProfileIds !== undefined &&
    !isStringArray(value.excludedProfileIds, MAX_EXCLUDED_PROFILES, MAX_PROFILE_ID_LEN)
  ) {
    return false;
  }
  if (
    value.epgShiftMs !== undefined &&
    (!isFiniteNumber(value.epgShiftMs) || Math.abs(value.epgShiftMs) > MAX_EPG_SHIFT_MS)
  ) {
    return false;
  }
  if (!isOptionalBoundedString(value.xmltvTimezone, 128)) return false;
  if (!isOptionalBoundedString(value.categorySelectionJson, MAX_JSON_SETTING_LEN)) return false;
  if (!isOptionalBoundedString(value.transportJson, 32_768)) return false;
  if (
    value.backupServers !== undefined &&
    !isStringArray(value.backupServers, MAX_BACKUP_SERVERS, MAX_URL_LEN)
  ) {
    return false;
  }
  return true;
}

function isValidSources(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.id, MAX_ID_LEN, false)) return false;
    if (item.kind !== 'm3u' && item.kind !== 'xtream' && item.kind !== 'stalker') return false;
    if (!isBoundedString(item.name, MAX_NAME_LEN, true)) return false;
    if (!isBoundedString(item.url, MAX_URL_LEN, true)) return false;
    if (!isFiniteNonNeg(item.updatedAt)) return false;
    if (!isOptionalBool(item.deleted)) return false;
    if (!isOptionalBoundedString(item.username, MAX_SECRET_FIELD_LEN)) return false;
    if (!isOptionalBoundedString(item.password, MAX_SECRET_FIELD_LEN)) return false;
    if (!isOptionalBoundedString(item.portalUrl, MAX_URL_LEN)) return false;
    if (!isOptionalBoundedString(item.mac, 64)) return false;
    if (!isOptionalBoundedString(item.serialNumber, 128)) return false;
    if (!isOptionalBoundedString(item.epgUrl, MAX_URL_LEN)) return false;
    if (!isValidHeadersMap(item.headers)) return false;
    if (!isValidSourceSettings(item.settings)) return false;
  }
  return true;
}

function isValidKeyedFlags(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.key, MAX_KEY_LEN, false)) return false;
    if (!isFiniteNumber(item.updatedAt)) return false;
    if (!isOptionalBool(item.deleted)) return false;
    if (item.sortOrder !== undefined && !isFiniteNumber(item.sortOrder)) return false;
    if (!isOptionalBoundedString(item.profileId, MAX_PROFILE_ID_LEN, false)) return false;
  }
  return true;
}

function isValidCustomGroups(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.id, MAX_ID_LEN, false)) return false;
    if (!isBoundedString(item.name, MAX_NAME_LEN, true)) return false;
    if (!isStringArray(item.channelKeys, 50_000, MAX_KEY_LEN)) return false;
    if (!isFiniteNumber(item.sortOrder)) return false;
    if (!isFiniteNumber(item.updatedAt)) return false;
    if (!isOptionalBool(item.deleted)) return false;
  }
  return true;
}

function isValidCollections(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.id, MAX_ID_LEN, false)) return false;
    if (!isBoundedString(item.name, MAX_NAME_LEN, true)) return false;
    if (!isStringArray(item.itemKeys, 50_000, MAX_KEY_LEN)) return false;
    if (!isFiniteNumber(item.updatedAt)) return false;
    if (!isOptionalBool(item.deleted)) return false;
    if (!isOptionalBoundedString(item.profileId, MAX_PROFILE_ID_LEN, false)) return false;
    if (item.sortOrder !== undefined && !isFiniteNumber(item.sortOrder)) return false;
  }
  return true;
}

function isValidWatchProgress(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.key, MAX_KEY_LEN, false)) return false;
    if (!isFiniteNonNeg(item.positionMs) || !isFiniteNonNeg(item.durationMs)) return false;
    if (typeof item.completed !== 'boolean') return false;
    if (!isFiniteNumber(item.updatedAt)) return false;
    if (!isOptionalBool(item.deleted)) return false;
    if (!isOptionalBool(item.watched)) return false;
    if (!isOptionalBoundedString(item.profileId, MAX_PROFILE_ID_LEN, false)) return false;
  }
  return true;
}

function isValidEpisodeBitfields(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.seriesKey, MAX_KEY_LEN, false)) return false;
    if (!isBoundedString(item.bitsB64, 16_384, true)) return false;
    if (!isFiniteNumber(item.updatedAt)) return false;
    if (!isOptionalBool(item.deleted)) return false;
    if (!isOptionalBoundedString(item.profileId, MAX_PROFILE_ID_LEN, false)) return false;
    if (
      item.season !== undefined &&
      (typeof item.season !== 'number' || !Number.isSafeInteger(item.season) || item.season < 0)
    ) {
      return false;
    }
  }
  return true;
}

function isValidOptionalDismissals(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.profileId, MAX_PROFILE_ID_LEN, false)) return false;
    if (!isBoundedString(item.seriesKey, MAX_KEY_LEN, false)) return false;
    if (!isBoundedString(item.sourceId, MAX_ID_LEN, false)) return false;
    if (!isFiniteNonNeg(item.dismissedAt)) return false;
    if (typeof item.deleted !== 'boolean') return false;
  }
  return true;
}

function isValidOptionalRatings(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.key, MAX_KEY_LEN, false)) return false;
    if (!isBoundedString(item.sourceId, MAX_ID_LEN, false)) return false;
    if (item.kind !== 'movie' && item.kind !== 'series') return false;
    if (item.value !== 'like' && item.value !== 'dislike') return false;
    if (!isBoundedString(item.title, MAX_NAME_LEN, true)) return false;
    if (!isFiniteNumber(item.updatedAt)) return false;
    if (!isOptionalBool(item.deleted)) return false;
    if (!isOptionalBoundedString(item.profileId, MAX_PROFILE_ID_LEN, false)) return false;
    if (!isOptionalNullableString(item.logo, MAX_URL_LEN)) return false;
    if (item.year !== undefined && item.year !== null && !isFiniteNumber(item.year)) return false;
    if (item.rating !== undefined && item.rating !== null && !isFiniteNumber(item.rating)) {
      return false;
    }
  }
  return true;
}

function isValidOptionalProfiles(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.id, MAX_PROFILE_ID_LEN, false)) return false;
    if (!isBoundedString(item.name, 128, true)) return false;
    if (!isBoundedString(item.avatarToken, 128, true)) return false;
    if (typeof item.isKids !== 'boolean' || typeof item.isDefault !== 'boolean') return false;
    if (!isFiniteNonNeg(item.updatedAt)) return false;
    if (typeof item.deleted !== 'boolean') return false;
    if (!isOptionalNullableString(item.pinHash, 512)) return false;
    if (!isOptionalBool(item.parentalEnabled)) return false;
    if (!isOptionalNullableString(item.parentalMaxRating, 64)) return false;
  }
  return true;
}

function isValidOptionalLiveFavoriteFolders(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  for (const item of value) {
    if (!isPlainObject(item) || hasUnsafeKeys(item)) return false;
    if (!isBoundedString(item.id, MAX_ID_LEN, false)) return false;
    if (!isBoundedString(item.name, MAX_NAME_LEN, true)) return false;
    if (!isStringArray(item.channelKeys, 50_000, MAX_KEY_LEN)) return false;
    if (!isFiniteNumber(item.sortOrder)) return false;
    if (!isFiniteNumber(item.updatedAt)) return false;
    if (!isOptionalBool(item.deleted)) return false;
    if (!isOptionalBoundedString(item.profileId, MAX_PROFILE_ID_LEN, false)) return false;
  }
  return true;
}

function isValidOptionalInitialPreferences(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isPlainObject(value) || hasUnsafeKeys(value)) return false;
  return Object.keys(value).length <= MAX_INITIAL_PREFERENCES_KEYS;
}

function isValidOptionalTimestamp(value: unknown): boolean {
  return value === undefined || isFiniteNonNeg(value);
}

/**
 * Strictly validates a decrypted vault snapshot (supporting `schemaVersion` 1 and 2)
 * and upgrades legacy v1 snapshots cleanly into v2 shape with zero data loss.
 */
export function validateAndUpgradeVaultSnapshot(parsed: unknown): VaultSnapshot {
  if (!isPlainObject(parsed) || hasUnsafeKeys(parsed)) {
    throw new Error('Invalid vault snapshot schemaVersion');
  }
  if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== VAULT_SCHEMA_VERSION) {
    throw new Error('Invalid vault snapshot schemaVersion');
  }
  if (
    !isFiniteNumber(parsed.updatedAt) ||
    !isValidSources(parsed.sources) ||
    !isValidKeyedFlags(parsed.favorites) ||
    !isValidKeyedFlags(parsed.hiddenChannels) ||
    !isValidKeyedFlags(parsed.pinnedChannels) ||
    !isValidCustomGroups(parsed.customGroups) ||
    !isValidCollections(parsed.collections) ||
    !isValidWatchProgress(parsed.watchProgress) ||
    !isValidEpisodeBitfields(parsed.watchedEpisodesBitfields) ||
    !isValidOptionalDismissals(parsed.continueWatchingDismissals) ||
    !isValidOptionalRatings(parsed.ratings) ||
    !isValidOptionalProfiles(parsed.profiles) ||
    !isValidOptionalLiveFavoriteFolders(parsed.liveFavoriteFolders) ||
    !isValidOptionalInitialPreferences(parsed.initialPreferences) ||
    !isValidOptionalTimestamp(parsed.initialPreferencesUpdatedAt)
  ) {
    throw new Error('Invalid vault snapshot structure');
  }

  if (parsed.schemaVersion === 1) {
    return {
      ...(parsed as unknown as VaultSnapshot),
      schemaVersion: VAULT_SCHEMA_VERSION,
    };
  }
  return parsed as unknown as VaultSnapshot;
}

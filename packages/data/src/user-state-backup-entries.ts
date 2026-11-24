import { CREDENTIAL_PARAMS } from '@elv/domain';
import { isSafeRecentChannelKey, type RecentChannelRow } from './recent-channels-repo';
import { SOURCE_ID } from './sources';
import {
  clampTrackDelayMs,
  type PersistedTrackPreference,
  sanitizeResizeMode,
  sanitizeTrackLabel,
  sanitizeTrackLang,
} from './track-preferences-repo';
import {
  clampMs,
  type FavoriteRow,
  normalizeProfileId,
  optFloat,
  optInt,
  type UserItemKind,
  type WatchProgressRow,
} from './user-state-helpers';

/** Reserved local profile metadata entry for forward compatibility (`#15`). */
export interface UserDataProfileEntry {
  id: string;
  name: string;
  avatar?: string | null;
  isKids?: boolean;
  createdAt: number;
}

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

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
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

export function parseFavoriteEntry(raw: unknown): FavoriteRow | null {
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

export function parseProgressEntry(raw: unknown): WatchProgressRow | null {
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

export function parseProfileEntry(raw: unknown): UserDataProfileEntry | null {
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

export function compareFavorites(a: FavoriteRow, b: FavoriteRow): number {
  if (b.addedAt !== a.addedAt) return b.addedAt - a.addedAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
}

export function compareProgress(a: WatchProgressRow, b: WatchProgressRow): number {
  if (a.watched !== b.watched) return a.watched ? 1 : -1;
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
}

export function parseTrackPreferenceEntry(raw: unknown): PersistedTrackPreference | null {
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

export function compareTrackPreferences(
  a: PersistedTrackPreference,
  b: PersistedTrackPreference,
): number {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  return a.scopeKey < b.scopeKey ? -1 : a.scopeKey > b.scopeKey ? 1 : 0;
}

export function parseRecentChannelEntry(raw: unknown): RecentChannelRow | null {
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

export function compareRecentChannels(a: RecentChannelRow, b: RecentChannelRow): number {
  if (b.watchedAt !== a.watchedAt) return b.watchedAt - a.watchedAt;
  if (a.profileId !== b.profileId) return a.profileId < b.profileId ? -1 : 1;
  return a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0;
}

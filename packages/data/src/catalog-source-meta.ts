import {
  type DnsFamilyPreference,
  normalizeDnsFamily,
  type TransportSettings,
  validateHostOverride,
} from '@elv/domain';
import { isCredentialFingerprint } from './credential-fingerprint';
import {
  normalizeActiveConnections,
  normalizeMaxConnections,
  type SourceAccountMeta,
  type SourceCategorySelection,
  type SourceKind,
  type SourceRecord,
  type SourceSettings,
} from './sources';

/** A source as the menu shows it. */
export interface SourceRow {
  id: string;
  kind: SourceKind;
  name: string;
  createdAt: number;
  needsImport: boolean;
  lastCatalogSyncAt?: number | null;
  lastGuideSyncAt?: number | null;
  accountMeta?: SourceAccountMeta;
  credentialFingerprint?: string;
  readonly isLocalPlaylist?: boolean;
  readonly categorySelection?: SourceCategorySelection;
  readonly xmltvTimezone?: string;
  readonly allowLegacyTls?: boolean;
  readonly dnsFamily?: DnsFamilyPreference;
  readonly hostOverride?: string;
}

const CATEGORY_SELECTION_KEYS = [
  'live',
  'movie',
  'series',
  'knownLive',
  'knownMovie',
  'knownSeries',
  'pendingLive',
  'pendingMovie',
  'pendingSeries',
] as const;

function sanitizeCategorySelection(raw: unknown): SourceCategorySelection | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Partial<Record<(typeof CATEGORY_SELECTION_KEYS)[number], readonly string[]>> = {};
  let hasAny = false;
  for (const key of CATEGORY_SELECTION_KEYS) {
    const value = src[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
      return undefined;
    }
    out[key] = [...value];
    hasAny = true;
  }
  return hasAny ? (out as SourceCategorySelection) : {};
}

/** @internal Merges a partial `SourceSettings` patch into existing settings, invalidating HTTP cache when needed. */
export function mergeSourceSettings(
  existing: SourceSettings,
  patch: Partial<SourceSettings>,
): SourceSettings {
  const next: SourceSettings = { ...existing };
  let invalidatePlaylistCache = false;
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'isLocalPlaylist') {
      continue;
    }
    if (key === 'xmltvTimezone') {
      if (value === undefined || (typeof value === 'string' && value.trim() === '')) {
        delete next.xmltvTimezone;
      } else if (typeof value === 'string') {
        next.xmltvTimezone = value.trim();
      }
      continue;
    }
    if (key === 'categorySelection') {
      const prevJson = JSON.stringify(existing.categorySelection ?? null);
      if (value === undefined) {
        delete next.categorySelection;
      } else {
        const sanitized = sanitizeCategorySelection(value);
        if (sanitized !== undefined) next.categorySelection = sanitized;
      }
      if (JSON.stringify(next.categorySelection ?? null) !== prevJson) {
        invalidatePlaylistCache = true;
      }
      continue;
    }
    if (key === 'transport') {
      if (value === undefined) {
        delete next.transport;
      } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const mergedTransport: Record<string, unknown> = {
          ...existing.transport,
          ...(value as Record<string, unknown>),
        };
        if (
          'allowLegacyTls' in mergedTransport &&
          mergedTransport.allowLegacyTls !== undefined &&
          typeof mergedTransport.allowLegacyTls !== 'boolean'
        ) {
          delete mergedTransport.allowLegacyTls;
        }
        if ('dnsFamily' in value) {
          const normalized = normalizeDnsFamily((value as Record<string, unknown>).dnsFamily);
          if (normalized === undefined) delete mergedTransport.dnsFamily;
          else mergedTransport.dnsFamily = normalized;
        }
        if ('hostOverride' in value) {
          const rawHost = (value as Record<string, unknown>).hostOverride;
          if (rawHost === undefined || (typeof rawHost === 'string' && rawHost.trim() === '')) {
            delete mergedTransport.hostOverride;
          }
        }
        next.transport = mergedTransport as TransportSettings;
      }
      continue;
    }
    if (key === 'vodPlaylist' || key === 'includePlaceholderChannels') {
      const prevVal = (existing as Record<string, unknown>)[key];
      if (value === undefined) {
        delete (next as Record<string, unknown>)[key];
      } else {
        (next as Record<string, unknown>)[key] = value;
      }
      if ((next as Record<string, unknown>)[key] !== prevVal) {
        invalidatePlaylistCache = true;
      }
      continue;
    }
    if (value === undefined) {
      delete (next as Record<string, unknown>)[key];
    } else {
      (next as Record<string, unknown>)[key] = value;
    }
  }
  if (invalidatePlaylistCache && next.httpCache?.playlist !== undefined) {
    const nextCache = { ...next.httpCache };
    delete nextCache.playlist;
    if (Object.keys(nextCache).length === 0) {
      delete next.httpCache;
    } else {
      next.httpCache = nextCache;
    }
  }
  return next;
}

type ParsedSourceMeta = Pick<
  SourceRow,
  | 'accountMeta'
  | 'credentialFingerprint'
  | 'isLocalPlaylist'
  | 'categorySelection'
  | 'xmltvTimezone'
  | 'allowLegacyTls'
  | 'dnsFamily'
  | 'hostOverride'
>;

/** @internal Extracts non-secret display metadata from `sources.settings_json`. */
export function parseSourceMeta(settingsJson: string): ParsedSourceMeta {
  try {
    const parsed = JSON.parse(settingsJson) as Partial<SourceSettings> | null;
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: {
      accountMeta?: SourceAccountMeta;
      credentialFingerprint?: string;
      isLocalPlaylist?: boolean;
      categorySelection?: SourceCategorySelection;
      xmltvTimezone?: string;
      allowLegacyTls?: boolean;
      dnsFamily?: DnsFamilyPreference;
      hostOverride?: string;
    } = {};
    if (isCredentialFingerprint(parsed.credentialFingerprint)) {
      out.credentialFingerprint = parsed.credentialFingerprint;
    }
    if (typeof parsed.isLocalPlaylist === 'boolean') {
      out.isLocalPlaylist = parsed.isLocalPlaylist;
    }
    if (typeof parsed.xmltvTimezone === 'string' && parsed.xmltvTimezone.trim() !== '') {
      out.xmltvTimezone = parsed.xmltvTimezone.trim();
    }
    if (typeof parsed.transport?.allowLegacyTls === 'boolean') {
      out.allowLegacyTls = parsed.transport.allowLegacyTls;
    }
    const dnsFamily = normalizeDnsFamily(parsed.transport?.dnsFamily);
    if (dnsFamily !== undefined) {
      out.dnsFamily = dnsFamily;
    }
    const hostOverride = validateHostOverride(parsed.transport?.hostOverride);
    if (hostOverride.ok && hostOverride.value !== undefined) {
      out.hostOverride = hostOverride.value;
    }
    if (parsed.categorySelection !== undefined) {
      const sanitized = sanitizeCategorySelection(parsed.categorySelection);
      if (sanitized !== undefined) out.categorySelection = sanitized;
    }
    const meta = parsed.accountMeta;
    if (meta !== null && typeof meta === 'object') {
      const accountMeta: SourceAccountMeta = {};
      if (typeof meta.isTrial === 'boolean') accountMeta.isTrial = meta.isTrial;
      if (typeof meta.expiresAt === 'number' && Number.isFinite(meta.expiresAt)) {
        accountMeta.expiresAt = meta.expiresAt;
      }
      if ('maxConnections' in meta && meta.maxConnections !== undefined) {
        accountMeta.maxConnections = normalizeMaxConnections(meta.maxConnections);
      }
      if ('activeConnections' in meta && meta.activeConnections !== undefined) {
        const active = normalizeActiveConnections(meta.activeConnections);
        if (active !== undefined) accountMeta.activeConnections = active;
      }
      if (
        accountMeta.isTrial !== undefined ||
        accountMeta.expiresAt !== undefined ||
        accountMeta.maxConnections !== undefined ||
        accountMeta.activeConnections !== undefined
      ) {
        out.accountMeta = accountMeta;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** @internal Maps a newly added `SourceRecord` into a `SourceRow`. */
export const mapNewSourceRow = (r: SourceRecord): SourceRow => ({
  id: r.id,
  kind: r.kind,
  name: r.name,
  createdAt: r.createdAt,
  needsImport: true,
  lastCatalogSyncAt: null,
  lastGuideSyncAt: null,
  ...(r.settings.accountMeta === undefined ? {} : { accountMeta: r.settings.accountMeta }),
  ...(isCredentialFingerprint(r.settings.credentialFingerprint)
    ? { credentialFingerprint: r.settings.credentialFingerprint }
    : {}),
  ...(typeof r.settings.isLocalPlaylist === 'boolean'
    ? { isLocalPlaylist: r.settings.isLocalPlaylist }
    : {}),
  ...(r.settings.categorySelection === undefined
    ? {}
    : { categorySelection: r.settings.categorySelection }),
  ...(typeof r.settings.xmltvTimezone === 'string' && r.settings.xmltvTimezone.trim() !== ''
    ? { xmltvTimezone: r.settings.xmltvTimezone.trim() }
    : {}),
  ...(typeof r.settings.transport?.allowLegacyTls === 'boolean'
    ? { allowLegacyTls: r.settings.transport.allowLegacyTls }
    : {}),
  ...(normalizeDnsFamily(r.settings.transport?.dnsFamily) !== undefined
    ? { dnsFamily: normalizeDnsFamily(r.settings.transport?.dnsFamily) as DnsFamilyPreference }
    : {}),
  ...(() => {
    const validated = validateHostOverride(r.settings.transport?.hostOverride);
    return validated.ok && validated.value !== undefined ? { hostOverride: validated.value } : {};
  })(),
});

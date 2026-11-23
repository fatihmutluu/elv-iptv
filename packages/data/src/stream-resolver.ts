import {
  elvError,
  err,
  type HttpClient,
  ok,
  type Result,
  type SecretStore,
  type SqlDriver,
  sanitizeHeaderName,
  sanitizeHeaderValue,
  setSafeHeader,
  type TransportSettings,
  transportHeaders,
} from '@elv/domain';
import { createXtreamClient, resolveXtreamBaseUrl } from '@elv/sources';
import { isCredentialFingerprint, resolveAccountPoolKey } from './credential-fingerprint';
import { placeholderNames } from './m3u-templating';
import { type ItemRow, queryPlayable } from './queries';
import {
  getSource,
  normalizeActiveConnections,
  normalizeMaxConnections,
  type SourceRecord,
  secretKey,
} from './sources';
import { resolveTemplate } from './templates';
import { readUrlVars } from './urlvars-store';

export { readUrlVars };

/** Resolved alternate/backup stream endpoint with its own cloned headers map (`#430`). */
export interface StreamAlternate {
  url: string;
  headers: Record<string, string>;
}

/** What a player needs to open an item. Never log or store it. */
export interface StreamRequest {
  url: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
  /** Opaque account pool key (`credentialFingerprint` when known, else `sourceId`) for connection pooling (`#265`). */
  accountKey?: string;
  /** Normalized per-source concurrent connection limit (`>= 1`, default `1`, `#87`). */
  maxConnections?: number;
  /** Optional provider-reported active connection count when known (`#87`). */
  providerActiveConnections?: number;
  /** Optional resolved backup stream endpoints persisted from M3U `#backup` delimiters (`#430`). */
  alternates?: readonly StreamAlternate[];
  /** Opt-in legacy TLS flag forwarded from the source's transport settings (`#182`). */
  readonly allowLegacyTls?: boolean;
}

/** Alias for {@link StreamRequest}. */
export type ResolvedStream = StreamRequest;

/** Rebuilds the stored templates of one source in memory. */
export interface StreamResolver {
  resolve(template: string): string | undefined;
}

interface XtreamSecret {
  readonly server: string;
  readonly username: string;
  readonly password: string;
}

const MULTICAST_AT_RE = /^(udp|rtp):\/\/@(?=[^:/?#\s])/i;
const ALLOWED_PLAYBACK_SCHEMES: ReadonlySet<string> = new Set([
  'http',
  'https',
  'rtsp',
  'rtsps',
  'rtmp',
  'rtmps',
  'udp',
  'rtp',
]);
const PROTO_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Validates that a play-time stream URL uses an allowlisted streaming transport scheme
 * (`http`, `https`, `rtsp`, `rtsps`, `rtmp`, `rtmps`, `udp`, `rtp`), has a non-empty host, and
 * contains no ASCII control characters. Blocks `file:`, `javascript:`, `data:`, `blob:`,
 * `content:`, `about:`, and malformed URLs.
 */
function isAllowedPlaybackUrl(raw: string): boolean {
  if (hasControlChar(raw)) return false;
  const url = raw.trim();
  if (url.length === 0) return false;
  const sep = url.indexOf('://');
  if (sep <= 0) return false;
  const scheme = url.slice(0, sep).toLowerCase();
  if (!ALLOWED_PLAYBACK_SCHEMES.has(scheme)) return false;
  const after = url.slice(sep + 3);
  if (after.length === 0 || after[0] === '/' || after[0] === '\\') return false;
  const authEnd = after.search(/[/?#\\]/);
  const authority = authEnd < 0 ? after : after.slice(0, authEnd);
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
  return hostPort.length > 0 && !/\s/.test(hostPort);
}

/**
 * Normalizes multicast URLs using leading `@` syntax (`udp://@host:port`, `rtp://@host:port`) to
 * standard `udp://host:port` / `rtp://host:port` form (case-insensitive scheme), leaving all other
 * URLs untouched.
 */
export function normalizeMulticastUrl(url: string): string {
  return url.replace(MULTICAST_AT_RE, '$1://');
}

function resolveAlternates(
  backupUrlsJson: string | null,
  resolver: StreamResolver,
  headers: Record<string, string>,
): StreamAlternate[] | undefined {
  if (backupUrlsJson === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(backupUrlsJson);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const alternates: StreamAlternate[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || item === '') continue;
    const resolved = resolver.resolve(item);
    if (resolved === undefined || resolved === '') continue;
    if (!isAllowedPlaybackUrl(resolved)) continue;
    alternates.push({ url: normalizeMulticastUrl(resolved.trim()), headers: { ...headers } });
  }
  return alternates.length > 0 ? alternates : undefined;
}

/**
 * Reads the `urlvars` secret of a source once and returns a resolver over it, so a screen of logos or a channel
 * switch does not hit the platform secret store per item. Create a new one after an import (values may change).
 */
export async function createStreamResolver(
  sourceId: string,
  deps: { secrets: SecretStore },
): Promise<StreamResolver> {
  const vars = await readUrlVars(deps, sourceId);
  return {
    resolve(template) {
      const missing = placeholderNames(template).some(
        (name) => name !== '(' && !Object.hasOwn(vars, name),
      );
      return missing ? undefined : normalizeMulticastUrl(resolveTemplate(template, vars));
    },
  };
}

function effectiveXtreamTransport(source: SourceRecord): TransportSettings | undefined {
  const transport = source.settings.transport;
  if (transport?.xtreamFormat !== undefined) return transport;
  const formats = source.settings.outputFormats?.map((f) => f.toLowerCase()) ?? [];
  if (formats.includes('m3u8') && !formats.includes('ts')) {
    return { ...transport, xtreamFormat: 'm3u8' };
  }
  return transport;
}

async function loadXtreamSecret(
  secrets: SecretStore,
  sourceId: string,
): Promise<XtreamSecret | undefined> {
  const raw = await secrets.get(secretKey(sourceId, 'xtream')).catch(() => undefined);
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as { server?: unknown; username?: unknown; password?: unknown };
    if (
      typeof parsed.server === 'string' &&
      typeof parsed.username === 'string' &&
      typeof parsed.password === 'string'
    ) {
      return { server: parsed.server, username: parsed.username, password: parsed.password };
    }
  } catch {
    // Malformed secret JSON falls through to undefined
  }
  return undefined;
}

/** @internal Session cache for M3U `urlvars` resolvers and Xtream secrets, evicted on source mutations. */
export interface PlaytimeResolverCache {
  evict(sourceId: string): void;
  clear(): void;
  resolveLogos<T extends ItemRow>(items: T[], sourceId: string): Promise<T[]>;
  resolveRowLogos<T extends { sourceId: string; logo: string | null }>(rows: T[]): Promise<T[]>;
  resolveStream(itemKey: string): Promise<Result<StreamRequest>>;
}

const notFound = () => err(elvError('storage', 'item-not-found'));

export function createPlaytimeResolverCache(deps: {
  db: SqlDriver;
  secrets: SecretStore;
  http: HttpClient;
}): PlaytimeResolverCache {
  const resolvers = new Map<string, Promise<StreamResolver>>();
  const xtreamSecrets = new Map<string, Promise<XtreamSecret | undefined>>();

  const resolverFor = (sourceId: string): Promise<StreamResolver> => {
    let cached = resolvers.get(sourceId);
    if (cached === undefined) {
      cached = createStreamResolver(sourceId, { secrets: deps.secrets });
      resolvers.set(sourceId, cached);
    }
    return cached;
  };

  const xtreamSecretFor = (sourceId: string): Promise<XtreamSecret | undefined> => {
    let cached = xtreamSecrets.get(sourceId);
    if (cached === undefined) {
      cached = loadXtreamSecret(deps.secrets, sourceId).then((res) => {
        if (res === undefined) xtreamSecrets.delete(sourceId);
        return res;
      });
      xtreamSecrets.set(sourceId, cached);
    }
    return cached;
  };

  return {
    evict(sourceId) {
      resolvers.delete(sourceId);
      xtreamSecrets.delete(sourceId);
    },

    clear() {
      resolvers.clear();
      xtreamSecrets.clear();
    },

    async resolveLogos(items, sourceId) {
      if (!items.some((i) => i.logo?.includes('{{'))) return items;
      const resolver = await resolverFor(sourceId);
      return items.map((i) =>
        i.logo === null ? i : { ...i, logo: resolver.resolve(i.logo) ?? null },
      );
    },

    async resolveRowLogos(rows) {
      if (!rows.some((r) => r.logo?.includes('{{'))) return rows;
      const sourceIds = new Set<string>();
      for (const row of rows) {
        if (row.logo?.includes('{{')) sourceIds.add(row.sourceId);
      }
      const loaded = new Map<string, StreamResolver>();
      for (const sid of sourceIds) {
        loaded.set(sid, await resolverFor(sid));
      }
      return rows.map((row) => {
        if (row.logo === null || !row.logo.includes('{{')) return row;
        const resolver = loaded.get(row.sourceId);
        return { ...row, logo: resolver?.resolve(row.logo) ?? null };
      });
    },

    async resolveStream(itemKey) {
      const play = await queryPlayable(deps.db, itemKey);
      if (play === undefined) return notFound();
      const source = await getSource(deps.db, play.sourceId);
      if (source === undefined) return notFound();
      const headers = transportHeaders(source.settings.transport);
      const fp = source.settings.credentialFingerprint;
      const accountKey = resolveAccountPoolKey({
        id: source.id,
        ...(isCredentialFingerprint(fp) ? { credentialFingerprint: fp } : {}),
      });
      const maxConnections = normalizeMaxConnections(source.settings.accountMeta?.maxConnections);
      const providerActiveConnections = normalizeActiveConnections(
        source.settings.accountMeta?.activeConnections,
      );
      const connectionMeta = {
        maxConnections,
        ...(providerActiveConnections !== undefined ? { providerActiveConnections } : {}),
        ...(source.settings.transport?.allowLegacyTls === true ? { allowLegacyTls: true } : {}),
      };

      if (play.urlTemplate === null) {
        const creds = await xtreamSecretFor(play.sourceId);
        if (creds === undefined) return err(elvError('storage', 'secret-missing'));
        const id = Number(play.providerId);
        if (play.providerId === null || !Number.isFinite(id)) return notFound();
        const transport = effectiveXtreamTransport(source);
        const server = creds.server.includes('://')
          ? creds.server
          : resolveXtreamBaseUrl(creds.server, deps.http);
        const client = createXtreamClient({
          http: deps.http,
          server,
          username: creds.username,
          password: creds.password,
          ...(transport === undefined ? {} : { transport }),
        });
        const rawXtreamUrl = client.streamUrl(play.streamKind, id, play.extension ?? undefined);
        if (!isAllowedPlaybackUrl(rawXtreamUrl)) {
          return err(elvError('playback', 'unsupported-scheme'));
        }
        return ok({
          url: normalizeMulticastUrl(rawXtreamUrl.trim()),
          headers,
          accountKey,
          ...connectionMeta,
        });
      }

      const resolver = await resolverFor(play.sourceId);
      const url = resolver.resolve(play.urlTemplate);
      if (url === undefined) {
        resolvers.delete(play.sourceId);
        return err(elvError('storage', 'secret-missing'));
      }
      if (!isAllowedPlaybackUrl(url)) {
        return err(elvError('playback', 'unsupported-scheme'));
      }
      const finalUrl = normalizeMulticastUrl(url.trim());
      if (play.headersJson !== null) {
        interface StoredHeadersJson {
          userAgent?: unknown;
          referer?: unknown;
          other?: unknown;
        }
        let extra: StoredHeadersJson | null = null;
        try {
          const parsed: unknown = JSON.parse(play.headersJson);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            extra = parsed as StoredHeadersJson;
          }
        } catch {
          extra = null;
        }
        if (extra !== null) {
          if (
            typeof extra.other === 'object' &&
            extra.other !== null &&
            !Array.isArray(extra.other)
          ) {
            for (const [k, v] of Object.entries(extra.other as Record<string, unknown>)) {
              if (typeof v !== 'string') continue;
              const lowerName = k.toLowerCase();
              if (PROTO_KEYS.has(lowerName)) continue;
              const resolved = resolver.resolve(v);
              if (resolved === undefined) {
                resolvers.delete(play.sourceId);
                return err(elvError('storage', 'secret-missing'));
              }
              const cleanName = sanitizeHeaderName(lowerName);
              const cleanValue = sanitizeHeaderValue(resolved);
              if (cleanName !== undefined && !PROTO_KEYS.has(cleanName) && cleanValue.length > 0) {
                setSafeHeader(headers, cleanName, cleanValue);
              }
            }
          }
          if (typeof extra.userAgent === 'string') {
            const resolvedUa = resolver.resolve(extra.userAgent);
            if (resolvedUa === undefined) {
              resolvers.delete(play.sourceId);
              return err(elvError('storage', 'secret-missing'));
            }
            const ua = sanitizeHeaderValue(resolvedUa);
            if (ua.length > 0) headers['user-agent'] = ua;
          }
          if (typeof extra.referer === 'string') {
            const referer = resolver.resolve(extra.referer);
            if (referer === undefined) {
              resolvers.delete(play.sourceId);
              return err(elvError('storage', 'secret-missing'));
            }
            const cleanRef = sanitizeHeaderValue(referer);
            if (cleanRef.length > 0) headers.referer = cleanRef;
          }
        }
      }
      const alternates = resolveAlternates(play.backupUrlsJson, resolver, headers);
      return ok({
        url: finalUrl,
        headers,
        accountKey,
        ...connectionMeta,
        ...(alternates === undefined ? {} : { alternates }),
      });
    },
  };
}

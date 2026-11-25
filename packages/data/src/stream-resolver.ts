import {
  type DrmConfig,
  elvError,
  err,
  type HttpClient,
  hostnameOf,
  normalizeDnsFamily,
  ok,
  type Result,
  type SecretStore,
  type SqlDriver,
  sanitizeHeaderName,
  sanitizeHeaderValue,
  setSafeHeader,
  type TransportSettings,
  transportHeaders,
  validateHostOverride,
} from '@elv/domain';
import { createXtreamClient, resolveXtreamBaseUrl, type XtreamClient } from '@elv/sources';
import { isCredentialFingerprint, resolveAccountPoolKey } from './credential-fingerprint';
import { type DrmSpecMap, loadDrmSpecs } from './drm-secret-store';
import { getFailoverGroupByChannel } from './failover-groups-repo';
import { placeholderNames } from './m3u-templating';
import { queryPlayable } from './queries';
import {
  getSource,
  normalizeActiveConnections,
  normalizeMaxConnections,
  type SourceRecord,
  secretKey,
} from './sources';
import { resolveCatchupStreamInternal } from './stream-resolver-catchup';
import { createStalkerResolverState } from './stream-resolver-stalker';
import type {
  PlaytimeResolverCache,
  ResolveStreamInternalOptions,
  SourceStreamMeta,
  StreamAlternate,
  StreamRequest,
  StreamResolver,
  XtreamSecret,
} from './stream-resolver-types';
import { resolveTemplate } from './templates';
import { readUrlVars } from './urlvars-store';

export type {
  CatchupProgrammeInput,
  PlaytimeResolverCache,
  ResolvedStream,
  StreamAlternate,
  StreamRequest,
  StreamResolver,
} from './stream-resolver-types';
export { readUrlVars };

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
const notFound = () => err(elvError('storage', 'item-not-found'));

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

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

function cloneDrmConfig(cfg: DrmConfig): DrmConfig {
  return {
    scheme: cfg.scheme,
    ...(cfg.licenseUrl !== undefined ? { licenseUrl: cfg.licenseUrl } : {}),
    ...(cfg.licenseHeaders !== undefined ? { licenseHeaders: { ...cfg.licenseHeaders } } : {}),
    ...(cfg.clearKeys !== undefined
      ? { clearKeys: cfg.clearKeys.map((pair) => ({ kid: pair.kid, key: pair.key })) }
      : {}),
    ...(cfg.multiSession !== undefined ? { multiSession: cfg.multiSession } : {}),
  };
}

function resolveInlineAlternates(
  backupUrlsJson: string | null,
  resolver: StreamResolver,
  headers: Record<string, string>,
  transportMeta: Pick<
    SourceStreamMeta['connectionMeta'],
    'allowLegacyTls' | 'dnsFamily' | 'hostOverride'
  >,
  primaryHost: string | undefined,
  drm?: DrmConfig,
): StreamAlternate[] {
  if (backupUrlsJson === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(backupUrlsJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const alternates: StreamAlternate[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string' || item === '') continue;
    const resolved = resolver.resolve(item);
    if (resolved === undefined || resolved === '') continue;
    if (!isAllowedPlaybackUrl(resolved)) continue;
    const normalizedUrl = normalizeMulticastUrl(resolved.trim());
    const useHostOverride =
      transportMeta.hostOverride !== undefined &&
      primaryHost !== undefined &&
      hostnameOf(normalizedUrl) === primaryHost;
    alternates.push({
      url: normalizedUrl,
      headers: { ...headers },
      ...(transportMeta.allowLegacyTls === true ? { allowLegacyTls: true } : {}),
      ...(transportMeta.dnsFamily !== undefined ? { dnsFamily: transportMeta.dnsFamily } : {}),
      ...(useHostOverride ? { hostOverride: transportMeta.hostOverride } : {}),
      ...(drm !== undefined ? { drm: cloneDrmConfig(drm) } : {}),
    });
  }
  return alternates;
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
    const parsed = JSON.parse(raw) as {
      server?: unknown;
      username?: unknown;
      password?: unknown;
      backupServers?: unknown;
    };
    if (
      typeof parsed.server === 'string' &&
      typeof parsed.username === 'string' &&
      typeof parsed.password === 'string'
    ) {
      const backupServers = Array.isArray(parsed.backupServers)
        ? parsed.backupServers.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
        : undefined;
      return {
        server: parsed.server,
        username: parsed.username,
        password: parsed.password,
        ...(backupServers !== undefined && backupServers.length > 0 ? { backupServers } : {}),
      };
    }
  } catch {
    // Malformed secret JSON falls through to undefined
  }
  return undefined;
}

function applyStoredHeadersJson(
  headersJson: string | null,
  resolver: StreamResolver,
  headers: Record<string, string>,
): boolean {
  if (headersJson === null) return true;
  interface StoredHeadersJson {
    userAgent?: unknown;
    referer?: unknown;
    other?: unknown;
  }
  let extra: StoredHeadersJson | null = null;
  try {
    const parsed: unknown = JSON.parse(headersJson);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      extra = parsed as StoredHeadersJson;
    }
  } catch {
    extra = null;
  }
  if (extra === null) return true;
  if (typeof extra.other === 'object' && extra.other !== null && !Array.isArray(extra.other)) {
    for (const [k, v] of Object.entries(extra.other as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      const lowerName = k.toLowerCase();
      if (PROTO_KEYS.has(lowerName)) continue;
      const resolved = resolver.resolve(v);
      if (resolved === undefined) return false;
      const cleanName = sanitizeHeaderName(lowerName);
      const cleanValue = sanitizeHeaderValue(resolved);
      if (cleanName !== undefined && !PROTO_KEYS.has(cleanName) && cleanValue.length > 0) {
        setSafeHeader(headers, cleanName, cleanValue);
      }
    }
  }
  if (typeof extra.userAgent === 'string') {
    const resolvedUa = resolver.resolve(extra.userAgent);
    if (resolvedUa === undefined) return false;
    const ua = sanitizeHeaderValue(resolvedUa);
    if (ua.length > 0) headers['user-agent'] = ua;
  }
  if (typeof extra.referer === 'string') {
    const referer = resolver.resolve(extra.referer);
    if (referer === undefined) return false;
    const cleanRef = sanitizeHeaderValue(referer);
    if (cleanRef.length > 0) headers.referer = cleanRef;
  }
  return true;
}

function buildSourceStreamMeta(source: SourceRecord): SourceStreamMeta {
  const transport = source.settings.transport;
  const headers = transportHeaders(transport);
  const fp = source.settings.credentialFingerprint;
  const accountKey = resolveAccountPoolKey({
    id: source.id,
    ...(isCredentialFingerprint(fp) ? { credentialFingerprint: fp } : {}),
  });
  const maxConnections = normalizeMaxConnections(source.settings.accountMeta?.maxConnections);
  const providerActiveConnections = normalizeActiveConnections(
    source.settings.accountMeta?.activeConnections,
  );
  const dnsFamily = normalizeDnsFamily(transport?.dnsFamily);
  const hostRes = validateHostOverride(transport?.hostOverride);
  const hostOverride = hostRes.ok ? hostRes.value : undefined;
  return {
    headers,
    accountKey,
    connectionMeta: {
      maxConnections,
      ...(providerActiveConnections !== undefined ? { providerActiveConnections } : {}),
      ...(transport?.allowLegacyTls === true ? { allowLegacyTls: true } : {}),
      ...(dnsFamily !== undefined ? { dnsFamily } : {}),
      ...(hostOverride !== undefined ? { hostOverride } : {}),
    },
  };
}

function toAlternateFromRequest(req: StreamRequest): StreamAlternate {
  return {
    url: req.url,
    headers: { ...req.headers },
    ...(req.accountKey !== undefined ? { accountKey: req.accountKey } : {}),
    ...(req.maxConnections !== undefined ? { maxConnections: req.maxConnections } : {}),
    ...(req.sourceId !== undefined ? { sourceId: req.sourceId } : {}),
    ...(req.channelKey !== undefined ? { channelKey: req.channelKey } : {}),
    ...(req.allowLegacyTls === true ? { allowLegacyTls: true } : {}),
    ...(req.dnsFamily !== undefined ? { dnsFamily: req.dnsFamily } : {}),
    ...(req.hostOverride !== undefined ? { hostOverride: req.hostOverride } : {}),
    ...(req.drm !== undefined ? { drm: cloneDrmConfig(req.drm) } : {}),
  };
}

function deduplicateAlternates(
  primaryUrl: string,
  candidates: readonly StreamAlternate[],
): StreamAlternate[] | undefined {
  if (candidates.length === 0) return undefined;
  const seenUrls = new Set<string>([primaryUrl.trim()]);
  const out: StreamAlternate[] = [];
  for (const alt of candidates) {
    const normalizedUrl = alt.url.trim();
    if (normalizedUrl === '' || seenUrls.has(normalizedUrl)) continue;
    seenUrls.add(normalizedUrl);
    out.push(alt);
  }
  return out.length > 0 ? out : undefined;
}

export function createPlaytimeResolverCache(deps: {
  db: SqlDriver;
  secrets: SecretStore;
  http: HttpClient;
  clock?: () => number;
  primaryCooldownMs?: number;
}): PlaytimeResolverCache {
  const resolvers = new Map<string, Promise<StreamResolver>>();
  const drmSpecsCache = new Map<string, Promise<DrmSpecMap>>();
  const xtreamSecrets = new Map<string, Promise<XtreamSecret | undefined>>();
  const xtreamClients = new Map<string, XtreamClient>();
  const stalkerState = createStalkerResolverState({ secrets: deps.secrets, http: deps.http });

  const drmSpecsFor = (sourceId: string): Promise<DrmSpecMap> => {
    let cached = drmSpecsCache.get(sourceId);
    if (cached === undefined) {
      cached = loadDrmSpecs(deps.secrets, sourceId);
      drmSpecsCache.set(sourceId, cached);
    }
    return cached;
  };

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

  const xtreamClientFor = async (source: SourceRecord): Promise<XtreamClient | undefined> => {
    const existing = xtreamClients.get(source.id);
    if (existing !== undefined) return existing;
    const creds = await xtreamSecretFor(source.id);
    if (creds === undefined) return undefined;
    const transport = effectiveXtreamTransport(source);
    const client = createXtreamClient({
      http: deps.http,
      server: creds.server,
      ...(creds.backupServers !== undefined && creds.backupServers.length > 0
        ? { backupServers: creds.backupServers }
        : {}),
      username: creds.username,
      password: creds.password,
      ...(transport === undefined ? {} : { transport }),
      ...(deps.primaryCooldownMs !== undefined
        ? { primaryCooldownMs: deps.primaryCooldownMs }
        : {}),
      ...(deps.clock !== undefined ? { rateLimit: { now: deps.clock } } : {}),
    });
    xtreamClients.set(source.id, client);
    return client;
  };

  async function resolveSingleStream(
    itemKey: string,
    includeGroupAlternates: boolean,
    isAlternateRestricted?: ResolveStreamInternalOptions['isAlternateRestricted'],
  ): Promise<Result<StreamRequest>> {
    const play = await queryPlayable(deps.db, itemKey);
    if (play === undefined) return notFound();
    const source = await getSource(deps.db, play.sourceId);
    if (source === undefined) return notFound();
    const { headers, accountKey, connectionMeta } = buildSourceStreamMeta(source);

    let primaryUrl: string;
    let primaryHostOverride = connectionMeta.hostOverride;
    let drm: DrmConfig | undefined;
    const collectedAlternates: StreamAlternate[] = [];

    const drmMetaRows = await deps.db.all<{ scheme: string }>(
      'SELECT scheme FROM item_drm_meta WHERE source_id = ? AND item_key = ? LIMIT 1',
      [play.sourceId, itemKey],
    );
    if (drmMetaRows.length > 0) {
      const specs = await drmSpecsFor(play.sourceId);
      const foundDrm = specs[itemKey];
      if (foundDrm !== undefined && foundDrm.scheme === drmMetaRows[0]?.scheme) {
        drm = cloneDrmConfig(foundDrm);
      } else {
        drmSpecsCache.delete(play.sourceId);
      }
    }

    if (source.kind === 'stalker') {
      const stalkerRes = await stalkerState.resolvePrimaryUrl(
        source,
        play,
        connectionMeta,
        isAllowedPlaybackUrl,
        normalizeMulticastUrl,
      );
      if (!stalkerRes.ok) return stalkerRes;
      primaryUrl = stalkerRes.value.url;
      primaryHostOverride = stalkerRes.value.hostOverride;
    } else if (play.urlTemplate === null) {
      const client = await xtreamClientFor(source);
      if (client === undefined) return err(elvError('storage', 'secret-missing'));
      const creds = await xtreamSecretFor(source.id);
      const xtreamPrimaryHost =
        creds !== undefined ? hostnameOf(resolveXtreamBaseUrl(creds.server, deps.http)) : undefined;
      const scopedHostOverride = (url: string): string | undefined =>
        connectionMeta.hostOverride !== undefined &&
        xtreamPrimaryHost !== undefined &&
        hostnameOf(url) === xtreamPrimaryHost
          ? connectionMeta.hostOverride
          : undefined;
      const id = Number(play.providerId);
      if (play.providerId === null || !Number.isFinite(id)) return notFound();
      const rawUrls = client.streamUrls(play.streamKind, id, play.extension ?? undefined);
      const firstRaw = rawUrls[0];
      if (firstRaw === undefined || !isAllowedPlaybackUrl(firstRaw)) {
        return err(elvError('playback', 'unsupported-scheme'));
      }
      primaryUrl = normalizeMulticastUrl(firstRaw.trim());
      primaryHostOverride = scopedHostOverride(primaryUrl);
      for (let i = 1; i < rawUrls.length; i += 1) {
        const candidate = rawUrls[i];
        if (candidate === undefined || !isAllowedPlaybackUrl(candidate)) continue;
        const normalizedCandidate = normalizeMulticastUrl(candidate.trim());
        const altHostOverride = scopedHostOverride(normalizedCandidate);
        collectedAlternates.push({
          url: normalizedCandidate,
          headers: { ...headers },
          accountKey,
          maxConnections: connectionMeta.maxConnections,
          sourceId: play.sourceId,
          channelKey: itemKey,
          ...(connectionMeta.allowLegacyTls === true ? { allowLegacyTls: true } : {}),
          ...(connectionMeta.dnsFamily !== undefined
            ? { dnsFamily: connectionMeta.dnsFamily }
            : {}),
          ...(altHostOverride !== undefined ? { hostOverride: altHostOverride } : {}),
        });
      }
    } else {
      const resolver = await resolverFor(play.sourceId);
      const url = resolver.resolve(play.urlTemplate);
      if (url === undefined) {
        resolvers.delete(play.sourceId);
        return err(elvError('storage', 'secret-missing'));
      }
      if (!isAllowedPlaybackUrl(url)) {
        return err(elvError('playback', 'unsupported-scheme'));
      }
      primaryUrl = normalizeMulticastUrl(url.trim());
      if (!applyStoredHeadersJson(play.headersJson, resolver, headers)) {
        resolvers.delete(play.sourceId);
        return err(elvError('storage', 'secret-missing'));
      }
      collectedAlternates.push(
        ...resolveInlineAlternates(
          play.backupUrlsJson,
          resolver,
          headers,
          connectionMeta,
          hostnameOf(primaryUrl),
          drm,
        ),
      );
    }

    if (includeGroupAlternates && play.streamKind === 'live') {
      const group = await getFailoverGroupByChannel(deps.db, itemKey);
      if (group !== undefined) {
        for (const member of group.members) {
          if (member.channelKey === itemKey) continue;
          if (
            isAlternateRestricted !== undefined &&
            (await isAlternateRestricted(member.channelKey))
          ) {
            continue;
          }
          const sibling = await resolveSingleStream(member.channelKey, false);
          if (!sibling.ok) continue;
          collectedAlternates.push(toAlternateFromRequest(sibling.value));
          if (sibling.value.alternates !== undefined) {
            for (const sub of sibling.value.alternates) {
              collectedAlternates.push({
                ...sub,
                headers: { ...sub.headers },
                ...(sub.accountKey === undefined && sibling.value.accountKey !== undefined
                  ? { accountKey: sibling.value.accountKey }
                  : {}),
                ...(sub.maxConnections === undefined && sibling.value.maxConnections !== undefined
                  ? { maxConnections: sibling.value.maxConnections }
                  : {}),
                ...(sub.sourceId === undefined && sibling.value.sourceId !== undefined
                  ? { sourceId: sibling.value.sourceId }
                  : {}),
                ...(sub.channelKey === undefined && sibling.value.channelKey !== undefined
                  ? { channelKey: sibling.value.channelKey }
                  : {}),
              });
            }
          }
        }
      }
    }

    const alternates = deduplicateAlternates(primaryUrl, collectedAlternates);
    const { hostOverride: _ignoredHostOverride, ...restConnectionMeta } = connectionMeta;
    return ok({
      url: primaryUrl,
      headers,
      accountKey,
      sourceId: play.sourceId,
      channelKey: itemKey,
      ...restConnectionMeta,
      ...(primaryHostOverride !== undefined ? { hostOverride: primaryHostOverride } : {}),
      ...(drm === undefined ? {} : { drm }),
      ...(alternates === undefined ? {} : { alternates }),
    });
  }

  return {
    evict(sourceId) {
      resolvers.delete(sourceId);
      drmSpecsCache.delete(sourceId);
      xtreamSecrets.delete(sourceId);
      xtreamClients.delete(sourceId);
      stalkerState.evict(sourceId);
    },

    clear() {
      resolvers.clear();
      drmSpecsCache.clear();
      xtreamSecrets.clear();
      xtreamClients.clear();
      stalkerState.clear();
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

    resolveStream: (itemKey, opts) =>
      resolveSingleStream(itemKey, true, opts?.isAlternateRestricted),

    resolveCatchupStream: (itemKey, programme, nowMs) =>
      resolveCatchupStreamInternal(itemKey, programme, nowMs, {
        db: deps.db,
        http: deps.http,
        resolverFor,
        evictResolver: (sid) => {
          resolvers.delete(sid);
        },
        xtreamSecretFor,
        stalkerState,
        buildSourceStreamMeta,
        effectiveXtreamTransport,
        isAllowedPlaybackUrl,
        normalizeMulticastUrl,
        applyStoredHeadersJson,
      }),

    reportStreamOutcome(sourceId, serverUrl, succeeded) {
      const client = xtreamClients.get(sourceId);
      if (client === undefined) return;
      if (succeeded) {
        client.reportStreamSuccess(serverUrl);
      } else {
        client.reportStreamFailure(serverUrl);
      }
    },
  };
}

import {
  elvError,
  err,
  type HttpClient,
  hostnameOf,
  ok,
  type Result,
  type SecretStore,
} from '@elv/domain';
import {
  buildCatchupUrl,
  createStalkerClient,
  type StalkerClient,
  type StalkerLinkKind,
  stripStalkerCommandPrefix,
} from '@elv/sources';
import type { PlayableRow } from './queries';
import { isSecretKeyRotatedError } from './secret-errors';
import type { SourceRecord } from './sources';
import {
  loadStalkerCmdMap,
  loadStalkerSecret,
  parseEpisodeMeta,
  type StalkerCmdMap,
  type StalkerEpisodeMeta,
  type StalkerSecret,
  saveStalkerDiscovery,
  stalkerCmdKey,
  stalkerEpisodeMetaKey,
  stalkerPortalHost,
  stalkerStaticFlagKey,
} from './stalker-secret';
import type {
  CatchupProgrammeInput,
  SourceStreamMeta,
  StreamRequest,
} from './stream-resolver-types';

/** @internal Session-scoped Stalker client and command-map cache owned by `PlaytimeResolverCache`. */
export interface StalkerResolverState {
  evict(sourceId: string): void;
  clear(): void;
  resolvePrimaryUrl(
    source: SourceRecord,
    play: PlayableRow,
    connectionMeta: SourceStreamMeta['connectionMeta'],
    isAllowedPlaybackUrl: (raw: string) => boolean,
    normalizeMulticastUrl: (url: string) => string,
  ): Promise<Result<{ url: string; hostOverride?: string; headers?: Record<string, string> }>>;
  resolveCatchup(
    source: SourceRecord,
    itemKey: string,
    providerId: string | null,
    catchupDays: number | null,
    programme: CatchupProgrammeInput,
    nowMs: number,
    meta: SourceStreamMeta,
    isAllowedPlaybackUrl: (raw: string) => boolean,
    normalizeMulticastUrl: (url: string) => string,
  ): Promise<Result<StreamRequest>>;
}

const notFound = () => err(elvError('storage', 'item-not-found'));
const HTTP_SCHEME_RE = /^https?:\/\//i;
// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects ASCII control chars in direct URLs
const CONTROL_OR_SPACE_RE = /[\u0000-\u0020\u007f]|\s/;

function isLocalStalkerStreamHost(rawHostname: string): boolean {
  const unbracketed =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname;
  const host = unbracketed.toLowerCase().replace(/\.+$/, '');
  if (host === '' || host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0' || host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (/^127\./.test(host)) return true;
  if (
    /^::ffff:127\./i.test(host) ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/i.test(host) ||
    /^::ffff:0(?::0|\.0\.0\.0)$/i.test(host)
  ) {
    return true;
  }
  return false;
}

/**
 * Returns the direct static playback URL ONLY when `kind` is `'live'` or `'movie'`, BOTH
 * `use_http_tmp_link === false` and `use_load_balancing === false` were explicitly observed, and
 * the stripped command is a non-local remote `http(s)://` URL. Never skips `create_link` for
 * `series`, loopback/local hosts, relative paths, or unflagged items.
 */
function resolveStaticDirectUrl(
  kind: PlayableRow['streamKind'],
  cmd: string,
  isStaticFlagged: boolean,
): string | undefined {
  if ((kind !== 'live' && kind !== 'movie') || !isStaticFlagged) return undefined;
  const stripped = stripStalkerCommandPrefix(cmd);
  if (
    stripped.length === 0 ||
    CONTROL_OR_SPACE_RE.test(stripped) ||
    !HTTP_SCHEME_RE.test(stripped)
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(stripped);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.hostname === '') {
      return undefined;
    }
    if (isLocalStalkerStreamHost(parsed.hostname)) return undefined;
    return stripped;
  } catch {
    return undefined;
  }
}

/** @internal Creates session-scoped Stalker resolver state evicted on source mutations/removals. */
export function createStalkerResolverState(deps: {
  secrets: SecretStore;
  http: HttpClient;
}): StalkerResolverState {
  const secretCache = new Map<string, Promise<StalkerSecret | undefined>>();
  const cmdCache = new Map<string, Promise<StalkerCmdMap>>();
  const clientCache = new Map<string, StalkerClient>();

  const secretFor = (sourceId: string): Promise<StalkerSecret | undefined> => {
    let cached = secretCache.get(sourceId);
    if (cached === undefined) {
      cached = loadStalkerSecret(deps.secrets, sourceId).then(
        (res) => {
          if (res === undefined) secretCache.delete(sourceId);
          return res;
        },
        (error: unknown) => {
          secretCache.delete(sourceId);
          throw error;
        },
      );
      secretCache.set(sourceId, cached);
    }
    return cached;
  };

  const cmdsFor = (sourceId: string): Promise<StalkerCmdMap> => {
    let cached = cmdCache.get(sourceId);
    if (cached === undefined) {
      cached = loadStalkerCmdMap(deps.secrets, sourceId).catch((error: unknown) => {
        cmdCache.delete(sourceId);
        throw error;
      });
      cmdCache.set(sourceId, cached);
    }
    return cached;
  };

  const clientFor = async (
    source: SourceRecord,
  ): Promise<{ client: StalkerClient; secret: StalkerSecret } | undefined> => {
    const secret = await secretFor(source.id);
    if (secret === undefined) return undefined;
    let client = clientCache.get(source.id);
    if (client === undefined) {
      client = createStalkerClient({
        http: deps.http,
        portalUrl: secret.portalUrl,
        mac: secret.mac,
        ...(secret.serialNumber !== undefined ? { serialNumber: secret.serialNumber } : {}),
        ...(secret.discoveredEndpoint !== undefined
          ? { discoveredEndpoint: secret.discoveredEndpoint }
          : {}),
        ...(secret.portalMode !== undefined ? { portalMode: secret.portalMode } : {}),
        ...(secret.deviceId !== undefined ? { deviceId: secret.deviceId } : {}),
        ...(secret.deviceId2 !== undefined ? { deviceId2: secret.deviceId2 } : {}),
        ...(secret.signature !== undefined ? { signature: secret.signature } : {}),
        ...(secret.login !== undefined ? { login: secret.login } : {}),
        ...(secret.password !== undefined ? { password: secret.password } : {}),
        ...(source.settings.serverTimezone ? { timezone: source.settings.serverTimezone } : {}),
        ...(source.settings.transport !== undefined
          ? { transport: source.settings.transport }
          : {}),
      });
      clientCache.set(source.id, client);
    }
    return { client, secret };
  };

  const persistDiscoveryIfChanged = async (
    sourceId: string,
    secret: StalkerSecret,
    client: StalkerClient,
  ): Promise<void> => {
    if (!secretCache.has(sourceId)) return;
    const discovered = client.discoveredPortal();
    if (discovered === undefined) return;
    if (
      secret.discoveredEndpoint === discovered.endpoint &&
      secret.portalMode === discovered.mode
    ) {
      return;
    }
    const updated = await saveStalkerDiscovery(deps.secrets, sourceId, secret, discovered);
    if (secretCache.has(sourceId) && updated !== secret) {
      secretCache.set(sourceId, Promise.resolve(updated));
    }
  };

  const resolveCmdContext = async (
    sourceId: string,
    kind: PlayableRow['streamKind'],
    providerId: string,
  ): Promise<{
    cmd: string;
    isStaticFlagged: boolean;
    episodeMeta?: StalkerEpisodeMeta;
  }> => {
    const key = stalkerCmdKey(kind, providerId);
    let cmds = await cmdsFor(sourceId);
    if (cmds[key] === undefined || cmds[key] === '') {
      // Reload once in case lazy episode loading updated stalker_cmds after initial cache fill
      cmdCache.delete(sourceId);
      cmds = await cmdsFor(sourceId);
    }
    const cmd = cmds[key] || providerId;
    const isStaticFlagged =
      (kind === 'live' || kind === 'movie') && cmds[stalkerStaticFlagKey(kind, providerId)] === '1';
    const episodeMeta =
      kind === 'series' ? parseEpisodeMeta(cmds[stalkerEpisodeMetaKey(providerId)]) : undefined;
    return {
      cmd,
      isStaticFlagged,
      ...(episodeMeta !== undefined ? { episodeMeta } : {}),
    };
  };

  const scopeHostOverride = (
    url: string,
    portalUrl: string,
    configured: string | undefined,
  ): string | undefined => {
    if (configured === undefined) return undefined;
    const primaryHost = stalkerPortalHost(portalUrl);
    return primaryHost !== undefined && hostnameOf(url) === primaryHost ? configured : undefined;
  };

  return {
    evict(sourceId) {
      secretCache.delete(sourceId);
      cmdCache.delete(sourceId);
      clientCache.delete(sourceId);
    },

    clear() {
      secretCache.clear();
      cmdCache.clear();
      clientCache.clear();
    },

    async resolvePrimaryUrl(
      source,
      play,
      connectionMeta,
      isAllowedPlaybackUrl,
      normalizeMulticastUrl,
    ) {
      if (play.providerId === null || play.providerId.trim() === '') return notFound();
      let loaded: { client: StalkerClient; secret: StalkerSecret } | undefined;
      let ctx: Awaited<ReturnType<typeof resolveCmdContext>>;
      try {
        loaded = await clientFor(source);
        if (loaded === undefined) return err(elvError('storage', 'secret-missing'));
        ctx = await resolveCmdContext(source.id, play.streamKind, play.providerId);
      } catch (error) {
        if (isSecretKeyRotatedError(error)) return err(elvError('storage', 'secret-key-rotated'));
        throw error;
      }

      const staticDirect = resolveStaticDirectUrl(play.streamKind, ctx.cmd, ctx.isStaticFlagged);
      let rawUrl: string;
      if (staticDirect !== undefined) {
        rawUrl = staticDirect;
      } else {
        const linkKind: StalkerLinkKind =
          play.streamKind === 'series' ? (ctx.episodeMeta?.linkKind ?? 'series') : play.streamKind;
        const epNum =
          play.streamKind === 'series'
            ? ctx.episodeMeta !== undefined
              ? ctx.episodeMeta.episodeNumber
              : typeof play.episodeNumber === 'number' && Number.isFinite(play.episodeNumber)
                ? play.episodeNumber
                : undefined
            : undefined;
        const minted = await loaded.client.createLink(
          linkKind,
          ctx.cmd,
          epNum !== undefined ? { episodeNumber: epNum } : undefined,
        );
        if (!minted.ok) return minted;
        rawUrl = minted.value;
        await persistDiscoveryIfChanged(source.id, loaded.secret, loaded.client);
      }

      if (!isAllowedPlaybackUrl(rawUrl)) {
        return err(elvError('playback', 'unsupported-scheme'));
      }
      const url = normalizeMulticastUrl(rawUrl.trim());
      const hostOverride = scopeHostOverride(
        url,
        loaded.secret.portalUrl,
        connectionMeta.hostOverride,
      );
      const headers = loaded.client.playbackHeadersFor(url);
      return ok({
        url,
        ...(hostOverride === undefined ? {} : { hostOverride }),
        headers,
      });
    },

    async resolveCatchup(
      source,
      itemKey,
      providerId,
      catchupDays,
      programme,
      nowMs,
      meta,
      isAllowedPlaybackUrl,
      normalizeMulticastUrl,
    ) {
      if (providerId === null || providerId.trim() === '') return notFound();
      let loaded: { client: StalkerClient; secret: StalkerSecret } | undefined;
      let ctx: Awaited<ReturnType<typeof resolveCmdContext>>;
      try {
        loaded = await clientFor(source);
        if (loaded === undefined) return err(elvError('storage', 'secret-missing'));
        ctx = await resolveCmdContext(source.id, 'live', providerId);
      } catch (error) {
        if (isSecretKeyRotatedError(error)) return err(elvError('storage', 'secret-key-rotated'));
        throw error;
      }

      const staticDirect = resolveStaticDirectUrl('live', ctx.cmd, ctx.isStaticFlagged);
      let liveUrl: string;
      if (staticDirect !== undefined) {
        liveUrl = staticDirect;
      } else {
        const minted = await loaded.client.createLink('live', ctx.cmd);
        if (!minted.ok) return minted;
        liveUrl = minted.value;
        await persistDiscoveryIfChanged(source.id, loaded.secret, loaded.client);
      }

      const built = buildCatchupUrl({
        mode: 'stalker',
        liveUrl,
        ...(source.settings.serverTimezone
          ? { serverTimezone: source.settings.serverTimezone }
          : {}),
        programme,
        catchupDays,
        nowMs,
      });
      if (!built.ok) return built;
      if (!isAllowedPlaybackUrl(built.value)) {
        return err(elvError('playback', 'unsupported-scheme'));
      }
      const url = normalizeMulticastUrl(built.value.trim());
      const hostOverride = scopeHostOverride(
        url,
        loaded.secret.portalUrl,
        meta.connectionMeta.hostOverride,
      );
      const portalHeaders = loaded.client.playbackHeadersFor(url);
      const headers = { ...meta.headers, ...portalHeaders };
      const { hostOverride: _ignored, ...restConnectionMeta } = meta.connectionMeta;
      return ok({
        url,
        headers,
        accountKey: meta.accountKey,
        sourceId: source.id,
        channelKey: itemKey,
        ...restConnectionMeta,
        ...(hostOverride === undefined ? {} : { hostOverride }),
      });
    },
  };
}

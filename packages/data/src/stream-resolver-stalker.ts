import {
  elvError,
  err,
  type HttpClient,
  hostnameOf,
  ok,
  type Result,
  type SecretStore,
} from '@elv/domain';
import { buildCatchupUrl, createStalkerClient, type StalkerClient } from '@elv/sources';
import type { PlayableRow } from './queries';
import type { SourceRecord } from './sources';
import {
  loadStalkerCmdMap,
  loadStalkerSecret,
  type StalkerCmdMap,
  type StalkerSecret,
  stalkerCmdKey,
  stalkerPortalHost,
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
  ): Promise<Result<{ url: string; hostOverride?: string }>>;
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
      cached = loadStalkerSecret(deps.secrets, sourceId).then((res) => {
        if (res === undefined) secretCache.delete(sourceId);
        return res;
      });
      secretCache.set(sourceId, cached);
    }
    return cached;
  };

  const cmdsFor = (sourceId: string): Promise<StalkerCmdMap> => {
    let cached = cmdCache.get(sourceId);
    if (cached === undefined) {
      cached = loadStalkerCmdMap(deps.secrets, sourceId);
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
        ...(source.settings.serverTimezone ? { timezone: source.settings.serverTimezone } : {}),
        ...(source.settings.transport !== undefined
          ? { transport: source.settings.transport }
          : {}),
      });
      clientCache.set(source.id, client);
    }
    return { client, secret };
  };

  const resolveCmd = async (
    sourceId: string,
    kind: PlayableRow['streamKind'],
    providerId: string,
  ): Promise<string> => {
    const key = stalkerCmdKey(kind, providerId);
    const cmds = await cmdsFor(sourceId);
    const existing = cmds[key];
    if (existing !== undefined && existing !== '') return existing;
    // Reload once in case lazy episode loading updated stalker_cmds after initial cache fill
    cmdCache.delete(sourceId);
    const refreshed = await cmdsFor(sourceId);
    return refreshed[key] || providerId;
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
      const loaded = await clientFor(source);
      if (loaded === undefined) return err(elvError('storage', 'secret-missing'));
      const cmd = await resolveCmd(source.id, play.streamKind, play.providerId);
      const minted = await loaded.client.createLink(
        play.streamKind,
        cmd,
        play.streamKind === 'series' &&
          typeof play.episodeNumber === 'number' &&
          Number.isFinite(play.episodeNumber)
          ? { episodeNumber: play.episodeNumber }
          : undefined,
      );
      if (!minted.ok) return minted;
      if (!isAllowedPlaybackUrl(minted.value)) {
        return err(elvError('playback', 'unsupported-scheme'));
      }
      const url = normalizeMulticastUrl(minted.value.trim());
      const hostOverride = scopeHostOverride(
        url,
        loaded.secret.portalUrl,
        connectionMeta.hostOverride,
      );
      return ok({ url, ...(hostOverride === undefined ? {} : { hostOverride }) });
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
      const loaded = await clientFor(source);
      if (loaded === undefined) return err(elvError('storage', 'secret-missing'));
      const cmd = await resolveCmd(source.id, 'live', providerId);
      const minted = await loaded.client.createLink('live', cmd);
      if (!minted.ok) return minted;
      const built = buildCatchupUrl({
        mode: 'stalker',
        liveUrl: minted.value,
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
      const { hostOverride: _ignored, ...restConnectionMeta } = meta.connectionMeta;
      return ok({
        url,
        headers: meta.headers,
        accountKey: meta.accountKey,
        sourceId: source.id,
        channelKey: itemKey,
        ...restConnectionMeta,
        ...(hostOverride === undefined ? {} : { hostOverride }),
      });
    },
  };
}

import {
  type ElvError,
  elvError,
  err,
  hostnameOf,
  httpStatusError,
  normalizeMacAddress,
  ok,
  type Result,
  sanitizeHeaderValue,
  transportHeaders,
} from '@elv/domain';
import { detectAndDecodeText } from './encoding';
import {
  buildStalkerCookieHeader,
  buildStalkerPlaybackHeaders,
  buildStalkerProfileQuery,
  buildStalkerRequestHeaders,
  classifyGenresProbePayload,
  deriveCfduidFromSerial,
  isHostLevelNetworkError,
  looksLikeHtmlResponse,
  payloadIndicatesAuthFailure,
  pickMoreSpecificDiscoveryError,
  textIndicatesAuthFailure,
} from './stalker-protocol';
import {
  toStalkerCategories,
  toStalkerChannels,
  toStalkerEpgEntries,
  toStalkerEpgMap,
  toStalkerEpisodeFiles,
  toStalkerEpisodes,
  toStalkerPage,
  toStalkerProfile,
  toStalkerSeasons,
  toStalkerSeriesItems,
  toStalkerVodItems,
  toStalkerWatchdogEvent,
} from './stalker-records';
import type {
  StalkerCallOptions,
  StalkerClient,
  StalkerClientOptions,
  StalkerLinkKind,
  StalkerPortalMode,
  StalkerSeason,
} from './stalker-types';
import {
  deriveStalkerRedirectCandidates,
  discardStalkerBody,
  encodeStalkerCmdQueryValue,
  normalizeStalkerPortalUrl,
  readBoundedStalkerBody,
  stripStalkerCommandPrefix,
  validateStalkerStreamUrl,
} from './stalker-url';
import { parseXtreamJson } from './xtream-json';
import { isRaw } from './xtream-records';

export type * from './stalker-types';
export { normalizeStalkerPortalUrl, stripStalkerCommandPrefix };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_DISCOVERY_CANDIDATES = 16;
const MAX_SEASON_PAGES = 200;

const shapeError = () => elvError('source-format', 'unexpected-shape');
const unauthorizedError = () => elvError('auth', 'unauthorized');

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const n = Math.trunc(value);
  return n >= 1 ? n : fallback;
}

function linkKindToType(kind: StalkerLinkKind): 'itv' | 'vod' | 'series' {
  if (kind === 'live') return 'itv';
  if (kind === 'movie') return 'vod';
  return 'series';
}

type FetchOutcome =
  | { kind: 'ok'; json: unknown; finalUrl?: string }
  | { kind: 'html-redirect'; finalUrl: string }
  | { kind: 'auth-failed' }
  | { kind: 'not-found' }
  | { kind: 'error'; error: ElvError };

/**
 * Creates a credential-isolated Stalker/Ministra MAC portal client.
 * `portalUrl`, `mac`, `serialNumber`, optional STB identity/login fields, and `bearerToken` stay
 * strictly inside the closure and are never returned in records or error details.
 */
export function createStalkerClient(options: StalkerClientOptions): StalkerClient {
  const { http, transport } = options;
  const normalizedMac = normalizeMacAddress(options.mac);
  const normalizedPortal = normalizeStalkerPortalUrl(options.portalUrl);
  const configError = !normalizedMac.ok
    ? normalizedMac.error
    : !normalizedPortal.ok
      ? normalizedPortal.error
      : undefined;

  const mac = normalizedMac.ok ? normalizedMac.value : '';
  const initialCandidates = normalizedPortal.ok
    ? [...(normalizedPortal.value.candidates ?? [normalizedPortal.value.endpoint])]
    : [];

  const persistedEndpoint =
    options.discoveredEndpoint !== undefined &&
    normalizeStalkerPortalUrl(options.discoveredEndpoint).ok
      ? options.discoveredEndpoint.trim()
      : undefined;
  const persistedMode: StalkerPortalMode | undefined =
    options.portalMode === 'simple' || options.portalMode === 'full'
      ? options.portalMode
      : undefined;

  let activeEndpoint =
    persistedEndpoint ?? (normalizedPortal.ok ? normalizedPortal.value.endpoint : '');
  let portalMode: StalkerPortalMode | undefined =
    persistedEndpoint !== undefined ? persistedMode : undefined;
  let discovered = persistedEndpoint !== undefined && persistedMode !== undefined;
  let bearerToken: string | undefined;

  const serialNumber = options.serialNumber?.trim() || undefined;
  const cfduid = serialNumber !== undefined ? deriveCfduidFromSerial(serialNumber) : undefined;
  const deviceId = options.deviceId?.trim() || undefined;
  const deviceId2 = options.deviceId2?.trim() || undefined;
  const signature = options.signature?.trim() || undefined;
  const login = options.login?.trim() || undefined;
  const password =
    options.password !== undefined && options.password !== '' ? options.password : undefined;

  const stbLang = sanitizeHeaderValue(options.language ?? 'en') || 'en';
  let activeTimezone = sanitizeHeaderValue(options.timezone ?? 'UTC') || 'UTC';

  const maxBodyBytes = Math.max(1024, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const baseHeaders = transportHeaders(transport);
  const hostOverride = transport?.hostOverride?.trim() || undefined;
  const primaryHost = normalizedPortal.ok ? hostnameOf(normalizedPortal.value.endpoint) : undefined;

  function currentCookieHeader(): string {
    return buildStalkerCookieHeader({
      mac,
      stbLang,
      timezone: activeTimezone,
      ...(cfduid !== undefined ? { cfduid } : {}),
    });
  }

  async function requestEndpoint(
    endpoint: string,
    query: string,
    includeAuth: boolean,
    call?: StalkerCallOptions,
    skipGuard = false,
  ): Promise<FetchOutcome> {
    if (call?.signal?.aborted) return { kind: 'error', error: elvError('network', 'aborted') };
    const headers = buildStalkerRequestHeaders({
      baseHeaders,
      cookie: currentCookieHeader(),
      ...(includeAuth && bearerToken !== undefined ? { bearerToken } : {}),
      ...(serialNumber !== undefined ? { serialNumber } : {}),
    });
    const useHostOverride =
      hostOverride !== undefined &&
      primaryHost !== undefined &&
      hostnameOf(endpoint) === primaryHost;

    let response: Awaited<ReturnType<typeof http.get>>;
    try {
      response = await http.get(`${endpoint}?${query}`, {
        headers,
        timeoutMs,
        ...(transport?.allowLegacyTls ? { allowLegacyTls: true } : {}),
        ...(transport?.dnsFamily !== undefined ? { dnsFamily: transport.dnsFamily } : {}),
        ...(useHostOverride ? { hostOverride } : {}),
        ...(skipGuard ? { skipGuard: true } : {}),
        ...(call?.signal ? { signal: call.signal } : {}),
      });
    } catch {
      return {
        kind: 'error',
        error: call?.signal?.aborted
          ? elvError('network', 'aborted')
          : elvError('network', 'request-failed'),
      };
    }

    if (!response.ok) {
      const { category, code } = response.error;
      if (category === 'auth' && (code === 'http-401' || code === 'http-403')) {
        return { kind: 'auth-failed' };
      }
      if (category === 'network' && code === 'http-404') return { kind: 'not-found' };
      return { kind: 'error', error: elvError(category, code) };
    }

    const { status, body, headers: resHeaders, finalUrl } = response.value;
    if (status === 401 || status === 403) {
      await discardStalkerBody(body);
      return { kind: 'auth-failed' };
    }
    if (status === 404) {
      await discardStalkerBody(body);
      return { kind: 'not-found' };
    }
    if (status < 200 || status >= 300) {
      await discardStalkerBody(body);
      return { kind: 'error', error: httpStatusError(status) };
    }
    if (call?.signal?.aborted) {
      await discardStalkerBody(body);
      return { kind: 'error', error: elvError('network', 'aborted') };
    }

    const bytes = await readBoundedStalkerBody(body, maxBodyBytes);
    if (!bytes.ok) return { kind: 'error', error: bytes.error };
    const text = detectAndDecodeText(bytes.value);
    const parsed = parseXtreamJson(text);
    if (!parsed.ok) {
      if (textIndicatesAuthFailure(text)) return { kind: 'auth-failed' };
      if (finalUrl !== undefined && looksLikeHtmlResponse(resHeaders, text)) {
        return { kind: 'html-redirect', finalUrl };
      }
      return { kind: 'error', error: parsed.error };
    }
    if (payloadIndicatesAuthFailure(parsed.value)) return { kind: 'auth-failed' };
    return { kind: 'ok', json: parsed.value, ...(finalUrl !== undefined ? { finalUrl } : {}) };
  }

  async function handshakeOnEndpoint(
    endpoint: string,
    call?: StalkerCallOptions,
    skipGuard = false,
  ): Promise<Result<string>> {
    const query = 'type=stb&action=handshake&token=&JsHttpRequest=1-xml';
    const outcome = await requestEndpoint(endpoint, query, false, call, skipGuard);
    if (outcome.kind === 'auth-failed') return err(unauthorizedError());
    if (outcome.kind === 'not-found') return err(httpStatusError(404));
    if (outcome.kind === 'html-redirect') return err(shapeError());
    if (outcome.kind === 'error') return err(outcome.error);

    if (!isRaw(outcome.json) || !('js' in outcome.json)) return err(shapeError());
    const js = outcome.json.js;
    if (js === false) return err(unauthorizedError());
    if (!isRaw(js)) return err(shapeError());
    const rawToken = typeof js.token === 'string' ? js.token.trim() : '';
    const cleanToken = sanitizeHeaderValue(rawToken);
    if (rawToken.length === 0 || cleanToken !== rawToken) return err(unauthorizedError());
    return ok(cleanToken);
  }

  async function discoverPortal(
    call?: StalkerCallOptions,
    skipEndpoint?: string,
    seedRedirectUrl?: string,
  ): Promise<Result<void>> {
    if (configError !== undefined) return err(configError);
    const baseInitialUrl = normalizedPortal.ok
      ? normalizedPortal.value.endpoint
      : options.portalUrl;
    const queue: string[] = [];
    const seen = new Set<string>();
    if (skipEndpoint !== undefined) seen.add(skipEndpoint);
    if (seedRedirectUrl !== undefined) {
      for (const next of deriveStalkerRedirectCandidates(baseInitialUrl, seedRedirectUrl)) {
        if (seen.size >= MAX_DISCOVERY_CANDIDATES) break;
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    for (const candidate of initialCandidates) {
      if (seen.size >= MAX_DISCOVERY_CANDIDATES) break;
      if (!seen.has(candidate)) {
        seen.add(candidate);
        queue.push(candidate);
      }
    }
    if (skipEndpoint !== undefined && queue.length === 0) {
      queue.push(skipEndpoint);
    }

    let bestError: ElvError | undefined;

    for (let idx = 0; idx < queue.length; idx += 1) {
      const candidate = queue[idx] as string;
      const probe = await requestEndpoint(
        candidate,
        'type=itv&action=get_genres&JsHttpRequest=1-xml',
        false,
        call,
        true,
      );

      if (probe.kind === 'error') {
        if (probe.error.code === 'aborted') return err(probe.error);
        if (isHostLevelNetworkError(probe.error)) {
          const candidateHost = hostnameOf(candidate);
          const hasOtherHostPending = queue
            .slice(idx + 1)
            .some((u) => hostnameOf(u) !== candidateHost);
          if (!hasOtherHostPending) return err(probe.error);
        }
        bestError = pickMoreSpecificDiscoveryError(bestError, probe.error);
        continue;
      }

      if (probe.kind === 'html-redirect') {
        const derived = deriveStalkerRedirectCandidates(baseInitialUrl, probe.finalUrl);
        for (const next of derived) {
          if (seen.size >= MAX_DISCOVERY_CANDIDATES) break;
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
        bestError = pickMoreSpecificDiscoveryError(bestError, httpStatusError(404));
        continue;
      }

      if (probe.kind === 'not-found') {
        bestError = pickMoreSpecificDiscoveryError(bestError, httpStatusError(404));
        continue;
      }

      if (probe.kind === 'auth-failed') {
        const hs = await handshakeOnEndpoint(candidate, call, true);
        if (hs.ok) {
          activeEndpoint = candidate;
          portalMode = 'full';
          bearerToken = hs.value;
          discovered = true;
          return ok(undefined);
        }
        if (hs.error.code === 'aborted') return hs;
        bestError = pickMoreSpecificDiscoveryError(bestError, unauthorizedError());
        continue;
      }

      const kind = classifyGenresProbePayload(probe.json);
      if (kind === 'valid-non-empty') {
        activeEndpoint = candidate;
        portalMode = 'simple';
        bearerToken = undefined;
        discovered = true;
        return ok(undefined);
      }

      const hs = await handshakeOnEndpoint(candidate, call, true);
      if (hs.ok) {
        activeEndpoint = candidate;
        portalMode = 'full';
        bearerToken = hs.value;
        discovered = true;
        return ok(undefined);
      }
      if (hs.error.code === 'aborted') return hs;

      if (kind === 'valid-empty') {
        activeEndpoint = candidate;
        portalMode = 'simple';
        bearerToken = undefined;
        discovered = true;
        return ok(undefined);
      }
      bestError = pickMoreSpecificDiscoveryError(bestError, hs.error);
    }

    bearerToken = undefined;
    return err(bestError ?? httpStatusError(404));
  }

  async function ensureReady(call?: StalkerCallOptions): Promise<Result<void>> {
    if (configError !== undefined) return err(configError);
    if (!discovered) return discoverPortal(call);
    if (portalMode === 'simple') return ok(undefined);
    if (bearerToken !== undefined) return ok(undefined);

    const hs = await handshakeOnEndpoint(activeEndpoint, call);
    if (hs.ok) {
      bearerToken = hs.value;
      return ok(undefined);
    }
    if (hs.error.code === 'aborted' || isHostLevelNetworkError(hs.error)) return hs;
    if (hs.error.code === 'http-404' || hs.error.category === 'auth') {
      return discoverPortal(call, activeEndpoint);
    }
    return hs;
  }

  async function authedJs(query: string, call?: StalkerCallOptions): Promise<Result<unknown>> {
    const ready = await ensureReady(call);
    if (!ready.ok) return ready;

    const send = () => requestEndpoint(activeEndpoint, query, portalMode === 'full', call);
    let outcome = await send();

    if (outcome.kind === 'auth-failed') {
      if (portalMode === 'full') {
        bearerToken = undefined;
        const rehs = await handshakeOnEndpoint(activeEndpoint, call);
        if (rehs.ok) {
          bearerToken = rehs.value;
          outcome = await send();
          if (outcome.kind === 'auth-failed') {
            bearerToken = undefined;
            return err(unauthorizedError());
          }
        } else {
          if (rehs.error.code === 'aborted' || isHostLevelNetworkError(rehs.error)) return rehs;
          const repaired = await discoverPortal(call, activeEndpoint);
          if (!repaired.ok) return err(rehs.error);
          outcome = await send();
          if (outcome.kind === 'auth-failed') {
            bearerToken = undefined;
            return err(unauthorizedError());
          }
        }
      } else {
        const repaired = await discoverPortal(call);
        if (!repaired.ok) return repaired;
        outcome = await send();
        if (outcome.kind === 'auth-failed') {
          bearerToken = undefined;
          return err(unauthorizedError());
        }
      }
    } else if (outcome.kind === 'not-found' || outcome.kind === 'html-redirect') {
      const failedEndpoint = activeEndpoint;
      const seedUrl = outcome.kind === 'html-redirect' ? outcome.finalUrl : undefined;
      discovered = false;
      bearerToken = undefined;
      const repaired = await discoverPortal(call, failedEndpoint, seedUrl);
      if (!repaired.ok) {
        return err(outcome.kind === 'not-found' ? httpStatusError(404) : shapeError());
      }
      outcome = await send();
      if (outcome.kind === 'auth-failed') {
        bearerToken = undefined;
        return err(unauthorizedError());
      }
    }

    if (outcome.kind === 'not-found') return err(httpStatusError(404));
    if (outcome.kind === 'html-redirect') return err(shapeError());
    if (outcome.kind === 'error') return err(outcome.error);
    if (!isRaw(outcome.json) || !('js' in outcome.json)) return err(shapeError());
    return ok(outcome.json.js);
  }

  async function authedList<T>(
    query: string,
    mapRows: (rows: unknown[]) => T[],
    call?: StalkerCallOptions,
  ): Promise<Result<T[]>> {
    const r = await authedJs(query, call);
    if (!r.ok) return r;
    if (Array.isArray(r.value)) return ok(mapRows(r.value));
    if (isRaw(r.value) && Array.isArray(r.value.data)) return ok(mapRows(r.value.data));
    return err(shapeError());
  }

  async function authedPage<T>(
    query: string,
    page: number,
    mapRows: (rows: unknown[]) => T[],
    call?: StalkerCallOptions,
  ) {
    const r = await authedJs(query, call);
    if (!r.ok) return r;
    if (!isRaw(r.value)) return err(shapeError());
    return ok(toStalkerPage(r.value, page, mapRows));
  }

  return {
    discoveredPortal() {
      if (!discovered || portalMode === undefined || activeEndpoint.length === 0) return undefined;
      return { endpoint: activeEndpoint, mode: portalMode };
    },

    playbackHeadersFor(streamUrl) {
      return buildStalkerPlaybackHeaders({
        transport,
        activeEndpoint,
        targetUrl: streamUrl,
        cookie: currentCookieHeader(),
        ...(bearerToken !== undefined ? { bearerToken } : {}),
        ...(serialNumber !== undefined ? { serialNumber } : {}),
      });
    },

    handshake: (call) => ensureReady(call),

    async profile(call) {
      const profileOpts = {
        mac,
        ...(serialNumber !== undefined ? { serialNumber } : {}),
        ...(deviceId !== undefined ? { deviceId } : {}),
        ...(deviceId2 !== undefined ? { deviceId2 } : {}),
        ...(signature !== undefined ? { signature } : {}),
      };
      let r = await authedJs(buildStalkerProfileQuery(profileOpts), call);
      if (!r.ok) return r;
      if (!isRaw(r.value)) return err(shapeError());

      if (
        (r.value.status === 2 || r.value.status === '2') &&
        login !== undefined &&
        password !== undefined
      ) {
        const doAuthQuery =
          `type=stb&action=do_auth&login=${encodeURIComponent(login)}` +
          `&password=${encodeURIComponent(password)}` +
          `&device_id=${encodeURIComponent(deviceId ?? '')}` +
          `&device_id2=${encodeURIComponent(deviceId2 ?? '')}&JsHttpRequest=1-xml`;
        const authRes = await authedJs(doAuthQuery, call);
        if (!authRes.ok) return authRes;
        if (authRes.value === false || authRes.value === 0 || authRes.value === '0') {
          return err(unauthorizedError());
        }
        r = await authedJs(
          buildStalkerProfileQuery({ ...profileOpts, authSecondStep: true }),
          call,
        );
        if (!r.ok) return r;
        if (!isRaw(r.value)) return err(shapeError());
        if (r.value.status === 2 || r.value.status === '2') {
          return err(unauthorizedError());
        }
      }

      const prof = toStalkerProfile(r.value);
      if (prof.timezone !== undefined) {
        const cleanTz = sanitizeHeaderValue(prof.timezone);
        if (cleanTz.length > 0) activeTimezone = cleanTz;
      }
      return ok(prof);
    },

    async watchdogEvents(call) {
      const r = await authedJs(
        'type=watchdog&action=get_events&cur_play_type=1&event_active_id=0&init=0&JsHttpRequest=1-xml',
        call,
      );
      if (!r.ok) return r;
      return ok(toStalkerWatchdogEvent(r.value));
    },

    genres: (call) =>
      authedList('type=itv&action=get_genres&JsHttpRequest=1-xml', toStalkerCategories, call),
    vodCategories: (call) =>
      authedList('type=vod&action=get_categories&JsHttpRequest=1-xml', toStalkerCategories, call),
    seriesCategories: (call) =>
      authedList(
        'type=series&action=get_categories&JsHttpRequest=1-xml',
        toStalkerCategories,
        call,
      ),

    liveChannels(opts) {
      const genre = opts?.genreId?.trim() || '*';
      const page = clampPositiveInt(opts?.page, 1);
      return authedPage(
        `type=itv&action=get_ordered_list&genre=${encodeURIComponent(genre)}&force_ch_link_check=&fav=0&sortby=number&hd=0&p=${page}&JsHttpRequest=1-xml`,
        page,
        toStalkerChannels,
        opts,
      );
    },

    allLiveChannels: (call) =>
      authedList('type=itv&action=get_all_channels&JsHttpRequest=1-xml', toStalkerChannels, call),

    vodItems(opts) {
      const category = opts?.categoryId?.trim() || '*';
      const page = clampPositiveInt(opts?.page, 1);
      return authedPage(
        `type=vod&action=get_ordered_list&category=${encodeURIComponent(category)}&sortby=added&p=${page}&JsHttpRequest=1-xml`,
        page,
        (rows) => toStalkerVodItems(rows, activeTimezone),
        opts,
      );
    },

    seriesItems(opts) {
      const category = opts?.categoryId?.trim() || '*';
      const page = clampPositiveInt(opts?.page, 1);
      return authedPage(
        `type=series&action=get_ordered_list&category=${encodeURIComponent(category)}&sortby=added&p=${page}&JsHttpRequest=1-xml`,
        page,
        (rows) => toStalkerSeriesItems(rows, activeTimezone),
        opts,
      );
    },

    async seriesSeasons(seriesId, opts) {
      const id = seriesId.trim();
      if (id.length === 0) return err(elvError('source-format', 'invalid-id'));
      const contentType = opts?.contentType === 'vod' ? 'vod' : 'series';
      const all: StalkerSeason[] = [];
      const seenIds = new Set<string>();
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages && page <= MAX_SEASON_PAGES) {
        const query = `type=${contentType}&action=get_ordered_list&movie_id=${encodeURIComponent(id)}&p=${page}&JsHttpRequest=1-xml`;
        const r = await authedJs(query, opts);
        if (!r.ok) return r;
        if (Array.isArray(r.value)) {
          for (const season of toStalkerSeasons(id, r.value)) {
            if (seenIds.has(season.id)) continue;
            seenIds.add(season.id);
            all.push(season);
          }
          break;
        }
        if (!isRaw(r.value)) return err(shapeError());
        const pageRes = toStalkerPage(r.value, page, (rows) => toStalkerSeasons(id, rows));
        if (pageRes.items.length === 0) break;
        let addedThisPage = 0;
        for (const season of pageRes.items) {
          if (seenIds.has(season.id)) continue;
          seenIds.add(season.id);
          all.push(season);
          addedThisPage += 1;
        }
        if (addedThisPage === 0) break;
        const perPage = Math.max(
          1,
          pageRes.maxPageItems > 0 ? pageRes.maxPageItems : pageRes.items.length,
        );
        totalPages = Math.max(1, Math.ceil(pageRes.totalItems / perPage));
        if (all.length >= pageRes.totalItems) break;
        page += 1;
      }
      return ok(all);
    },

    seasonEpisodes(seriesId, seasonId, page, opts) {
      const sId = seriesId.trim();
      const seaId = seasonId.trim();
      if (sId.length === 0 || seaId.length === 0) {
        return Promise.resolve(err(elvError('source-format', 'invalid-id')));
      }
      const contentType = opts?.contentType === 'vod' ? 'vod' : 'series';
      const p = clampPositiveInt(page, 1);
      return authedPage(
        `type=${contentType}&action=get_ordered_list&movie_id=${encodeURIComponent(sId)}&season_id=${encodeURIComponent(seaId)}&p=${p}&JsHttpRequest=1-xml`,
        p,
        (rows) => toStalkerEpisodes(sId, seaId, rows),
        opts,
      );
    },

    vodEpisodeFiles(seriesId, seasonId, episodeId, call) {
      const sId = seriesId.trim();
      const seaId = seasonId.trim();
      const epId = episodeId.trim();
      if (sId.length === 0 || seaId.length === 0 || epId.length === 0) {
        return Promise.resolve(err(elvError('source-format', 'invalid-id')));
      }
      return authedList(
        `type=vod&action=get_ordered_list&movie_id=${encodeURIComponent(sId)}&season_id=${encodeURIComponent(seaId)}&episode_id=${encodeURIComponent(epId)}&JsHttpRequest=1-xml`,
        toStalkerEpisodeFiles,
        call,
      );
    },

    shortEpg(channelId, size, call) {
      const chId = channelId.trim();
      if (chId.length === 0) return Promise.resolve(err(elvError('source-format', 'invalid-id')));
      const n = clampPositiveInt(size, 10);
      const query = `type=itv&action=get_short_epg&ch_id=${encodeURIComponent(chId)}&size=${n}&JsHttpRequest=1-xml`;
      return authedList(query, (rows) => toStalkerEpgEntries(rows, activeTimezone), call);
    },

    async epgInfo(periodHours, call) {
      const period = clampPositiveInt(periodHours, 24);
      const query = `type=itv&action=get_epg_info&period=${period}&JsHttpRequest=1-xml`;
      const r = await authedJs(query, call);
      if (!r.ok) return r;
      if (Array.isArray(r.value) && r.value.length === 0) return ok(Object.create(null));
      if (!isRaw(r.value)) return err(shapeError());
      return ok(toStalkerEpgMap(r.value, activeTimezone));
    },

    async createLink(kind, cmd, opts) {
      const trimmedCmd = cmd.trim();
      if (trimmedCmd.length === 0) return err(elvError('source-format', 'invalid-command'));
      const stalkerType = linkKindToType(kind);
      const epNum =
        (kind === 'series' || kind === 'movie') && opts?.episodeNumber !== undefined
          ? clampPositiveInt(opts.episodeNumber, 1)
          : undefined;
      const seriesPart = epNum === undefined ? '' : `&series=${epNum}`;
      const encodedCmd = encodeStalkerCmdQueryValue(trimmedCmd);
      const query = `type=${stalkerType}&action=create_link&cmd=${encodedCmd}&forced_storage=undefined&disable_ad=0${seriesPart}&JsHttpRequest=1-xml`;
      const r = await authedJs(query, opts);
      if (!r.ok) return r;
      if (r.value === false || r.value === null) {
        return err(elvError('playback', 'stream-unavailable'));
      }
      let rawResultCmd: string | undefined;
      if (typeof r.value === 'string') rawResultCmd = r.value;
      else if (isRaw(r.value) && typeof r.value.cmd === 'string') rawResultCmd = r.value.cmd;
      else return err(shapeError());
      return validateStalkerStreamUrl(rawResultCmd, activeEndpoint);
    },
  };
}

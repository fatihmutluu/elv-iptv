import {
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
  toStalkerCategories,
  toStalkerChannels,
  toStalkerEpgEntries,
  toStalkerEpgMap,
  toStalkerEpisodes,
  toStalkerPage,
  toStalkerProfile,
  toStalkerSeasons,
  toStalkerSeriesItems,
  toStalkerVodItems,
} from './stalker-records';
import type {
  StalkerCallOptions,
  StalkerClient,
  StalkerClientOptions,
  StalkerLinkKind,
} from './stalker-types';
import {
  discardStalkerBody,
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
const DEFAULT_X_USER_AGENT = 'Model: MAG250; Link: WiFi';
const STALKER_VER = 'ImageDescription:%200.2.18-r14-pub-250';
const AUTH_FAILED_RE = /authorization\s+failed/i;

const shapeError = () => elvError('source-format', 'unexpected-shape');
const unauthorizedError = () => elvError('auth', 'unauthorized');

function payloadIndicatesAuthFailure(parsed: unknown): boolean {
  if (typeof parsed === 'string') return AUTH_FAILED_RE.test(parsed);
  if (isRaw(parsed)) {
    if (typeof parsed.text === 'string' && AUTH_FAILED_RE.test(parsed.text)) return true;
    if (typeof parsed.js === 'string' && AUTH_FAILED_RE.test(parsed.js)) return true;
    if (typeof parsed.error === 'string' && AUTH_FAILED_RE.test(parsed.error)) return true;
  }
  return false;
}

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
  | { kind: 'ok'; json: unknown }
  | { kind: 'auth-failed' }
  | { kind: 'not-found' }
  | { kind: 'error'; error: ReturnType<typeof elvError> };

/**
 * Creates a credential-isolated Stalker/Ministra MAC portal client.
 * `portalUrl`, `mac`, `serialNumber`, and `bearerToken` stay strictly inside the closure and
 * are never returned in records or error details.
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
  let activeEndpoint = normalizedPortal.ok ? normalizedPortal.value.endpoint : '';
  const fallbackEndpoint = normalizedPortal.ok
    ? normalizedPortal.value.fallbackEndpoint
    : undefined;
  let triedFallback = false;
  let bearerToken: string | undefined;

  const serialNumber = options.serialNumber?.trim() || undefined;
  const stbLang = sanitizeHeaderValue(options.language ?? 'en') || 'en';
  let activeTimezone = sanitizeHeaderValue(options.timezone ?? 'UTC') || 'UTC';
  const cookieHeader = `mac=${encodeURIComponent(mac)}; stb_lang=${encodeURIComponent(stbLang)}; timezone=${encodeURIComponent(activeTimezone)}`;

  const maxBodyBytes = Math.max(1024, options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const timeoutMs = Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const baseHeaders = transportHeaders(transport);
  const hostOverride = transport?.hostOverride?.trim() || undefined;
  const primaryHost = activeEndpoint.length > 0 ? hostnameOf(activeEndpoint) : undefined;

  async function requestEndpoint(
    endpoint: string,
    query: string,
    includeAuth: boolean,
    call?: StalkerCallOptions,
  ): Promise<FetchOutcome> {
    if (call?.signal?.aborted) return { kind: 'error', error: elvError('network', 'aborted') };
    const headers: Record<string, string> = {
      ...baseHeaders,
      Cookie: cookieHeader,
      'X-User-Agent': DEFAULT_X_USER_AGENT,
    };
    if (includeAuth && bearerToken !== undefined) {
      headers.Authorization = `Bearer ${bearerToken}`;
    }
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

    const { status, body } = response.value;
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
      if (AUTH_FAILED_RE.test(text)) return { kind: 'auth-failed' };
      return { kind: 'error', error: parsed.error };
    }
    if (payloadIndicatesAuthFailure(parsed.value)) return { kind: 'auth-failed' };
    return { kind: 'ok', json: parsed.value };
  }

  async function doHandshake(call?: StalkerCallOptions): Promise<Result<void>> {
    if (configError !== undefined) return err(configError);
    const query = 'type=stb&action=handshake&token=&JsHttpRequest=1-xml';
    let outcome = await requestEndpoint(activeEndpoint, query, false, call);
    if (outcome.kind === 'not-found' && fallbackEndpoint !== undefined && !triedFallback) {
      triedFallback = true;
      activeEndpoint = fallbackEndpoint;
      outcome = await requestEndpoint(activeEndpoint, query, false, call);
    }
    if (outcome.kind === 'auth-failed') {
      bearerToken = undefined;
      return err(unauthorizedError());
    }
    if (outcome.kind === 'not-found') return err(httpStatusError(404));
    if (outcome.kind === 'error') return err(outcome.error);

    if (!isRaw(outcome.json) || !('js' in outcome.json)) return err(shapeError());
    const js = outcome.json.js;
    if (js === false) {
      bearerToken = undefined;
      return err(unauthorizedError());
    }
    if (!isRaw(js)) return err(shapeError());
    const rawToken = typeof js.token === 'string' ? js.token.trim() : '';
    const cleanToken = sanitizeHeaderValue(rawToken);
    if (rawToken.length === 0 || cleanToken !== rawToken) {
      bearerToken = undefined;
      return err(unauthorizedError());
    }
    bearerToken = cleanToken;
    return ok(undefined);
  }

  async function authedJs(query: string, call?: StalkerCallOptions): Promise<Result<unknown>> {
    if (configError !== undefined) return err(configError);
    if (bearerToken === undefined) {
      const hs = await doHandshake(call);
      if (!hs.ok) return hs;
    }

    let outcome = await requestEndpoint(activeEndpoint, query, true, call);
    if (outcome.kind === 'auth-failed') {
      bearerToken = undefined;
      const rehs = await doHandshake(call);
      if (!rehs.ok) return rehs;
      outcome = await requestEndpoint(activeEndpoint, query, true, call);
      if (outcome.kind === 'auth-failed') {
        bearerToken = undefined;
        return err(unauthorizedError());
      }
    }

    if (outcome.kind === 'not-found') return err(httpStatusError(404));
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
    handshake: (call) => doHandshake(call),

    async profile(call) {
      const snPart = serialNumber === undefined ? '' : `&sn=${encodeURIComponent(serialNumber)}`;
      const query = `type=stb&action=get_profile&hd=1&ver=${STALKER_VER}&num_banks=2&stb_type=MAG250${snPart}&JsHttpRequest=1-xml`;
      const r = await authedJs(query, call);
      if (!r.ok) return r;
      if (!isRaw(r.value)) return err(shapeError());
      const prof = toStalkerProfile(r.value);
      if (prof.timezone !== undefined) activeTimezone = prof.timezone;
      return ok(prof);
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

    seriesSeasons(seriesId, call) {
      const id = seriesId.trim();
      if (id.length === 0) return Promise.resolve(err(elvError('source-format', 'invalid-id')));
      return authedList(
        `type=series&action=get_ordered_list&movie_id=${encodeURIComponent(id)}&p=1&JsHttpRequest=1-xml`,
        (rows) => toStalkerSeasons(id, rows),
        call,
      );
    },

    seasonEpisodes(seriesId, seasonId, page, call) {
      const sId = seriesId.trim();
      const seaId = seasonId.trim();
      if (sId.length === 0 || seaId.length === 0) {
        return Promise.resolve(err(elvError('source-format', 'invalid-id')));
      }
      const p = clampPositiveInt(page, 1);
      return authedPage(
        `type=series&action=get_ordered_list&movie_id=${encodeURIComponent(sId)}&season_id=${encodeURIComponent(seaId)}&p=${p}&JsHttpRequest=1-xml`,
        p,
        (rows) => toStalkerEpisodes(sId, seaId, rows),
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
        kind === 'series' && opts?.episodeNumber !== undefined
          ? clampPositiveInt(opts.episodeNumber, 1)
          : undefined;
      const seriesPart = epNum === undefined ? '' : `&series=${epNum}`;
      const query = `type=${stalkerType}&action=create_link&cmd=${encodeURIComponent(trimmedCmd)}&forced_storage=undefined&disable_ad=0${seriesPart}&JsHttpRequest=1-xml`;
      const r = await authedJs(query, opts);
      if (!r.ok) return r;
      if (r.value === false || r.value === null) {
        return err(elvError('playback', 'stream-unavailable'));
      }
      let rawResultCmd: string | undefined;
      if (typeof r.value === 'string') rawResultCmd = r.value;
      else if (isRaw(r.value) && typeof r.value.cmd === 'string') rawResultCmd = r.value.cmd;
      else return err(shapeError());
      return validateStalkerStreamUrl(rawResultCmd);
    },
  };
}

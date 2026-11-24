import {
  type ContentKind,
  elvError,
  err,
  hostnameOf,
  httpStatusError,
  ok,
  openAsyncIterator,
  type Result,
  transportHeaders,
} from '@elv/domain';
import { detectAndDecodeText } from './encoding';
import {
  accountFailure,
  acquireXtreamToken,
  parseXtreamJson,
  readXtreamBody,
  resolveNowFn,
} from './xtream-json';
import {
  accountCooldownKey,
  buildServerEntries,
  createMirrorSlotState,
  findServerIndex,
  isAccountCoolingDown,
  isFailoverEligible,
  parseRetryAfterMs,
  recordAccountCooldown,
  type XtreamServerEntry,
} from './xtream-mirrors';
import {
  isRaw,
  type Raw,
  toAccount,
  toCategories,
  toEpg,
  toLive,
  toMovies,
  toSeries,
  toSeriesInfo,
  toVodInfo,
} from './xtream-records';
import {
  buildXtreamBaseUrlWithScheme,
  getCachedXtreamScheme,
  isHttpResponseError,
  isSchemeFallbackEligible,
  resolveXtreamBaseUrl,
  setCachedXtreamScheme,
  stripXtreamTail,
} from './xtream-scheme';
import { streamXtreamRecords } from './xtream-stream';
import type {
  XtreamCallOptions,
  XtreamClient,
  XtreamClientOptions,
  XtreamStreamOptions,
} from './xtream-types';

export type * from './xtream-types';

const TIMEOUT_MS = 60_000;
const HTTPS_PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BODY = 128 * 1024 * 1024;
const DEFAULT_PRIMARY_COOLDOWN_MS = 300_000;
const NUMERIC_KEY_RE = /^\d+$/;
const shape = () => elvError('source-format', 'unexpected-shape');

async function discard(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    await openAsyncIterator(body).return?.();
  } catch {
    // Response is already classified by its status or early HTML sniff.
  }
}

/**
 * Normalizes a pasted Xtream `server`: trims, prepends `http://` when there is no scheme, drops query, fragment,
 * trailing slashes and a trailing `/player_api.php`, `/get.php` or `/xmltv.php`.
 */
export function normalizeXtreamServer(server: string): string {
  const trimmed = server.trim();
  return stripXtreamTail(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
}

/**
 * Creates an Xtream client. Credentials live only in the returned object: records and error
 * details never contain them or the request URL; only `playlistUrl`, `guideUrl`, `streamUrl`,
 * and `streamUrls` return URLs that include them.
 */
export function createXtreamClient(options: XtreamClientOptions): XtreamClient {
  const { http, transport } = options;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const servers = buildServerEntries(options.server, options.backupServers);
  const primaryCooldownMs = Math.max(0, options.primaryCooldownMs ?? DEFAULT_PRIMARY_COOLDOWN_MS);
  const nowFn = resolveNowFn(options.rateLimit);
  const accountKey = accountCooldownKey(options.username, options.password);
  const user = encodeURIComponent(options.username);
  const pass = encodeURIComponent(options.password);
  const credentials = `username=${user}&password=${pass}`;
  const liveFormat = transport?.xtreamFormat ?? 'ts';
  const hostOverride = transport?.hostOverride || undefined;
  const baseReqOpts = {
    headers: transportHeaders(transport),
    ...(transport?.allowLegacyTls ? { allowLegacyTls: true } : {}),
    ...(transport?.dnsFamily !== undefined ? { dnsFamily: transport.dnsFamily } : {}),
  };

  const apiSlot = createMirrorSlotState(servers.length, primaryCooldownMs, nowFn);
  const streamSlot = createMirrorSlotState(servers.length, primaryCooldownMs, nowFn);
  let activeTimezone = options.serverTimezone?.trim() || undefined;

  const resolveEntryBase = (entry: XtreamServerEntry): string =>
    entry.explicitScheme ? entry.raw : resolveXtreamBaseUrl(entry.raw, http);
  const primaryHost = hostnameOf(resolveEntryBase(servers[0] as XtreamServerEntry));
  const baseAt = (idx: number) => resolveEntryBase(servers[idx] as XtreamServerEntry);
  const activeApiBase = () => baseAt(apiSlot.activeIndex());
  const activeStreamBase = () => baseAt(streamSlot.activeIndex());

  const record429 = (respHeaders?: Readonly<Record<string, string>>) => {
    const ms = parseRetryAfterMs(respHeaders, options.cooldown429Ms);
    recordAccountCooldown(http, accountKey, nowFn(), ms);
    return err(httpStatusError(429));
  };

  const beginApiCall = (call?: XtreamCallOptions) => {
    if (call?.signal?.aborted) return err(elvError('network', 'aborted'));
    const startNow = nowFn();
    if (isAccountCoolingDown(http, accountKey, startNow)) return err(httpStatusError(429));
    return ok(apiSlot.attemptOrder(startNow));
  };

  async function requestServerBody(
    serverBase: string,
    query: string,
    timeoutMs: number,
    call?: XtreamCallOptions,
  ): Promise<Result<AsyncIterable<Uint8Array>>> {
    let response: Awaited<ReturnType<typeof http.get>>;
    const useHostOverride =
      hostOverride !== undefined &&
      primaryHost !== undefined &&
      hostnameOf(serverBase) === primaryHost;
    try {
      response = await http.get(`${serverBase}/player_api.php?${credentials}${query}`, {
        ...baseReqOpts,
        ...(useHostOverride ? { hostOverride } : {}),
        timeoutMs,
        ...(call?.signal ? { signal: call.signal } : {}),
      });
    } catch {
      if (call?.signal?.aborted) return err(elvError('network', 'aborted'));
      return err(elvError('network', 'request-failed'));
    }
    if (!response.ok) {
      if (response.error.category === 'network' && response.error.code === 'http-429') {
        return record429();
      }
      return err(elvError(response.error.category, response.error.code));
    }
    const { status, body } = response.value;
    if (status === 429) {
      await discard(body);
      return record429(response.value.headers);
    }
    if (status < 200 || status >= 300) {
      await discard(body);
      return err(httpStatusError(status));
    }
    if (call?.signal?.aborted) {
      await discard(body);
      return err(elvError('network', 'aborted'));
    }
    return ok(body);
  }

  async function openServerBody(
    entry: XtreamServerEntry,
    query: string,
    call?: XtreamCallOptions,
  ): Promise<Result<AsyncIterable<Uint8Array>>> {
    const token = await acquireXtreamToken(
      http,
      resolveEntryBase(entry),
      options.rateLimit,
      call?.signal,
    );
    if (!token.ok) return token;
    if (isAccountCoolingDown(http, accountKey, nowFn())) return err(httpStatusError(429));
    if (entry.explicitScheme || getCachedXtreamScheme(http, entry.hostKey) !== undefined) {
      return requestServerBody(resolveEntryBase(entry), query, TIMEOUT_MS, call);
    }

    const probeScheme = (scheme: 'https' | 'http', ms: number) =>
      requestServerBody(buildXtreamBaseUrlWithScheme(entry.raw, scheme), query, ms, call);
    const probe = await probeScheme('https', HTTPS_PROBE_TIMEOUT_MS);
    if (probe.ok || isHttpResponseError(probe.error)) {
      setCachedXtreamScheme(http, entry.hostKey, 'https');
      return probe;
    }
    if (!isSchemeFallbackEligible(probe.error)) return probe;
    if (call?.signal?.aborted) return err(elvError('network', 'aborted'));
    if (isAccountCoolingDown(http, accountKey, nowFn())) return err(httpStatusError(429));

    const fallback = await probeScheme('http', TIMEOUT_MS);
    if (fallback.ok || isHttpResponseError(fallback.error)) {
      setCachedXtreamScheme(http, entry.hostKey, 'http');
    }
    return fallback;
  }

  async function fetchServerJson(
    entry: XtreamServerEntry,
    query: string,
    call?: XtreamCallOptions,
  ): Promise<Result<unknown>> {
    const opened = await openServerBody(entry, query, call);
    if (!opened.ok) return opened;
    const bytes = await readXtreamBody(opened.value, maxBody);
    if (!bytes.ok) return bytes;
    return parseXtreamJson(detectAndDecodeText(bytes.value));
  }

  async function getJson(query: string, call?: XtreamCallOptions): Promise<Result<unknown>> {
    const start = beginApiCall(call);
    if (!start.ok) return start;
    const { order, probePrimary } = start.value;
    let lastFailure: Result<unknown> = err(elvError('network', 'request-failed'));

    for (const idx of order) {
      const result = await fetchServerJson(servers[idx] as XtreamServerEntry, query, call);
      if (result.ok) {
        apiSlot.markSuccess(idx, nowFn());
        return result;
      }
      if (probePrimary && idx === 0) apiSlot.markPrimaryProbeFailed(nowFn());
      if (!isFailoverEligible(result.error)) return result;
      lastFailure = result;
    }
    return lastFailure;
  }

  async function* streamRows<T>(
    query: string,
    map: (rows: Raw[]) => T[],
    call?: XtreamStreamOptions,
  ): AsyncGenerator<T[], Result<void>> {
    const start = beginApiCall(call);
    if (!start.ok) return start;
    const { order, probePrimary } = start.value;
    let lastFailure: Result<void> = err(elvError('network', 'request-failed'));

    for (const idx of order) {
      const opened = await openServerBody(servers[idx] as XtreamServerEntry, query, call);
      if (!opened.ok) {
        if (probePrimary && idx === 0) apiSlot.markPrimaryProbeFailed(nowFn());
        if (!isFailoverEligible(opened.error)) return opened;
        lastFailure = opened;
        continue;
      }
      const gen = streamXtreamRecords(opened.value, {
        maxBodyBytes: maxBody,
        ...(call?.batchSize === undefined ? {} : { batchSize: call.batchSize }),
        ...(call?.signal === undefined ? {} : { signal: call.signal }),
      });
      let yieldedAny = false;
      try {
        for (;;) {
          const step = await gen.next();
          if (step.done) {
            if (step.value.ok) {
              if (!yieldedAny) apiSlot.markSuccess(idx, nowFn());
              return ok(undefined);
            }
            if (probePrimary && idx === 0) apiSlot.markPrimaryProbeFailed(nowFn());
            if (!yieldedAny && isFailoverEligible(step.value.error)) {
              lastFailure = step.value;
              break;
            }
            return step.value;
          }
          const mapped = map(step.value);
          if (mapped.length > 0) {
            if (!yieldedAny) apiSlot.markSuccess(idx, nowFn());
            yieldedAny = true;
            yield mapped;
          }
        }
      } finally {
        await gen.return(ok(undefined));
      }
    }
    return lastFailure;
  }

  async function object(query: string, call?: XtreamCallOptions): Promise<Result<Raw>> {
    const r = await getJson(query, call);
    if (!r.ok) return r;
    if (Array.isArray(r.value) && r.value.length === 0) return ok({});
    return isRaw(r.value) ? ok(r.value) : err(shape());
  }

  async function rows<T>(
    query: string,
    map: (rows: Raw[]) => T[],
    call?: XtreamCallOptions,
  ): Promise<Result<T[]>> {
    const r = await getJson(query, call);
    if (!r.ok) return r;
    if (r.value === null || r.value === false) return ok([]);
    if (Array.isArray(r.value)) return ok(map(r.value.filter(isRaw)));
    if (isRaw(r.value)) {
      const keys = Object.keys(r.value);
      if (keys.length === 0) return ok([]);
      if (isRaw(r.value.user_info)) {
        const failure = accountFailure(r.value.user_info);
        if (failure) return err(failure);
      }
      if (keys.every((k) => NUMERIC_KEY_RE.test(k))) {
        const ordered = [...keys]
          .sort((a, b) => Number(a) - Number(b))
          .map((k) => (r.value as Raw)[k])
          .filter(isRaw);
        if (ordered.length === keys.length) return ok(map(ordered));
      }
    }
    return err(shape());
  }

  const listQ = (action: string, cat?: string) =>
    `&action=${action}${cat === undefined ? '' : `&category_id=${encodeURIComponent(cat)}`}`;
  const buildStreamUrls = (kind: ContentKind, id: number, ext?: string): readonly string[] => {
    const path = kind === 'live' ? 'live' : kind === 'movie' ? 'movie' : 'series';
    const tail = `${path}/${user}/${pass}/${id}.${ext ?? (kind === 'live' ? liveFormat : 'mp4')}`;
    return streamSlot.attemptOrder(nowFn()).order.map((idx) => `${baseAt(idx)}/${tail}`);
  };

  const mapObj = async <T>(query: string, fn: (raw: Raw) => T, call?: XtreamCallOptions) => {
    const r = await object(query, call);
    return r.ok ? ok(fn(r.value)) : r;
  };

  return {
    async account(call) {
      const r = await object('', call);
      if (!r.ok) return r;
      const info = r.value.user_info;
      if (!isRaw(info)) return err(shape());
      const failure = accountFailure(info);
      if (failure) return err(failure);
      const status =
        typeof info.status === 'string' && info.status.trim() ? info.status.trim() : 'Active';
      const acc = toAccount(info, isRaw(r.value.server_info) ? r.value.server_info : {}, status);
      if (acc.serverTimezone !== undefined) activeTimezone = acc.serverTimezone;
      return ok(acc);
    },
    categories: (kind, call) =>
      rows(`&action=get_${kind === 'movie' ? 'vod' : kind}_categories`, toCategories, call),
    liveStreams: (cat, call) => rows(listQ('get_live_streams', cat), toLive, call),
    vodStreams: (cat, call) => rows(listQ('get_vod_streams', cat), toMovies, call),
    series: (cat, call) => rows(listQ('get_series', cat), toSeries, call),
    streamLiveStreams: (cat, call) => streamRows(listQ('get_live_streams', cat), toLive, call),
    streamVodStreams: (cat, call) => streamRows(listQ('get_vod_streams', cat), toMovies, call),
    streamSeries: (cat, call) => streamRows(listQ('get_series', cat), toSeries, call),
    seriesInfo: (id, call) => mapObj(`&action=get_series_info&series_id=${id}`, toSeriesInfo, call),
    vodInfo: (id, call) => mapObj(`&action=get_vod_info&vod_id=${id}`, toVodInfo, call),
    shortEpg: (id, limit, call) =>
      mapObj(
        `&action=get_short_epg&stream_id=${id}${limit === undefined ? '' : `&limit=${limit}`}`,
        (v) => toEpg(v, activeTimezone),
        call,
      ),
    simpleEpg: (id, call) =>
      mapObj(
        `&action=get_simple_data_table&stream_id=${id}`,
        (v) => toEpg(v, activeTimezone),
        call,
      ),
    playlistUrl: () =>
      `${activeApiBase()}/get.php?${credentials}&type=m3u_plus&output=${liveFormat}`,
    guideUrl: () => `${activeApiBase()}/xmltv.php?${credentials}`,
    streamUrl: (kind, id, ext) => buildStreamUrls(kind, id, ext)[0] as string,
    streamUrls: buildStreamUrls,
    activeApiServer: activeApiBase,
    activeStreamServer: activeStreamBase,
    reportStreamFailure(urlOrBase) {
      const now = nowFn();
      const idx =
        urlOrBase === undefined ? undefined : findServerIndex(servers, urlOrBase, resolveEntryBase);
      if (idx !== -1) streamSlot.reportFailure(idx, now);
    },
    reportStreamSuccess(urlOrBase) {
      const now = nowFn();
      const idx =
        urlOrBase === undefined
          ? (streamSlot.attemptOrder(now).order[0] ?? 0)
          : findServerIndex(servers, urlOrBase, resolveEntryBase);
      if (idx !== -1) streamSlot.markSuccess(idx, now);
    },
    resetMirrors() {
      apiSlot.reset();
      streamSlot.reset();
    },
  };
}

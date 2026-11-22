import {
  elvError,
  err,
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
  buildAttemptOrder,
  buildServerList,
  isAccountCoolingDown,
  isFailoverEligible,
  parseRetryAfterMs,
  recordAccountCooldown,
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
import { streamXtreamRecords } from './xtream-stream';
import type {
  XtreamCallOptions,
  XtreamClient,
  XtreamClientOptions,
  XtreamStreamOptions,
} from './xtream-types';

export type * from './xtream-types';

const TIMEOUT_MS = 60_000;
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
  return (trimmed.includes('://') ? trimmed : `http://${trimmed}`)
    .replace(/[?#].*$/s, '')
    .replace(/\/+$/, '')
    .replace(/\/(?:player_api|get|xmltv)\.php$/i, '')
    .replace(/\/+$/, '');
}

/**
 * Creates an Xtream client. Credentials live only in the returned object: records and error
 * details never contain them or the request URL; only `playlistUrl`, `guideUrl` and `streamUrl`
 * return URLs that include them.
 */
export function createXtreamClient(options: XtreamClientOptions): XtreamClient {
  const { http, transport } = options;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const primary = normalizeXtreamServer(options.server);
  const servers = buildServerList(primary, options.backupServers, normalizeXtreamServer);
  const primaryCooldownMs = Math.max(0, options.primaryCooldownMs ?? DEFAULT_PRIMARY_COOLDOWN_MS);
  const nowFn = resolveNowFn(options.rateLimit);
  const accountKey = accountCooldownKey(options.username, options.password);
  const user = encodeURIComponent(options.username);
  const pass = encodeURIComponent(options.password);
  const credentials = `username=${user}&password=${pass}`;
  const liveFormat = transport?.xtreamFormat ?? 'ts';
  const headers = transportHeaders(transport);

  let activeIndex = 0;
  let failedOverAtMs: number | undefined;
  let activeTimezone = options.serverTimezone?.trim() || undefined;

  const currentBase = () => servers[activeIndex] as string;

  const promoteServer = (idx: number): void => {
    if (idx === 0) {
      activeIndex = 0;
      failedOverAtMs = undefined;
    } else {
      if (activeIndex === 0 || failedOverAtMs === undefined) {
        failedOverAtMs = nowFn();
      }
      activeIndex = idx;
    }
  };

  async function openServerBody(
    serverBase: string,
    query: string,
    call?: XtreamCallOptions,
  ): Promise<Result<AsyncIterable<Uint8Array>>> {
    const token = await acquireXtreamToken(http, serverBase, options.rateLimit, call?.signal);
    if (!token.ok) return token;
    if (isAccountCoolingDown(http, accountKey, nowFn())) {
      return err(httpStatusError(429));
    }
    let response: Awaited<ReturnType<typeof http.get>>;
    try {
      response = await http.get(`${serverBase}/player_api.php?${credentials}${query}`, {
        headers,
        timeoutMs: TIMEOUT_MS,
        ...(call?.signal ? { signal: call.signal } : {}),
      });
    } catch {
      if (call?.signal?.aborted) return err(elvError('network', 'aborted'));
      return err(elvError('network', 'request-failed'));
    }
    if (!response.ok) {
      if (response.error.category === 'network' && response.error.code === 'http-429') {
        recordAccountCooldown(
          http,
          accountKey,
          nowFn(),
          parseRetryAfterMs(undefined, options.cooldown429Ms),
        );
        return err(httpStatusError(429));
      }
      return err(elvError(response.error.category, response.error.code));
    }
    const { status, body } = response.value;
    if (status === 429) {
      await discard(body);
      recordAccountCooldown(
        http,
        accountKey,
        nowFn(),
        parseRetryAfterMs(response.value.headers, options.cooldown429Ms),
      );
      return err(httpStatusError(429));
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

  async function fetchServerJson(
    serverBase: string,
    query: string,
    call?: XtreamCallOptions,
  ): Promise<Result<unknown>> {
    const opened = await openServerBody(serverBase, query, call);
    if (!opened.ok) return opened;
    const bytes = await readXtreamBody(opened.value, maxBody);
    if (!bytes.ok) return bytes;
    return parseXtreamJson(detectAndDecodeText(bytes.value));
  }

  async function getJson(query: string, call?: XtreamCallOptions): Promise<Result<unknown>> {
    if (call?.signal?.aborted) return err(elvError('network', 'aborted'));
    const startNow = nowFn();
    if (isAccountCoolingDown(http, accountKey, startNow)) {
      return err(httpStatusError(429));
    }
    const probePrimary =
      activeIndex > 0 &&
      failedOverAtMs !== undefined &&
      startNow - failedOverAtMs >= primaryCooldownMs;
    const order = buildAttemptOrder(servers.length, activeIndex, probePrimary);
    let lastFailure: Result<unknown> = err(elvError('network', 'request-failed'));

    for (const idx of order) {
      const result = await fetchServerJson(servers[idx] as string, query, call);
      if (result.ok) {
        promoteServer(idx);
        return result;
      }
      if (probePrimary && idx === 0) failedOverAtMs = nowFn();
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
    if (call?.signal?.aborted) return err(elvError('network', 'aborted'));
    const startNow = nowFn();
    if (isAccountCoolingDown(http, accountKey, startNow)) {
      return err(httpStatusError(429));
    }
    const probePrimary =
      activeIndex > 0 &&
      failedOverAtMs !== undefined &&
      startNow - failedOverAtMs >= primaryCooldownMs;
    const order = buildAttemptOrder(servers.length, activeIndex, probePrimary);
    let lastFailure: Result<void> = err(elvError('network', 'request-failed'));

    for (const idx of order) {
      const opened = await openServerBody(servers[idx] as string, query, call);
      if (!opened.ok) {
        if (probePrimary && idx === 0) failedOverAtMs = nowFn();
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
      let promoted = false;
      let failover = false;
      try {
        for (;;) {
          const step = await gen.next();
          if (step.done) {
            if (step.value.ok) {
              if (!promoted) promoteServer(idx);
              return ok(undefined);
            }
            if (probePrimary && idx === 0) failedOverAtMs = nowFn();
            if (!yieldedAny && isFailoverEligible(step.value.error)) {
              lastFailure = step.value;
              failover = true;
              break;
            }
            return step.value;
          }
          const mapped = map(step.value);
          if (mapped.length > 0) {
            if (!promoted) {
              promoteServer(idx);
              promoted = true;
            }
            yieldedAny = true;
            yield mapped;
          }
        }
      } finally {
        await gen.return(ok(undefined));
      }
      if (!failover) return lastFailure;
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

  const withCategory = (categoryId?: string) =>
    categoryId === undefined ? '' : `&category_id=${encodeURIComponent(categoryId)}`;
  const withRoot = (path: string, id: number, ext: string) =>
    `${currentBase()}/${path}/${user}/${pass}/${id}.${ext}`;

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
    categories(kind, call) {
      const action = kind === 'movie' ? 'vod' : kind;
      return rows(`&action=get_${action}_categories`, toCategories, call);
    },
    liveStreams: (categoryId, call) =>
      rows(`&action=get_live_streams${withCategory(categoryId)}`, toLive, call),
    vodStreams: (categoryId, call) =>
      rows(`&action=get_vod_streams${withCategory(categoryId)}`, toMovies, call),
    series: (categoryId, call) =>
      rows(`&action=get_series${withCategory(categoryId)}`, toSeries, call),
    streamLiveStreams: (categoryId, call) =>
      streamRows(`&action=get_live_streams${withCategory(categoryId)}`, toLive, call),
    streamVodStreams: (categoryId, call) =>
      streamRows(`&action=get_vod_streams${withCategory(categoryId)}`, toMovies, call),
    streamSeries: (categoryId, call) =>
      streamRows(`&action=get_series${withCategory(categoryId)}`, toSeries, call),
    async seriesInfo(seriesId, call) {
      const r = await object(`&action=get_series_info&series_id=${seriesId}`, call);
      return r.ok ? ok(toSeriesInfo(r.value)) : r;
    },
    async vodInfo(vodId, call) {
      const r = await object(`&action=get_vod_info&vod_id=${vodId}`, call);
      return r.ok ? ok(toVodInfo(r.value)) : r;
    },
    async shortEpg(streamId, limit, call) {
      const tail = limit === undefined ? '' : `&limit=${limit}`;
      const r = await object(`&action=get_short_epg&stream_id=${streamId}${tail}`, call);
      return r.ok ? ok(toEpg(r.value, activeTimezone)) : r;
    },
    playlistUrl: () => `${currentBase()}/get.php?${credentials}&type=m3u_plus&output=${liveFormat}`,
    guideUrl: () => `${currentBase()}/xmltv.php?${credentials}`,
    streamUrl(kind, id, extension) {
      if (kind === 'live') return withRoot('live', id, extension ?? liveFormat);
      if (kind === 'movie') return withRoot('movie', id, extension ?? 'mp4');
      return withRoot('series', id, extension ?? 'mp4');
    },
  };
}

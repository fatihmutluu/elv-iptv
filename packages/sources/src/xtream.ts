import { type ElvError, elvError, err, ok, type Result, transportHeaders } from '@elv/domain';
import { toElvError } from './scan-error';
import { decodeUtf8 } from './utf8';
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
import type { XtreamCallOptions, XtreamClient, XtreamClientOptions } from './xtream-types';

export type * from './xtream-types';

const TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY = 128 * 1024 * 1024;
const FIRST_BUFFER = 64 * 1024;
const shape = () => elvError('source-format', 'unexpected-shape');

async function discard(body: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    for await (const _ of body) break;
  } catch {
    // the response is already classified by its status
  }
}

async function readAll(body: AsyncIterable<Uint8Array>, max: number): Promise<Result<Uint8Array>> {
  let buffer = new Uint8Array(Math.min(FIRST_BUFFER, max));
  let total = 0;
  try {
    for await (const chunk of body) {
      if (total + chunk.length > max) return err(elvError('source-format', 'too-large'));
      if (total + chunk.length > buffer.length) {
        const grown = new Uint8Array(
          Math.min(max, Math.max(buffer.length * 2, total + chunk.length)),
        );
        grown.set(buffer.subarray(0, total));
        buffer = grown;
      }
      buffer.set(chunk, total);
      total += chunk.length;
    }
  } catch (e) {
    return err(toElvError(e));
  }
  return ok(buffer.subarray(0, total));
}

/**
 * Creates an Xtream client. Credentials live only in the returned object: records and error
 * details never contain them or the request URL; only `playlistUrl`, `guideUrl` and `streamUrl`
 * return URLs that include them.
 */
export function createXtreamClient(options: XtreamClientOptions): XtreamClient {
  const { http, transport } = options;
  const maxBody = options.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const server = options.server.trim();
  const base = (server.includes('://') ? server : `http://${server}`)
    .replace(/[?#].*$/s, '')
    .replace(/\/+$/, '')
    .replace(/\/(?:player_api|get|xmltv)\.php$/, '')
    .replace(/\/+$/, '');
  const user = encodeURIComponent(options.username);
  const pass = encodeURIComponent(options.password);
  const credentials = `username=${user}&password=${pass}`;
  const liveFormat = transport?.xtreamFormat ?? 'ts';
  const headers = transportHeaders(transport);

  async function getJson(query: string, call?: XtreamCallOptions): Promise<Result<unknown>> {
    let response: Awaited<ReturnType<typeof http.get>>;
    try {
      response = await http.get(`${base}/player_api.php?${credentials}${query}`, {
        headers,
        timeoutMs: TIMEOUT_MS,
        ...(call?.signal ? { signal: call.signal } : {}),
      });
    } catch {
      if (call?.signal?.aborted) return err(elvError('network', 'aborted'));
      return err(elvError('network', 'request-failed'));
    }
    if (!response.ok) return err(elvError(response.error.category, response.error.code));
    const { status, body } = response.value;
    if (status < 200 || status >= 300) {
      await discard(body);
      if (status === 401 || status === 403) return err(elvError('auth', 'unauthorized'));
      if (status >= 500) return err(elvError('network', 'server-error'));
      return err(elvError('network', 'http-status', `HTTP ${status}`));
    }
    const bytes = await readAll(body, maxBody);
    if (!bytes.ok) return bytes;
    try {
      return ok(JSON.parse(decodeUtf8(bytes.value)));
    } catch {
      return err(elvError('source-format', 'invalid-json'));
    }
  }

  async function object(query: string, call?: XtreamCallOptions): Promise<Result<Raw>> {
    const r = await getJson(query, call);
    if (!r.ok) return r;
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
    if (isRaw(r.value) && Object.keys(r.value).length === 0) return ok([]);
    if (!Array.isArray(r.value)) return err(shape());
    return ok(map(r.value.filter(isRaw)));
  }

  const withCategory = (categoryId?: string) =>
    categoryId === undefined ? '' : `&category_id=${encodeURIComponent(categoryId)}`;
  const withRoot = (path: string, id: number, ext: string) =>
    `${base}/${path}/${user}/${pass}/${id}.${ext}`;

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
      return ok(toAccount(info, isRaw(r.value.server_info) ? r.value.server_info : {}, status));
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
      return r.ok ? ok(toEpg(r.value)) : r;
    },
    playlistUrl: () => `${base}/get.php?${credentials}&type=m3u_plus&output=${liveFormat}`,
    guideUrl: () => `${base}/xmltv.php?${credentials}`,
    streamUrl(kind, id, extension) {
      if (kind === 'live') return withRoot('live', id, extension ?? liveFormat);
      if (kind === 'movie') return withRoot('movie', id, extension ?? 'mp4');
      return withRoot('series', id, extension ?? 'mp4');
    },
  };
}

function accountFailure(info: Raw): ElvError | undefined {
  if (Number(info.auth) === 0) return elvError('auth', 'invalid-credentials');
  const status = typeof info.status === 'string' ? info.status.trim() : '';
  if (status === '' || status.toLowerCase() === 'active') return undefined;
  const slug = status
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return elvError('auth', `account-${slug || 'unknown'}`);
}

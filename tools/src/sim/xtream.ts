import { findAccount } from './accounts.ts';
import { buildCatalog, type Catalog, type LiveChannel } from './catalog.ts';
import { programmesFor } from './xmltv.ts';

/** Result of an API call: HTTP status and the JSON-serializable body. */
export interface ApiResult {
  status: number;
  body: unknown;
}
/** Per-request inputs of the API. */
export interface ApiContext {
  baseUrl: string;
  now: Date;
  seed: number;
}

type Row = Record<string, unknown>;

const DAY_SEC = 86_400;
const CREATED_AT = 1_700_000_000;
const DEFAULT_LIMIT = 4;

const sec = (d: Date): number => Math.floor(d.getTime() / 1000);
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const pad2 = (n: number): string => String(n).padStart(2, '0');

function utcText(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function clock(totalSec: number): string {
  return `${pad2(Math.floor(totalSec / 3600))}:${pad2(Math.floor((totalSec % 3600) / 60))}:${pad2(totalSec % 60)}`;
}

function accountInfo(account: NonNullable<ReturnType<typeof findAccount>>, ctx: ApiContext): Row {
  const now = sec(ctx.now);
  const url = new URL(ctx.baseUrl);
  const expired = account.status === 'Expired';
  return {
    user_info: {
      username: account.username,
      password: account.password,
      message: '',
      auth: 1,
      status: account.status,
      exp_date: String(expired ? now - DAY_SEC : now + 365 * DAY_SEC),
      is_trial: '0',
      active_cons: '0',
      created_at: String(CREATED_AT),
      max_connections: String(account.maxConnections),
      allowed_output_formats: ['m3u8', 'ts'],
    },
    server_info: {
      url: url.hostname,
      port: url.port || '80',
      https_port: '443',
      server_protocol: 'http',
      rtmp_port: '1935',
      timezone: 'UTC',
      timestamp_now: now,
      time_now: utcText(now),
    },
  };
}

function liveRow(ch: LiveChannel, ctx: ApiContext): Row {
  return {
    num: ch.num,
    name: ch.name,
    stream_type: 'live',
    stream_id: ch.id,
    stream_icon: ch.logo === null ? '' : `${ctx.baseUrl}/logos/${ch.logo}.png`,
    epg_channel_id: ch.epgId ?? '',
    added: String(CREATED_AT),
    category_id: ch.categoryId,
    custom_sid: '',
    tv_archive: ch.archiveDays > 0 ? 1 : 0,
    direct_source: '',
    tv_archive_duration: ch.archiveDays,
  };
}

function stringifyNumbers(value: unknown): unknown {
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(stringifyNumbers);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stringifyNumbers(v)]));
  }
  return value;
}

/** Makes live rows look like a real panel: string numbers, null icons, entities, orphan category, duplicate id. */
function applyQuirks(rows: Row[]): Row[] {
  const out = [...rows];
  const withLogo = out.findIndex((r) => r.stream_icon === '');
  if (withLogo >= 0) (out[withLogo] as Row).stream_icon = null;
  if (out[1]) out[1] = { ...out[1], name: `${String(out[1].name)} &amp; Co` };
  if (out[2]) out[2] = { ...out[2], category_id: '999' };
  const first = out[0];
  const last = out.at(-1);
  if (first && last && out.length > 1)
    out[out.length - 1] = { ...last, stream_id: first.stream_id };
  return out;
}

function categoryRows(catalog: Catalog, kind: 'live' | 'vod' | 'series'): Row[] {
  return catalog.categories
    .filter((c) => c.kind === kind)
    .map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 }));
}

function rating(id: number): string {
  return (5 + (id % 40) / 10).toFixed(1);
}

function vodRows(catalog: Catalog, ctx: ApiContext, categoryId: string | null): Row[] {
  return catalog.movies
    .filter((m) => categoryId === null || m.categoryId === categoryId)
    .map((m) => ({
      num: m.id - 200_000,
      name: m.name,
      stream_type: 'movie',
      stream_id: m.id,
      stream_icon: `${ctx.baseUrl}/logos/${m.id % 16}.png`,
      rating: rating(m.id),
      added: String(m.added),
      category_id: m.categoryId,
      container_extension: m.ext,
    }));
}

function seriesRows(catalog: Catalog, ctx: ApiContext, categoryId: string | null): Row[] {
  return catalog.series
    .filter((s) => categoryId === null || s.categoryId === categoryId)
    .map((s) => ({
      num: s.id - 300_000,
      series_id: s.id,
      name: s.name,
      cover: `${ctx.baseUrl}/logos/${s.id % 16}.png`,
      plot: `Synthetic plot of ${s.name}.`,
      rating: rating(s.id),
      category_id: s.categoryId,
      last_modified: String(CREATED_AT),
    }));
}

function vodInfo(catalog: Catalog, ctx: ApiContext, id: number): Row {
  const m = catalog.movies.find((x) => x.id === id);
  if (!m) return { info: [], movie_data: [] };
  return {
    info: {
      name: m.name,
      movie_image: `${ctx.baseUrl}/logos/${m.id % 16}.png`,
      plot: `Synthetic plot of ${m.name}.`,
      rating: rating(m.id),
      duration_secs: m.durationSec,
      duration: clock(m.durationSec),
    },
    movie_data: {
      stream_id: m.id,
      name: m.name,
      added: String(m.added),
      category_id: m.categoryId,
      container_extension: m.ext,
    },
  };
}

function seriesInfo(catalog: Catalog, ctx: ApiContext, id: number): Row {
  const s = catalog.series.find((x) => x.id === id);
  if (!s) return { seasons: [], info: [], episodes: [] };
  const episodes: Record<string, Row[]> = {};
  for (const e of s.episodes) {
    const key = String(e.season);
    const bucket = episodes[key] ?? [];
    bucket.push({
      id: String(e.id),
      episode_num: e.episode,
      title: e.title,
      container_extension: e.ext,
      season: e.season,
      added: String(CREATED_AT),
      info: { duration_secs: e.durationSec, duration: clock(e.durationSec) },
    });
    episodes[key] = bucket;
  }
  const seasons = Object.keys(episodes).map((key) => ({
    season_number: Number(key),
    name: `Season ${key}`,
    episode_count: String(episodes[key]?.length ?? 0),
  }));
  return {
    seasons,
    info: {
      name: s.name,
      cover: `${ctx.baseUrl}/logos/${s.id % 16}.png`,
      plot: `Synthetic plot of ${s.name}.`,
      rating: rating(s.id),
      category_id: s.categoryId,
    },
    episodes,
  };
}

function epgRows(
  catalog: Catalog,
  ctx: ApiContext,
  streamId: number,
  mode: 'short' | 'table',
  limit: number,
): Row {
  const index = catalog.live.findIndex((c) => c.id === streamId);
  const channel = catalog.live[index];
  if (!channel) return { epg_listings: [] };
  const now = sec(ctx.now);
  const rows: Row[] = [];
  for (const p of programmesFor(catalog, index, ctx.now)) {
    const start = sec(p.start);
    const stop = sec(p.stop);
    if (mode === 'short' && stop <= now) continue;
    if (mode === 'short' && rows.length >= limit) break;
    const row: Row = {
      id: String(start),
      epg_id: String(index + 1),
      title: b64(p.title),
      lang: 'en',
      start: utcText(start),
      end: utcText(stop),
      description: b64(p.desc),
      channel_id: p.channel,
      start_timestamp: String(start),
      stop_timestamp: String(stop),
    };
    if (mode === 'table') {
      row.now_playing = start <= now && now < stop ? 1 : 0;
      row.has_archive = channel.archiveDays > 0 && stop <= now ? 1 : 0;
    }
    rows.push(row);
  }
  return { epg_listings: rows };
}

/** Answers `/player_api.php` for the given query. */
export function playerApi(query: URLSearchParams, ctx: ApiContext): ApiResult {
  const account = findAccount(query.get('username'), query.get('password'));
  if (!account) return { status: 200, body: { user_info: { auth: 0 } } };
  const action = query.get('action');
  if (action === null) return { status: 200, body: accountInfo(account, ctx) };
  const catalog = buildCatalog(account.profile, ctx.seed);
  const categoryId = query.get('category_id');
  const id = (name: string): number => Number(query.get(name));
  let body: unknown;
  switch (action) {
    case 'get_live_categories':
      body = categoryRows(catalog, 'live');
      break;
    case 'get_vod_categories':
      body = categoryRows(catalog, 'vod');
      break;
    case 'get_series_categories':
      body = categoryRows(catalog, 'series');
      break;
    case 'get_live_streams': {
      const rows = catalog.live
        .filter((c) => categoryId === null || c.categoryId === categoryId)
        .map((c) => liveRow(c, ctx));
      body = account.quirks ? applyQuirks(rows) : rows;
      break;
    }
    case 'get_vod_streams':
      body = vodRows(catalog, ctx, categoryId);
      break;
    case 'get_series':
      body = seriesRows(catalog, ctx, categoryId);
      break;
    case 'get_vod_info':
      body = vodInfo(catalog, ctx, id('vod_id'));
      break;
    case 'get_series_info':
      body = seriesInfo(catalog, ctx, id('series_id'));
      break;
    case 'get_short_epg': {
      const limit = Number(query.get('limit') ?? DEFAULT_LIMIT);
      body = epgRows(catalog, ctx, id('stream_id'), 'short', limit > 0 ? limit : DEFAULT_LIMIT);
      break;
    }
    case 'get_simple_data_table':
      body = epgRows(catalog, ctx, id('stream_id'), 'table', 0);
      break;
    default:
      body = [];
  }
  return { status: 200, body: account.quirks ? stringifyNumbers(body) : body };
}

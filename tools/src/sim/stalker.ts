import type { Account } from './accounts.ts';
import { buildCatalog, type Catalog, type LiveChannel } from './catalog.ts';
import type { Movie, Series } from './catalog-types.ts';
import {
  parseBearer,
  parseMacCookie,
  resolveStalkerAccount,
  StalkerSessionStore,
} from './stalker-sessions.ts';
import { programmesFor } from './xmltv.ts';
import type { ApiContext, ApiResult } from './xtream.ts';

export { parseMacCookie, resolveStalkerAccount, StalkerSessionStore };

type Row = Record<string, unknown>;

/** Headers relevant to Stalker portal requests. */
export interface StalkerHeaders {
  cookie?: string | undefined;
  authorization?: string | undefined;
}

const DAY_SEC = 86_400;
const HOUR_SEC = 3_600;
const PAGE_SIZE = 14;
const DEFAULT_SHORT_EPG_SIZE = 10;
const RANDOM_TOKEN = '123456';

const sec = (d: Date): number => Math.floor(d.getTime() / 1000);
const pad2 = (n: number): string => String(n).padStart(2, '0');
const rating = (id: number): string => (5 + (id % 40) / 10).toFixed(1);
const ok = (js: unknown): ApiResult => ({ status: 200, body: { js } });
const unauthorized = (): ApiResult => ({ status: 401, body: { error: 'Authorization failed' } });

function utcText(seconds: number): string {
  const d = new Date(seconds * 1000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function paginate<T>(items: readonly T[], pageParam: string | null): Row {
  const parsed = Number(pageParam ?? '1');
  const page = Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
  const start = (page - 1) * PAGE_SIZE;
  return {
    total_items: items.length,
    max_page_items: PAGE_SIZE,
    selected_item: 0,
    cur_page: page,
    data: items.slice(start, start + PAGE_SIZE),
  };
}

function liveRow(ch: LiveChannel, ctx: ApiContext): Row {
  return {
    id: String(ch.id),
    number: String(ch.num),
    name: ch.name,
    tv_genre_id: ch.categoryId,
    cmd: `ffrt http://localhost/ch/${ch.id}`,
    logo: ch.logo === null ? '' : `${ctx.baseUrl}/logos/${ch.logo}.png`,
    enable_tv_archive: ch.archiveDays > 0 ? 1 : 0,
    tv_archive_duration: ch.archiveDays,
  };
}

function vodMeta(
  id: number,
  name: string,
  categoryId: string,
  baseUrl: string,
  yearBase: number,
): Row {
  return {
    id: String(id),
    name,
    category_id: categoryId,
    screenshot_uri: `${baseUrl}/logos/${id % 16}.png`,
    rating_imdb: rating(id),
    year: String(yearBase + (id % 10)),
    description: `Synthetic plot of ${name}.`,
    actors: 'Synthetic Cast A, Synthetic Cast B',
    director: 'Synthetic Director',
  };
}

function movieRow(m: Movie, ctx: ApiContext): Row {
  return {
    ...vodMeta(m.id, m.name, m.categoryId, ctx.baseUrl, 2015),
    cmd: `ffmpeg http://localhost/vod/${m.id}`,
  };
}

function seriesRow(s: Series, ctx: ApiContext): Row {
  return {
    ...vodMeta(s.id, s.name, s.categoryId, ctx.baseUrl, 2016),
    is_series: 1,
    cmd: `ffmpeg http://localhost/series/${s.id}`,
  };
}

function parseNumericId(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^(?:ffmpeg|ffrt|auto)\s+/i, '');
  const match = /(\d+)(?:\.[a-z0-9]+)?$/i.exec(cleaned);
  return match ? Number(match[1]) : null;
}

function parseSeasonNumber(raw: string): number | null {
  const colon = raw.lastIndexOf(':');
  const num = Number(colon >= 0 ? raw.slice(colon + 1) : raw);
  return Number.isInteger(num) && num >= 1 ? num : null;
}

function categoriesPayload(catalog: Catalog, kind: 'live' | 'vod' | 'series'): Row[] {
  return [
    { id: '*', title: 'All' },
    ...catalog.categories.filter((c) => c.kind === kind).map((c) => ({ id: c.id, title: c.name })),
  ];
}

function epgEntry(chId: number, start: number, stop: number, name: string, descr: string): Row {
  return {
    id: `${chId}_${start}`,
    ch_id: String(chId),
    time: utcText(start),
    time_to: utcText(stop),
    start_timestamp: start,
    stop_timestamp: stop,
    name,
    descr,
  };
}

function epgInfoPayload(catalog: Catalog, query: URLSearchParams, ctx: ApiContext): Row {
  const periodHours = Number(query.get('period') ?? '0');
  const nowSec = sec(ctx.now);
  const maxStop = periodHours > 0 ? nowSec + periodHours * HOUR_SEC : Number.POSITIVE_INFINITY;
  const filterChId = query.get('ch_id');
  const data: Record<string, Row[]> = {};
  catalog.live.forEach((ch, index) => {
    if (ch.epgId === null) return;
    if (filterChId !== null && filterChId !== '' && String(ch.id) !== filterChId) return;
    const rows: Row[] = [];
    for (const p of programmesFor(catalog, index, ctx.now)) {
      const start = sec(p.start);
      const stop = sec(p.stop);
      if (periodHours > 0 && (stop <= nowSec || start >= maxStop)) continue;
      rows.push(epgEntry(ch.id, start, stop, p.title, p.desc));
    }
    data[String(ch.id)] = rows;
  });
  return { data };
}

function shortEpgPayload(catalog: Catalog, query: URLSearchParams, ctx: ApiContext): Row[] {
  const chId = Number(query.get('ch_id'));
  const sizeParam = Number(query.get('size') ?? DEFAULT_SHORT_EPG_SIZE);
  const limit = Number.isInteger(sizeParam) && sizeParam > 0 ? sizeParam : DEFAULT_SHORT_EPG_SIZE;
  const index = catalog.live.findIndex((c) => c.id === chId);
  const channel = catalog.live[index];
  if (!channel || channel.epgId === null) return [];
  const nowSec = sec(ctx.now);
  const rows: Row[] = [];
  for (const p of programmesFor(catalog, index, ctx.now)) {
    const start = sec(p.start);
    const stop = sec(p.stop);
    if (stop <= nowSec) continue;
    rows.push(epgEntry(channel.id, start, stop, p.title, p.desc));
    if (rows.length >= limit) break;
  }
  return rows;
}

function seriesOrderedList(catalog: Catalog, query: URLSearchParams, ctx: ApiContext): Row {
  const movieIdRaw = query.get('movie_id');
  const seasonIdRaw = query.get('season_id');
  const page = query.get('p');
  if (!movieIdRaw) {
    const cat = query.get('category') ?? query.get('genre');
    const items = catalog.series
      .filter((s) => !cat || cat === '*' || s.categoryId === cat)
      .map((s) => seriesRow(s, ctx));
    return paginate(items, page);
  }
  const seriesId = parseNumericId(movieIdRaw.split(':')[0] ?? movieIdRaw);
  const series = catalog.series.find((s) => s.id === seriesId);
  if (!series) return paginate([], page);
  if (!seasonIdRaw) {
    const bySeason = new Map<number, number[]>();
    for (const ep of series.episodes) {
      const nums = bySeason.get(ep.season) ?? [];
      nums.push(ep.episode);
      bySeason.set(ep.season, nums);
    }
    const seasons: Row[] = [...bySeason.entries()].map(([seasonNum, epNums]) => ({
      id: `${series.id}:${seasonNum}`,
      season_number: seasonNum,
      name: `Season ${seasonNum}`,
      series: epNums,
      cmd: `ffmpeg http://localhost/series/${series.id}/season/${seasonNum}`,
    }));
    return paginate(seasons, page);
  }
  const seasonNum = parseSeasonNumber(seasonIdRaw);
  const episodes: Row[] = series.episodes
    .filter((e) => e.season === seasonNum)
    .map((e) => ({
      id: String(e.id),
      series_number: e.episode,
      season_number: e.season,
      name: e.title,
      cmd: `ffmpeg http://localhost/series/${e.id}`,
    }));
  return paginate(episodes, page);
}

function linkResult(
  baseUrl: string,
  authSeg: string,
  segment: string,
  id: number,
  ext: string,
): Row {
  return { id: String(id), cmd: `ffmpeg ${baseUrl}/${segment}/${authSeg}/${id}.${ext}` };
}

function createLinkPayload(
  type: string,
  catalog: Catalog,
  account: Account,
  query: URLSearchParams,
  ctx: ApiContext,
): Row {
  const id = parseNumericId(query.get('cmd'));
  if (id === null) return { cmd: '' };
  const authSeg = `${account.username}/${account.password}`;
  if (type === 'itv' && catalog.live.some((c) => c.id === id)) {
    return linkResult(ctx.baseUrl, authSeg, 'live', id, 'ts');
  }
  if (type === 'vod' && catalog.movies.some((m) => m.id === id)) {
    return linkResult(ctx.baseUrl, authSeg, 'movie', id, 'mp4');
  }
  if (type === 'series' && catalog.series.some((s) => s.episodes.some((e) => e.id === id))) {
    return linkResult(ctx.baseUrl, authSeg, 'series', id, 'mp4');
  }
  return { cmd: '' };
}

/** Answers Stalker / Ministra portal requests for `/portal.php` and `/stalker_portal/server/load.php`. */
export function stalkerApi(
  query: URLSearchParams,
  headers: StalkerHeaders,
  ctx: ApiContext,
  store: StalkerSessionStore,
): ApiResult {
  const type = (query.get('type') ?? '').toLowerCase();
  const action = (query.get('action') ?? '').toLowerCase();
  const cookieMac = parseMacCookie(headers.cookie);

  if (type === 'stb' && action === 'handshake') {
    const account = resolveStalkerAccount(cookieMac);
    if (!account || cookieMac === null) return unauthorized();
    const token = store.issue(cookieMac, account, query.get('sim_expire_once') === '1');
    return ok({ token, random: RANDOM_TOKEN });
  }

  const session = store.verify(parseBearer(headers.authorization), cookieMac);
  if (!session) return unauthorized();

  const { account } = session;
  const catalog = buildCatalog(account.profile, ctx.seed);

  if (type === 'stb' && action === 'get_profile') {
    const nowSec = sec(ctx.now);
    const expired = account.status === 'Expired';
    const expSec = expired ? nowSec - DAY_SEC : nowSec + 365 * DAY_SEC;
    return ok({
      id: '1',
      status: 0,
      blocked: expired ? '1' : '0',
      expire_billing_date: utcText(expSec),
      default_timezone: 'UTC',
      max_online: account.maxConnections,
    });
  }

  if (action === 'create_link' && (type === 'itv' || type === 'vod' || type === 'series')) {
    return ok(createLinkPayload(type, catalog, account, query, ctx));
  }

  if (type === 'itv') {
    if (action === 'get_genres') return ok(categoriesPayload(catalog, 'live'));
    if (action === 'get_all_channels') {
      const data = catalog.live.map((ch) => liveRow(ch, ctx));
      return ok({ total_items: data.length, max_page_items: data.length, data });
    }
    if (action === 'get_ordered_list') {
      const genre = query.get('genre');
      const items = catalog.live
        .filter((ch) => !genre || genre === '*' || ch.categoryId === genre)
        .map((ch) => liveRow(ch, ctx));
      return ok(paginate(items, query.get('p')));
    }
    if (action === 'get_epg_info') return ok(epgInfoPayload(catalog, query, ctx));
    if (action === 'get_short_epg') return ok(shortEpgPayload(catalog, query, ctx));
  }

  if (type === 'vod') {
    if (action === 'get_categories') return ok(categoriesPayload(catalog, 'vod'));
    if (action === 'get_ordered_list') {
      const cat = query.get('category') ?? query.get('genre');
      const items = catalog.movies
        .filter((m) => !cat || cat === '*' || m.categoryId === cat)
        .map((m) => movieRow(m, ctx));
      return ok(paginate(items, query.get('p')));
    }
  }

  if (type === 'series') {
    if (action === 'get_categories') return ok(categoriesPayload(catalog, 'series'));
    if (action === 'get_ordered_list') return ok(seriesOrderedList(catalog, query, ctx));
  }

  return ok([]);
}

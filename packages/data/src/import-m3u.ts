import {
  elvError,
  err,
  type HttpResponse,
  m3uKey,
  ok,
  type Result,
  transportHeaders,
} from '@elv/domain';
import { type M3uEntry, scanM3u } from '@elv/sources';
import { foldText } from './fold';
import { checkAbort, performRun, type RunCtx, Stop, unwrap } from './import-run';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import {
  knownCredentials,
  majorityValues,
  placeholderNames,
  SAMPLE_SIZE,
  VarBook,
} from './m3u-templating';
import {
  getSource,
  type SourceRecord,
  type SourceSettings,
  secretKey,
  templateGuide,
  updateSourceSettings,
} from './sources';
import { detectSegmentRules, type SegmentRule, toTemplate, type UrlVars } from './templates';
import { writeCategories, writePlacements } from './writers';
import {
  type M3uLiveRow,
  type M3uRow,
  writeM3uEpisodes,
  writeM3uLive,
  writeM3uMovies,
  writeM3uSeries,
} from './writers-m3u';

type Kind = 'live' | 'movie' | 'series';

const REQUEST_TIMEOUT_MS = 60_000;
const UNGROUPED = 'Ungrouped';

interface State {
  settings: SourceSettings;
  rules: SegmentRule[];
  expected: UrlVars;
  known: { username?: string; password?: string };
  book: VarBook;
  categories: Record<Kind, Map<string, number>>;
  positions: Map<string, number>;
  placedSeries: Set<string>;
  seen: Record<'live' | 'movies' | 'episodes' | 'series', Set<string>>;
}

async function discard(body: HttpResponse['body']): Promise<void> {
  try {
    await body[Symbol.asyncIterator]().return?.();
  } catch {
    // the response is already classified by its status
  }
}

async function openPlaylist(
  source: SourceRecord,
  url: string,
  deps: ImportDeps,
  signal: AbortSignal | undefined,
): Promise<AsyncIterable<Uint8Array>> {
  let response: Awaited<ReturnType<ImportDeps['http']['get']>>;
  try {
    response = await deps.http.get(url, {
      headers: transportHeaders(source.settings.transport),
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new Stop(elvError('network', signal?.aborted ? 'aborted' : 'request-failed'));
  }
  const { status, body } = unwrap(response);
  if (status >= 200 && status < 300) return body;
  await discard(body);
  if (status === 401 || status === 403) throw new Stop(elvError('auth', 'unauthorized'));
  if (status >= 500) throw new Stop(elvError('network', 'server-error'));
  throw new Stop(elvError('network', 'http-status', `HTTP ${status}`));
}

async function readUrlVars(deps: ImportDeps, sourceId: string): Promise<UrlVars> {
  const raw = await deps.secrets.get(secretKey(sourceId, 'urlvars')).catch(() => undefined);
  try {
    return raw === undefined ? {} : (JSON.parse(raw) as UrlVars);
  } catch {
    return {};
  }
}

function start(source: SourceRecord, playlistUrl: string, sample: readonly M3uEntry[]): State {
  const urls = sample.map((e) => e.url);
  const stored = source.settings.segmentRules;
  const rules = stored !== undefined && stored.length > 0 ? stored : detectSegmentRules(urls);
  const expected = majorityValues(rules, urls);
  const settings: SourceSettings = { ...source.settings };
  if (rules.length > 0) settings.segmentRules = rules;
  else delete settings.segmentRules;
  return {
    settings,
    rules,
    expected,
    known: knownCredentials(playlistUrl),
    book: new VarBook(expected),
    categories: { live: new Map(), movie: new Map(), series: new Map() },
    positions: new Map(),
    placedSeries: new Set(),
    seen: { live: new Set(), movies: new Set(), episodes: new Set(), series: new Set() },
  };
}

function templated(st: State, url: string): string {
  return st.book.absorb(toTemplate(url, st.rules, st.known, st.expected));
}

function liveHeaders(st: State, entry: M3uEntry): string | null {
  const headers: { userAgent?: string; referer?: string } = {};
  if (entry.headers.userAgent !== undefined) headers.userAgent = entry.headers.userAgent;
  if (entry.headers.referer !== undefined) headers.referer = templated(st, entry.headers.referer);
  return Object.keys(headers).length === 0 ? null : JSON.stringify(headers);
}

const groupsOf = (entry: M3uEntry): readonly string[] =>
  entry.groups.length === 0 ? [UNGROUPED] : entry.groups;

function place(
  st: State,
  kind: Kind,
  key: string,
  groups: readonly string[],
  fresh: Map<Kind, string[]>,
  links: Record<Kind, [string, string, number][]>,
): void {
  const known = st.categories[kind];
  for (const group of groups) {
    if (!known.has(group)) {
      known.set(group, known.size);
      fresh.set(kind, [...(fresh.get(kind) ?? []), group]);
    }
    const slot = `${kind}\n${group}`;
    const position = st.positions.get(slot) ?? 0;
    st.positions.set(slot, position + 1);
    links[kind].push([key, group, position]);
  }
}

async function processBatch(c: RunCtx, st: State, entries: readonly M3uEntry[]): Promise<void> {
  const vod = st.settings.vodPlaylist === true;
  const live: M3uLiveRow[] = [];
  const movies: M3uRow[] = [];
  const episodes: (M3uRow & { seriesKey: string })[] = [];
  const series = new Map<string, string>();
  const fresh = new Map<Kind, string[]>();
  const links: Record<Kind, [string, string, number][]> = { live: [], movie: [], series: [] };
  for (const entry of entries) {
    const template = templated(st, entry.url);
    const row: M3uRow = {
      key: m3uKey(c.sourceId, template, entry.name),
      name: entry.name,
      logo: entry.tvgLogo === undefined ? null : templated(st, entry.tvgLogo),
      template,
    };
    if (vod || entry.kindHint === 'movie') {
      movies.push(row);
      st.seen.movies.add(row.key);
      place(st, 'movie', row.key, groupsOf(entry), fresh, links);
    } else if (entry.kindHint === 'episode') {
      const group = entry.groups[0] ?? UNGROUPED;
      const folded = foldText(group);
      const seriesKey = `m:${c.sourceId}:series:${folded === '' ? 'ungrouped' : folded}`;
      episodes.push({ ...row, seriesKey });
      st.seen.episodes.add(row.key);
      if (!st.seen.series.has(seriesKey)) {
        st.seen.series.add(seriesKey);
        series.set(seriesKey, group);
      }
      const groups = groupsOf(entry);
      place(
        st,
        'series',
        seriesKey,
        groups.filter((g) => !st.placedSeries.has(`${seriesKey}\n${g}`)),
        fresh,
        links,
      );
      for (const g of groups) st.placedSeries.add(`${seriesKey}\n${g}`);
    } else {
      live.push({
        ...row,
        num: entry.chno ?? null,
        guideId: entry.tvgId ?? null,
        catchupDays: entry.catchup?.days ?? null,
        headersJson: liveHeaders(st, entry),
      });
      st.seen.live.add(row.key);
      place(st, 'live', row.key, groupsOf(entry), fresh, links);
    }
  }
  for (const kind of ['live', 'movie', 'series'] as const) {
    const names = fresh.get(kind) ?? [];
    const first = st.categories[kind].size - names.length;
    await writeCategories(
      c.db,
      c.sourceId,
      kind,
      c.runId,
      names.map((name) => ({ id: name, name })),
      first,
    );
  }
  await writeM3uLive(c.db, c.sourceId, c.runId, live);
  await writeM3uMovies(c.db, c.sourceId, c.runId, movies);
  await writeM3uSeries(
    c.db,
    c.sourceId,
    c.runId,
    [...series].map(([key, name]) => ({ key, name })),
  );
  await writeM3uEpisodes(c.db, c.sourceId, c.runId, episodes);
  for (const kind of ['live', 'movie', 'series'] as const) {
    await writePlacements(c.db, c.sourceId, kind, c.runId, links[kind]);
  }
  const phases = [
    ['live', st.seen.live],
    ['movies', st.seen.movies],
    ['series', st.seen.series],
    ['episodes', st.seen.episodes],
  ] as const;
  for (const [phase, set] of phases) if (set.size > 0) c.progress({ phase, done: set.size });
  await c.deps.scheduler.yieldNow();
}

/** Settings and secret values a successful run commits together with its `ok` transition. */
interface Staged {
  rules: SegmentRule[];
  discovered: string[] | undefined;
  vars: UrlVars;
}

function finish(
  c: RunCtx,
  st: State,
  playlistUrl: string,
  oldVars: UrlVars,
  guideUrls: readonly string[],
): Staged {
  const own = st.settings.guideUrl;
  const kept: UrlVars = {};
  for (const name of own === undefined ? [] : placeholderNames(own)) {
    if (Object.hasOwn(oldVars, name)) kept[name] = oldVars[name] as string;
  }
  const guideBook = new VarBook(kept);
  const discovered =
    own === undefined && guideUrls.length > 0
      ? guideUrls.map((u) => guideBook.absorb(templateGuide(u, playlistUrl)))
      : undefined;
  const vars: UrlVars = {};
  for (const [name, value] of Object.entries(st.book.vars)) {
    if (!name.startsWith('g:')) vars[name] = value;
  }
  c.counts.live = st.seen.live.size;
  c.counts.movies = st.seen.movies.size;
  c.counts.series = st.seen.series.size;
  c.counts.episodes = st.seen.episodes.size;
  c.counts.categories =
    st.categories.live.size + st.categories.movie.size + st.categories.series.size;
  return { rules: st.rules, discovered, vars: { ...vars, ...guideBook.vars } };
}

async function execute(
  c: RunCtx,
  source: SourceRecord,
  playlistUrl: string,
  oldVars: UrlVars,
): Promise<Staged> {
  const body = await openPlaylist(source, playlistUrl, c.deps, c.signal);
  const scan = scanM3u(body, { batchSize: c.batchSize, baseUrl: playlistUrl });
  const buffered: M3uEntry[] = [];
  let st: State | undefined;
  let total = 0;
  let guideUrls: string[] = [];
  let present = false;
  try {
    for (;;) {
      checkAbort(c);
      const next = await scan.next();
      if (next.done === true) {
        unwrap(next.value);
        break;
      }
      const batch = next.value;
      total += batch.entries.length;
      if (batch.header !== undefined) {
        present = batch.header.present;
        guideUrls = batch.header.guideUrls;
      }
      if (batch.stats !== undefined) c.warnings = batch.stats.warnings.length;
      if (st === undefined) {
        buffered.push(...batch.entries);
        if (buffered.length < SAMPLE_SIZE && !batch.done) continue;
        if (batch.done && total === 0 && !present) {
          throw new Stop(elvError('source-format', 'not-a-playlist'));
        }
        st = start(source, playlistUrl, buffered.slice(0, SAMPLE_SIZE));
        for (let i = 0; i < buffered.length; i += c.batchSize) {
          checkAbort(c);
          await processBatch(c, st, buffered.slice(i, i + c.batchSize));
        }
        buffered.length = 0;
      } else {
        await processBatch(c, st, batch.entries);
      }
    }
  } finally {
    await scan.return(ok(undefined));
  }
  if (st === undefined) throw new Stop(elvError('network', 'stream-failed'));
  return finish(c, st, playlistUrl, oldVars, guideUrls);
}

/**
 * Imports an M3U source: the playlist streams through the scanner into the catalog tables. Every entry URL is
 * stored as a credential-free template (segment rules, credential query parameters, the `get.php` credentials);
 * the values go to `source:<id>:urlvars`. Entries become live channels, movies or episodes by `kindHint`
 * (all movies for a `vodPlaylist`); episodes hang under a synthetic series per `group-title`. A body with no
 * `#EXTM3U` and no entries yields `source-format/not-a-playlist`.
 */
export async function importM3u(
  source: SourceRecord,
  deps: ImportDeps,
  opts: ImportOptions,
): Promise<Result<ImportSummary>> {
  const playlistUrl = await deps.secrets
    .get(secretKey(source.id, 'playlist'))
    .catch(() => undefined);
  if (playlistUrl === undefined) return err(elvError('storage', 'secret-missing'));
  const oldVars = await readUrlVars(deps, source.id);
  let staged: Staged | undefined;
  return performRun(source, deps, opts, {
    execute: async (c) => {
      staged = await execute(c, source, playlistUrl, oldVars);
    },
    beforeCleanup: async (tx) => {
      if (staged === undefined) return;
      const current = (await getSource(tx, source.id))?.settings ?? source.settings;
      const settings: SourceSettings = { ...current };
      if (staged.rules.length > 0) settings.segmentRules = staged.rules;
      else delete settings.segmentRules;
      if (staged.discovered === undefined) delete settings.discoveredGuideUrls;
      else settings.discoveredGuideUrls = staged.discovered;
      await updateSourceSettings(tx, source.id, settings);
    },
    afterCommit: async () => {
      if (staged === undefined) return;
      await deps.secrets.set(secretKey(source.id, 'urlvars'), JSON.stringify(staged.vars));
    },
  });
}

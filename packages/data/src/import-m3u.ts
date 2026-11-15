import {
  elvError,
  err,
  type HttpResponse,
  httpStatusError,
  m3uKey,
  ok,
  openAsyncIterator,
  type Result,
  transportHeaders,
} from '@elv/domain';
import { type M3uEntry, scanM3u } from '@elv/sources';
import { foldText } from './fold';
import { checkAbort, performRun, type RunCtx, Stop, unwrap } from './import-run';
import type { ImportDeps, ImportOptions, ImportSummary } from './import-types';
import { RuleBook } from './m3u-rules';
import {
  knownCredentials,
  MAX_URLVARS_BYTES,
  placeholderNames,
  SAMPLE_SIZE,
  utf8ByteLength,
  VarBook,
} from './m3u-templating';
import {
  getSource,
  guideSecret,
  type SourceRecord,
  type SourceSettings,
  secretKey,
  updateSourceSettings,
} from './sources';
import { readUrlVars } from './stream-resolver';
import { hostOf, keyTemplate, type SegmentRule, toTemplate, type UrlVars } from './templates';
import { writeCategories, writePlacements } from './writers';
import {
  type M3uLiveRow,
  type M3uRow,
  rollbackUnresolvedM3uRows,
  writeM3uEpisodes,
  writeM3uLive,
  writeM3uMovies,
  writeM3uSeries,
} from './writers-m3u';

type Kind = 'live' | 'movie' | 'series';

const REQUEST_TIMEOUT_MS = 60_000;
const UNGROUPED = 'Ungrouped';
const SECRET_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-auth-token',
]);

interface State {
  settings: SourceSettings;
  rules: RuleBook;
  known: { username?: string; password?: string };
  book: VarBook;
  categories: Record<Kind, Map<string, number>>;
  positions: Map<string, number>;
  placedSeries: Set<string>;
  written: Record<'live' | 'movies' | 'episodes' | 'series', number>;
}

async function discard(body: HttpResponse['body']): Promise<void> {
  try {
    await openAsyncIterator(body).return?.();
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
  throw new Stop(httpStatusError(status));
}

function collectSampleUrls(sample: readonly M3uEntry[]): { url: string; role: string }[] {
  const out: { url: string; role: string }[] = [];
  for (const e of sample) {
    out.push({ url: e.url, role: 'stream' });
    if (e.tvgLogo !== undefined) out.push({ url: e.tvgLogo, role: 'logo' });
    if (e.headers.referer !== undefined) out.push({ url: e.headers.referer, role: 'referer' });
    for (const v of Object.values(e.headers.other)) {
      if (hostOf(v) !== undefined) out.push({ url: v, role: 'other' });
    }
  }
  return out;
}

function holdEntry(rules: RuleBook, entry: M3uEntry): boolean {
  let wait = rules.hold(entry.url, 'stream');
  if (entry.tvgLogo !== undefined && rules.hold(entry.tvgLogo, 'logo')) wait = true;
  if (entry.headers.referer !== undefined && rules.hold(entry.headers.referer, 'referer')) {
    wait = true;
  }
  for (const v of Object.values(entry.headers.other)) {
    if (hostOf(v) !== undefined && rules.hold(v, 'other')) wait = true;
  }
  return wait;
}

function start(source: SourceRecord, playlistUrl: string, sample: readonly M3uEntry[]): State {
  const rules = new RuleBook(source.settings.segmentRules);
  rules.startEntries(collectSampleUrls(sample));
  return {
    settings: { ...source.settings },
    rules,
    known: knownCredentials(playlistUrl),
    book: new VarBook(),
    categories: { live: new Map(), movie: new Map(), series: new Map() },
    positions: new Map(),
    placedSeries: new Set(),
    written: { live: 0, movies: 0, episodes: 0, series: 0 },
  };
}

function templated(st: State, url: string): string {
  return st.book.absorb(toTemplate(url, st.rules.rules, st.known));
}

function entryHeaders(st: State, entry: M3uEntry): string | null {
  const headers: { userAgent?: string; referer?: string; other?: Record<string, string> } = {};
  if (entry.headers.userAgent !== undefined) headers.userAgent = entry.headers.userAgent;
  if (entry.headers.referer !== undefined) headers.referer = templated(st, entry.headers.referer);
  const otherKeys = Object.keys(entry.headers.other);
  if (otherKeys.length > 0) {
    const other: Record<string, string> = {};
    for (const key of otherKeys) {
      const val = entry.headers.other[key] as string;
      if (SECRET_HEADERS.has(key)) {
        const name = `h:${key}`;
        other[key] = st.book.absorb({ template: `{{${name}}}`, vars: { [name]: val } });
      } else if (hostOf(val) !== undefined) {
        other[key] = templated(st, val);
      } else {
        other[key] = val.replace(/\{\{/g, '{{(}}');
      }
    }
    headers.other = other;
  }
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
      let list = fresh.get(kind);
      if (list === undefined) {
        list = [];
        fresh.set(kind, list);
      }
      list.push(group);
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
      key: m3uKey(c.sourceId, keyTemplate(template), entry.name),
      name: entry.name,
      logo: entry.tvgLogo === undefined ? null : templated(st, entry.tvgLogo),
      template,
      headersJson: entryHeaders(st, entry),
    };
    if (st.book.byteLength > MAX_URLVARS_BYTES) {
      throw new Stop(elvError('source-format', 'urlvars-too-large'));
    }
    if (vod || entry.kindHint === 'movie') {
      movies.push(row);
      st.written.movies += 1;
      place(st, 'movie', row.key, groupsOf(entry), fresh, links);
    } else if (entry.kindHint === 'episode') {
      const group = entry.groups[0] ?? UNGROUPED;
      const folded = foldText(group);
      const seriesKey = `m:${c.sourceId}:series:${folded === '' ? 'ungrouped' : folded}`;
      episodes.push({ ...row, seriesKey });
      st.written.episodes += 1;
      if (!series.has(seriesKey)) series.set(seriesKey, group);
      const groups = groupsOf(entry);
      const freshGroups = groups.filter((g) => !st.placedSeries.has(`${seriesKey}\n${g}`));
      if (freshGroups.length > 0) {
        st.written.series += 1;
        place(st, 'series', seriesKey, freshGroups, fresh, links);
        for (const g of freshGroups) st.placedSeries.add(`${seriesKey}\n${g}`);
      }
    } else {
      live.push({
        ...row,
        num: entry.chno ?? null,
        guideId: entry.tvgId ?? null,
        catchupDays: entry.catchup?.days ?? entry.timeshiftDays ?? null,
      });
      st.written.live += 1;
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
  for (const phase of ['live', 'movies', 'series', 'episodes'] as const) {
    if (st.written[phase] > 0) c.progress({ phase, done: st.written[phase] });
  }
  await c.deps.scheduler.yieldNow();
}

/** Settings and secret values a successful run commits together with its `ok` transition. */
interface Staged {
  rules: SegmentRule[];
  discovered: string[] | undefined;
  vars: UrlVars;
}

function finish(c: RunCtx, st: State, oldVars: UrlVars, guideUrls: readonly string[]): Staged {
  const own = st.settings.guideUrl;
  const vars: UrlVars = {};
  for (const [name, value] of Object.entries(st.book.vars)) {
    if (!name.startsWith('g:')) vars[name] = value;
  }
  for (const name of own === undefined ? [] : placeholderNames(own)) {
    if (Object.hasOwn(oldVars, name)) vars[name] = oldVars[name] as string;
  }
  let discovered: string[] | undefined;
  if (own === undefined && guideUrls.length > 0) {
    discovered = guideUrls.map((url, i) => {
      const g = guideSecret(url, `d${i}`);
      Object.assign(vars, g.vars);
      return g.template;
    });
  }
  if (utf8ByteLength(JSON.stringify(vars)) > MAX_URLVARS_BYTES) {
    throw new Stop(elvError('source-format', 'urlvars-too-large'));
  }
  c.counts.live = st.written.live;
  c.counts.movies = st.written.movies;
  c.counts.series = st.written.series;
  c.counts.episodes = st.written.episodes;
  c.counts.categories =
    st.categories.live.size + st.categories.movie.size + st.categories.series.size;
  return { rules: st.rules.final(), discovered, vars };
}

/**
 * Feeds every entry through the rule book: an entry whose host still collects URLs is held back together with
 * every later entry (order is kept), until those hosts are judged or {@link SAMPLE_SIZE} entries wait.
 */
class Gate {
  private readonly held: M3uEntry[] = [];
  private readonly st: State;

  constructor(st: State) {
    this.st = st;
  }

  /** Entries that may be written now, in playlist order. */
  admit(entries: readonly M3uEntry[]): M3uEntry[] {
    const out: M3uEntry[] = [];
    for (const entry of entries) {
      const wait = holdEntry(this.st.rules, entry);
      if (this.held.length === 0 && !wait) {
        out.push(entry);
        continue;
      }
      this.held.push(entry);
      if (this.st.rules.ready || this.held.length >= SAMPLE_SIZE) out.push(...this.release());
    }
    return out;
  }

  /** Judges the waiting hosts and returns every held entry. */
  release(): M3uEntry[] {
    this.st.rules.settle();
    return this.held.splice(0);
  }
}

async function write(c: RunCtx, st: State, entries: readonly M3uEntry[]): Promise<void> {
  for (let i = 0; i < entries.length; i += c.batchSize) {
    checkAbort(c);
    await processBatch(c, st, entries.slice(i, i + c.batchSize));
  }
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
  let gate: Gate | undefined;
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
      if (st === undefined || gate === undefined) {
        buffered.push(...batch.entries);
        if (buffered.length < SAMPLE_SIZE && !batch.done) continue;
        if (batch.done && total === 0 && !present) {
          throw new Stop(elvError('source-format', 'not-a-playlist'));
        }
        st = start(source, playlistUrl, buffered.slice(0, SAMPLE_SIZE));
        gate = new Gate(st);
        await write(c, st, gate.admit(buffered));
        buffered.length = 0;
      } else {
        await write(c, st, gate.admit(batch.entries));
      }
    }
  } finally {
    await scan.return(ok(undefined));
  }
  if (st === undefined || gate === undefined) throw new Stop(elvError('network', 'stream-failed'));
  await write(c, st, gate.release());
  return finish(c, st, oldVars, guideUrls);
}

/**
 * Imports an M3U source: the playlist streams through the scanner into the catalog tables. Every entry URL is
 * stored as a credential-free template (segment rules, credential query parameters, the `get.php` credentials);
 * the values go to `source.<id>.urlvars`. Entries become live channels, movies or episodes by `kindHint`
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
  const urlvarsKey = secretKey(source.id, 'urlvars');
  const oldVars = await readUrlVars(deps, source.id);
  let staged: Staged | undefined;
  let secretsStaged = false;
  return performRun(source, deps, opts, {
    execute: async (c) => {
      staged = await execute(c, source, playlistUrl, oldVars);
    },
    beforeCommit: async () => {
      if (staged === undefined) return;
      const merged: UrlVars = { ...oldVars, ...staged.vars };
      try {
        await deps.secrets.set(urlvarsKey, JSON.stringify(merged));
        secretsStaged = true;
      } catch {
        throw new Stop(elvError('storage', 'secret-write-failed'));
      }
    },
    beforeCleanup: async (tx, c) => {
      if (staged === undefined) return;
      for (const [key, table] of [
        ['live', 'live'],
        ['movies', 'movies'],
        ['series', 'series'],
        ['episodes', 'episodes'],
      ] as const) {
        const r = await tx.all<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE source_id = ? AND run_id = ?`,
          [c.sourceId, c.runId],
        );
        c.counts[key] = r[0]?.n ?? 0;
      }
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
      const vars = staged.vars;
      if (Object.keys(oldVars).some((k) => !Object.hasOwn(vars, k))) {
        await deps.secrets.set(urlvarsKey, JSON.stringify(vars)).catch(() => undefined);
      }
    },
    onAbortOrFail: async (c, outcome, error) => {
      if (outcome === 'source-removed') {
        if (secretsStaged) await deps.secrets.delete(urlvarsKey).catch(() => undefined);
        return;
      }
      if (secretsStaged) {
        await deps.secrets.set(urlvarsKey, JSON.stringify(oldVars)).catch(() => undefined);
      }
      if (error.code === 'urlvars-too-large' || error.code === 'secret-write-failed') {
        await rollbackUnresolvedM3uRows(deps.db, source.id, c.runId, oldVars);
      }
    },
  });
}

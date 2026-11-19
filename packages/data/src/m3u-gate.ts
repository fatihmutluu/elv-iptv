import { elvError } from '@elv/domain';
import type { M3uEntry } from '@elv/sources';
import { type RunCtx, Stop } from './import-run';
import { collectSampleUrls, holdEntry } from './m3u-headers';
import { RuleBook } from './m3u-rules';
import {
  knownCredentials,
  MAX_URLVARS_BYTES,
  placeholderNames,
  SAMPLE_SIZE,
  utf8ByteLength,
  VarBook,
} from './m3u-templating';
import { guideSecret, type SourceRecord, type SourceSettings } from './sources';
import type { SegmentRule, UrlVars } from './templates';

export type M3uBrowseKind = 'live' | 'movie' | 'series';

export interface M3uImportState {
  settings: SourceSettings;
  rules: RuleBook;
  known: { username?: string; password?: string };
  book: VarBook;
  categories: Record<M3uBrowseKind, Map<string, number>>;
  positions: Map<string, number>;
  placedSeries: Set<string>;
  written: Record<'live' | 'movies' | 'episodes' | 'series', number>;
}

/** Initializes M3U import state and seeds `RuleBook` with the initial entry sample. */
export function createM3uImportState(
  source: SourceRecord,
  playlistUrl: string,
  sample: readonly M3uEntry[],
): M3uImportState {
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

/**
 * Feeds every entry through the rule book: an entry whose host still collects URLs is held back together with
 * every later entry (order is kept), until those hosts are judged or {@link SAMPLE_SIZE} entries wait.
 */
export class M3uEntryGate {
  private readonly held: M3uEntry[] = [];
  private readonly st: M3uImportState;

  constructor(st: M3uImportState) {
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

export interface StagedM3u {
  rules: SegmentRule[];
  discovered: string[] | undefined;
  vars: UrlVars;
}

/** Finalizes staged rules, guide URLs, and `urlvars` secrets for an M3U import run. */
export function finishM3uRun(
  c: RunCtx,
  st: M3uImportState,
  oldVars: UrlVars,
  guideUrls: readonly string[],
): StagedM3u {
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

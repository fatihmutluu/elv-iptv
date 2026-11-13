/** Catalog profile names (spec section 5.2). */
export type ProfileName = 'small' | 'large' | 'compat';
/** Media recipe a stream is generated from (spec section 5.6). */
export type RecipeName =
  | 'h264-aac-720p25'
  | 'hevc-main10-1080p25'
  | 'mpeg2-ac3-576i25'
  | 'aac-radio';
/** Edge case of the `compat` profile; each case maps to exactly one live channel. */
export type CompatCase =
  | 'tvg-shift'
  | 'tvg-rec'
  | 'radio'
  | 'extgrp'
  | 'no-tvg-id'
  | 'duplicate-id-a'
  | 'duplicate-id-b'
  | 'empty-name'
  | 'long-name'
  | 'quotes-commas'
  | 'turkish-name'
  | 'rtl-name'
  | 'catchup-default'
  | 'catchup-append'
  | 'catchup-shift'
  | 'catchup-flussonic'
  | 'catchup-flussonic-hls'
  | 'catchup-xc'
  | 'catchup-fs'
  | 'vlcopt-user-agent'
  | 'vlcopt-referrer'
  | 'exthttp'
  | 'kodiprop-clearkey'
  | 'relative-url'
  | 'redirect-url'
  | 'credentials-in-url'
  | 'udp-url'
  | 'rtp-url'
  | 'rtmp-url'
  | 'missing-404';
/** A group of live channels, movies or series. */
interface Category {
  id: string;
  name: string;
  kind: 'live' | 'vod' | 'series';
}
/** A live channel of the catalog. */
export interface LiveChannel {
  id: number;
  /** One-based channel number in catalog order. */
  num: number;
  name: string;
  categoryId: string;
  /** Guide id (XMLTV channel id), or null when the channel has no guide entry. */
  epgId: string | null;
  /** Index (0-15) into the 16 served logos, or null when the channel has no logo. */
  logo: number | null;
  recipe: RecipeName;
  /** Fault spec bound to this stream (spec section 5.7), or null for a healthy stream. */
  fault: string | null;
  /** Days of catch-up archive offered; 0 means none. */
  archiveDays: number;
  /** Compatibility edge case this channel exercises; null outside the `compat` profile. */
  compat: CompatCase | null;
}
/** A VOD movie. */
interface Movie {
  id: number;
  name: string;
  categoryId: string;
  ext: 'mp4' | 'mkv';
  recipe: RecipeName;
  durationSec: number;
  /** Unix timestamp (seconds) when the movie was added. */
  added: number;
}
/** One episode of a series. */
interface Episode {
  id: number;
  season: number;
  episode: number;
  title: string;
  ext: 'mp4' | 'mkv';
  recipe: RecipeName;
  durationSec: number;
}
/** A series with all its episodes. */
interface Series {
  id: number;
  name: string;
  categoryId: string;
  episodes: Episode[];
}
/** Guide time range around now, in whole days. */
interface GuideWindow {
  daysBack: number;
  daysForward: number;
}
/** The full deterministic content of one profile and seed. */
export interface Catalog {
  profile: ProfileName;
  seed: number;
  categories: Category[];
  live: LiveChannel[];
  movies: Movie[];
  series: Series[];
  /** Number of channels that carry guide programmes (those with an `epgId`). */
  guideChannels: number;
  guideWindow: GuideWindow;
}

/** Every compatibility edge case, one live channel each in the `compat` profile. */
export const COMPAT_CASES: readonly CompatCase[] = [
  'tvg-shift',
  'tvg-rec',
  'radio',
  'extgrp',
  'no-tvg-id',
  'duplicate-id-a',
  'duplicate-id-b',
  'empty-name',
  'long-name',
  'quotes-commas',
  'turkish-name',
  'rtl-name',
  'catchup-default',
  'catchup-append',
  'catchup-shift',
  'catchup-flussonic',
  'catchup-flussonic-hls',
  'catchup-xc',
  'catchup-fs',
  'vlcopt-user-agent',
  'vlcopt-referrer',
  'exthttp',
  'kodiprop-clearkey',
  'relative-url',
  'redirect-url',
  'credentials-in-url',
  'udp-url',
  'rtp-url',
  'rtmp-url',
  'missing-404',
];

/** Seeded PRNG (mulberry32) returning floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LIVE_BASE = 1001;
const MOVIE_BASE = 200001;
const SERIES_BASE = 300001;
const EPISODE_BASE = 400001;
const ADDED_BASE = 1_700_000_000;
const VIDEO_RECIPES: readonly RecipeName[] = [
  'h264-aac-720p25',
  'hevc-main10-1080p25',
  'mpeg2-ac3-576i25',
];
const SMALL_FAULTS: Readonly<Record<number, string>> = { 1013: 'status=503', 1014: 'drop@10s' };
const COMPAT_NAMES: Partial<Record<CompatCase, string>> = {
  'empty-name': '',
  'long-name': `${'Long Name '.repeat(29)}Long Name.`,
  'quotes-commas': 'Channel "Quoted", With, Commas',
  'turkish-name': 'Kanal İğüşöçı',
  'rtl-name': 'قناة ٤٢',
};

interface Shape {
  live: number;
  movies: number;
  series: number;
  episodesPerSeries: number;
  liveCats: number;
  vodCats: number;
  seriesCats: number;
  guideChannels: number | null;
  guideWindow: GuideWindow;
}

const SHAPES: Record<ProfileName, Shape> = {
  small: {
    live: 50,
    movies: 30,
    series: 5,
    episodesPerSeries: 6,
    liveCats: 4,
    vodCats: 3,
    seriesCats: 3,
    guideChannels: null,
    guideWindow: { daysBack: 2, daysForward: 7 },
  },
  large: {
    live: 25000,
    movies: 70000,
    series: 500,
    episodesPerSeries: 10,
    liveCats: 100,
    vodCats: 100,
    seriesCats: 100,
    guideChannels: 5000,
    guideWindow: { daysBack: 0, daysForward: 7 },
  },
  compat: {
    live: COMPAT_CASES.length,
    movies: 0,
    series: 0,
    episodesPerSeries: 0,
    liveCats: 3,
    vodCats: 0,
    seriesCats: 0,
    guideChannels: null,
    guideWindow: { daysBack: 2, daysForward: 7 },
  },
};

const CATEGORY_BASE: Record<Category['kind'], number> = { live: 0, vod: 10000, series: 20000 };
const categoryId = (kind: Category['kind'], n: number): string => String(CATEGORY_BASE[kind] + n);

const pad = (n: number, width = 4): string => String(n).padStart(width, '0');

function makeCategories(shape: Shape): Category[] {
  const out: Category[] = [];
  const add = (kind: Category['kind'], count: number, label: string) => {
    for (let i = 1; i <= count; i++)
      out.push({ id: categoryId(kind, i), name: `${label} ${pad(i, 2)}`, kind });
  };
  add('live', shape.liveCats, 'Live Group');
  add('vod', shape.vodCats, 'Movie Group');
  add('series', shape.seriesCats, 'Series Group');
  return out;
}

function makeLive(profile: ProfileName, shape: Shape): LiveChannel[] {
  const out: LiveChannel[] = [];
  for (let i = 0; i < shape.live; i++) {
    const id = LIVE_BASE + i;
    const compat = profile === 'compat' ? (COMPAT_CASES[i] as CompatCase) : null;
    const radio = compat === 'radio' || (profile !== 'compat' && (i + 1) % 25 === 0);
    let hasEpg: boolean;
    if (profile === 'compat') hasEpg = compat !== 'no-tvg-id';
    else if (shape.guideChannels === null) hasEpg = i % 10 !== 9;
    else hasEpg = i < shape.guideChannels;
    out.push({
      id,
      num: i + 1,
      name:
        compat !== null && compat in COMPAT_NAMES
          ? (COMPAT_NAMES[compat] as string)
          : `Channel ${pad(i + 1)}`,
      categoryId: categoryId('live', (i % shape.liveCats) + 1),
      epgId: hasEpg ? `ch${id}` : null,
      logo: i % 7 === 6 ? null : id % 16,
      recipe: radio ? 'aac-radio' : (VIDEO_RECIPES[i % VIDEO_RECIPES.length] as RecipeName),
      fault: profile === 'small' ? (SMALL_FAULTS[id] ?? null) : null,
      archiveDays: compat?.startsWith('catchup-') ? 3 : 0,
      compat,
    });
  }
  return out;
}

function makeMovies(shape: Shape, next: () => number): Movie[] {
  const out: Movie[] = [];
  for (let i = 0; i < shape.movies; i++) {
    out.push({
      id: MOVIE_BASE + i,
      name: `Movie ${pad(i + 1)}`,
      categoryId: categoryId('vod', (i % shape.vodCats) + 1),
      ext: i % 4 === 3 ? 'mkv' : 'mp4',
      recipe: VIDEO_RECIPES[i % VIDEO_RECIPES.length] as RecipeName,
      durationSec: 3600 + Math.floor(next() * 5400),
      added: ADDED_BASE - Math.floor(next() * 31_536_000),
    });
  }
  return out;
}

function makeSeries(shape: Shape, next: () => number): Series[] {
  const out: Series[] = [];
  const perSeason = shape.episodesPerSeries / 2;
  for (let s = 0; s < shape.series; s++) {
    const name = `Series ${pad(s + 1)}`;
    const episodes: Episode[] = [];
    for (let e = 0; e < shape.episodesPerSeries; e++) {
      const season = Math.floor(e / perSeason) + 1;
      const episode = (e % perSeason) + 1;
      episodes.push({
        id: EPISODE_BASE + s * shape.episodesPerSeries + e,
        season,
        episode,
        title: `${name} S${pad(season, 2)}E${pad(episode, 2)}`,
        ext: 'mp4',
        recipe: VIDEO_RECIPES[(s + e) % VIDEO_RECIPES.length] as RecipeName,
        durationSec: 1200 + Math.floor(next() * 2400),
      });
    }
    out.push({
      id: SERIES_BASE + s,
      name,
      categoryId: categoryId('series', (s % shape.seriesCats) + 1),
      episodes,
    });
  }
  return out;
}

const cache = new Map<string, Catalog>();

/** Builds a fresh deterministic catalog for a profile and seed, bypassing the cache. */
export function createCatalog(profile: ProfileName, seed: number): Catalog {
  const shape = SHAPES[profile];
  const next = rng(seed);
  const live = makeLive(profile, shape);
  const catalog: Catalog = {
    profile,
    seed,
    categories: makeCategories(shape),
    live,
    movies: makeMovies(shape, next),
    series: makeSeries(shape, next),
    guideChannels: live.filter((c) => c.epgId !== null).length,
    guideWindow: shape.guideWindow,
  };
  return catalog;
}

/**
 * Returns the deterministic catalog for a profile, cached per (profile, seed).
 * The returned catalog is shared between callers and must not be mutated.
 */
export function buildCatalog(profile: ProfileName, seed: number): Catalog {
  const key = `${profile}:${seed}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const catalog = createCatalog(profile, seed);
  cache.set(key, catalog);
  return catalog;
}

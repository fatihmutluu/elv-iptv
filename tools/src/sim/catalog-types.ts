import type { RecipeName } from './recipes.ts';

/** Catalog profile names (spec section 5.2). */
export type ProfileName = 'small' | 'large' | 'compat' | 'huge' | 'corpus';
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
  | 'raw-quote-attr'
  | 'missing-404';
/** A group of live channels, movies or series. */
export interface Category {
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
export interface Movie {
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
export interface Episode {
  id: number;
  season: number;
  episode: number;
  title: string;
  ext: 'mp4' | 'mkv';
  recipe: RecipeName;
  durationSec: number;
}
/** A series with all its episodes. */
export interface Series {
  id: number;
  name: string;
  categoryId: string;
  episodes: Episode[];
}
/** Guide time range around now, in whole days. */
export interface GuideWindow {
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

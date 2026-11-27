import type { DrmConfig } from '@elv/domain';
import type { ScanStats } from './stats';

/** What kind of content a playlist entry most likely is. */
export type KindHint = 'live' | 'movie' | 'episode';

/** Catch-up settings from `catchup`, `catchup-source` and `catchup-days`. */
export interface M3uCatchup {
  type: string;
  source?: string;
  days?: number;
}

/** One playlist entry; the string maps (`extra`, `kodiProps`, `headers.other`) have no prototype; the URL is kept as written (relative ones resolved when a base URL is given). */
export interface M3uEntry {
  name: string;
  url: string;
  /** Optional inline backup stream URLs split from `#http://` / `#https://` / `#rtmp://` / `#rtsp://` delimiters. */
  backupUrls?: string[];
  duration: number;
  tvgId?: string;
  tvgName?: string;
  tvgLogo?: string;
  chno?: number;
  shiftHours?: number;
  groups: string[];
  radio: boolean;
  catchup?: M3uCatchup;
  timeshiftDays?: number;
  recordDays?: number;
  headers: { userAgent?: string; referer?: string; other: Record<string, string> };
  kodiProps: Record<string, string>;
  /** Validated DRM configuration parsed from `#KODIPROP:inputstream.adaptive.license_*` (`#272`). */
  readonly drm?: DrmConfig;
  /** Optional validated provider IMDb title ID (`tvg-imdb` / `imdb-id` / `imdb_id`, `#511`). */
  providerImdbId?: string;
  /** Optional validated provider TMDB ID (`tmdb-id` / `tmdb_id`, `#511`). */
  providerTmdbId?: string;
  extra: Record<string, string>;
  kindHint: KindHint;
  nonHttp: boolean;
}

/** The `#EXTM3U` line: guide URLs and every other attribute. */
export interface M3uHeader {
  /** True when an `#EXTM3U` line was seen. */
  present: boolean;
  guideUrls: string[];
  attrs: Record<string, string>;
}

/** A group of entries; the final batch has `done: true` plus the header and statistics. */
export interface M3uBatch {
  entries: M3uEntry[];
  header?: M3uHeader;
  stats?: ScanStats;
  done: boolean;
}
